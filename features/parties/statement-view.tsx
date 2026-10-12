import Link from "next/link";
import type { z } from "zod";
import type { PartyStatement } from "./statement-contracts";
import { Button } from "@/components/ui/button";
const labels = { ar: "Receivables", ap: "Payables", customer_deposits: "Customer deposits", supplier_advances: "Supplier advances" };
function Amount({ value }: { value: string }) { return <span className="break-all font-mono tabular-nums">NPR {value}</span>; }
export function PartyStatementView({ statement, org, entity, limit }: { statement: z.infer<typeof PartyStatement>; org: string; entity: string; limit: number }) {
  const m = statement.metadata;
  const href = (cursor?: string) => `/workspace/party-statement?${new URLSearchParams({ org, entity, party: statement.party.id,
    fromDate: m.fromDate, asOfDate: m.asOfDate, knownAt: m.knownAt, limit: String(limit), ...(cursor ? { cursor } : {}) })}`;
  return <section aria-label="Statement results" className="min-w-0 space-y-6">
    <div className="space-y-2 rounded-lg border p-4 text-sm"><h2 className="break-words text-xl font-medium">{statement.party.name}</h2>
      <p>{statement.party.active ? "Active" : "Archived"} · retained party version {statement.party.version} at knowledge cutoff.</p>
      <p>From {m.fromDate} through {m.asOfDate} inclusive · NPR · {m.sourceCount} committed sources through as-of.</p>
      <p className="break-all text-xs text-muted-foreground">Knowledge cutoff {m.knownAt} · generated {m.generatedAt}</p>
      <p className="break-all text-xs text-muted-foreground">Party ledger watermark {m.ledgerWatermark ?? "No party source journals"} · {m.reportVersion}</p>
      <Button asChild variant="outline"><Link prefetch={false} href={href()}>Replay this statement cutoff</Link></Button>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">{statement.balances.map(b => <article key={b.book} aria-label={labels[b.book]} className="min-w-0 rounded-lg border p-4">
      <h3 className="text-lg font-medium">{labels[b.book]}</h3><dl className="mt-3 space-y-3 text-sm">{([
        ["Opening", b.opening], ["Increases", b.increases], ["Decreases", b.decreases], ["Closing", b.closing],
      ] as const).map(([label, amount]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd><Amount value={amount} /></dd></div>)}</dl>
      <p className="mt-3 text-xs text-muted-foreground">Reconciled to retained journal lines and the separate subledger.</p>
    </article>)}</div>
    <section aria-label="Outstanding ageing" className="space-y-3"><h3 className="text-xl font-medium">Outstanding ageing</h3>
      <p className="text-sm text-muted-foreground">Due on or after the as-of date is current. Deposits and advances are not netted.</p>
      <div className="grid gap-4 sm:grid-cols-2">{statement.ageing.map(a => <article key={a.side} className="min-w-0 rounded-lg border p-4"><h4 className="font-medium">{labels[a.side]}</h4>
        <dl className="mt-3 space-y-3 text-sm">{([
          ["Current", a.current], ["1–30 days overdue", a.days1To30], ["31–60 days overdue", a.days31To60],
          ["61–90 days overdue", a.days61To90], ["Over 90 days overdue", a.daysOver90],
        ] as const).map(([label, amount]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd><Amount value={amount} /></dd></div>)}</dl></article>)}</div>
    </section>
    <section aria-label="Statement activity" className="space-y-3"><h3 className="text-xl font-medium">Dated source activity</h3>
      {statement.activity.length ? <ol className="space-y-3">{statement.activity.map(a => <li key={a.sourceId} className="min-w-0 space-y-2 rounded-lg border p-4 text-sm">
        <p>{a.postingDate} · {a.kind.replaceAll("_", " ")} · source amount <Amount value={a.amount} /></p>
        <p className="break-all text-xs text-muted-foreground">Source {a.sourceId} · journal {a.journalId}</p>
        <p className="break-all text-xs text-muted-foreground">Document date {a.documentDate} · recorded {a.recordedAt}</p>
        <dl className="space-y-2">{Object.entries(a.effects).filter(([, amount]) => amount !== "0.00").map(([book, amount]) => <div key={book}><dt>{labels[book as keyof typeof labels]} change</dt><dd><Amount value={amount} /></dd></div>)}</dl>
        <p className="text-xs text-muted-foreground">Source detail workflow is not yet available. References are retained for traceability.</p>
      </li>)}</ol> : <p className="rounded-lg border p-4 text-sm">No committed source activity in this interval. Earlier balances remain included.</p>}
      <div className="flex flex-wrap gap-2">{statement.nextCursor ? <Button asChild variant="outline"><Link prefetch={false} href={href(statement.nextCursor)}>Next statement page</Link></Button> : null}
        <Button asChild variant="outline"><Link prefetch={false} href={href()}>First statement page</Link></Button></div>
    </section>
    <aside className="rounded-lg border p-4 text-sm"><h3 className="font-medium">Scope and limitations</h3><ul className="mt-3 list-disc space-y-2 pl-5">{statement.limitations.map(item => <li key={item}>{item}</li>)}</ul></aside>
  </section>;
}
