import Link from "next/link";
import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { configured } from "@/db/client";
import { auth } from "@/features/identity/auth";
import { sessionMemberships } from "@/features/identity/session";
import { permissionsFor } from "@/domain/permissions";
import { DomainError } from "@/domain/errors";
import { previewTax } from "@/domain/tax-rules";
import { uuid } from "@/features/platform/contracts";
import { getEntity } from "@/features/platform/service";
import { getRuleDraft, listRuleDrafts } from "@/features/rules/service";
import { RuleForm } from "@/features/rules/rule-form";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
export const dynamic = "force-dynamic";
export const metadata = { title: "Rule drafts" };
export default async function RulesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!configured()) redirect("/sign-in");
  const identity = await auth().api.getSession({ headers: await headers() }); if (!identity) redirect("/sign-in");
  const query = await searchParams, org = uuid.safeParse(query.org), entity = uuid.safeParse(query.entity), cursor = query.cursor === undefined ? undefined : uuid.safeParse(query.cursor), id = query.rule === undefined ? undefined : uuid.safeParse(query.rule);
  if (!org.success || !entity.success || (cursor && !cursor.success) || (id && !id.success)) notFound();
  const memberships = await sessionMemberships(identity.user.id), member = memberships.find(m => m.organizationId === org.data && m.allowedEntityIds.includes(entity.data)), permissions = permissionsFor(member?.roleIds ?? []);
  if (!permissions.has("rules.read")) notFound();
  let data;
  try { data = await Promise.all([getEntity(identity.user.id, org.data, entity.data), listRuleDrafts(identity.user.id, org.data, entity.data, 25, cursor?.data), id ? getRuleDraft(identity.user.id, org.data, entity.data, id.data) : Promise.resolve(null)]); }
  catch (error) { if (error instanceof DomainError && [403, 404].includes(error.status)) notFound(); throw error; }
  const [company, page, selected] = data, base = `/workspace/rules?org=${org.data}&entity=${entity.data}`, url = `/api/v1/orgs/${org.data}/entities/${entity.data}/rule-versions`, preview = selected ? previewTax(selected.definition, "100.00") : null;
  return <main className="mx-auto max-w-6xl px-5 py-8 sm:px-10"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-6"><Brand /><Button asChild variant="outline"><Link href="/workspace">Back to workspace</Link></Button></header>
    <div className="py-8"><Badge variant="outline">Unverified rules</Badge><h1 className="mt-4 text-3xl font-medium">Rule drafts</h1><p className="mt-3 break-words text-muted-foreground">{company.name} · NPR · Nepal jurisdiction</p><p className="mt-2 text-sm text-muted-foreground">Record immutable typed definitions and source references. Review, activation and retirement are not available yet; these drafts cannot authorize tax posting.</p></div>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]"><section aria-label="Rule register" className="min-w-0 space-y-4"><h2 className="text-xl font-medium">Rule register</h2>{page.data.length ? <ul className="space-y-3">{page.data.map(rule => <li key={rule.id} className="rounded-lg border p-4"><div className="flex flex-wrap justify-between gap-2"><Link prefetch={false} className="break-all font-medium underline underline-offset-4" href={`${base}&rule=${rule.id}`} aria-label={`View rule ${rule.applicability.taxCode}`}>{rule.applicability.taxCode}</Link><Badge variant="outline">Draft · unverified</Badge></div><p className="mt-2 text-sm">{rule.kind === "sales_tax" ? "Sales tax" : "Purchase tax"} · {rule.demoOnly ? "Synthetic demo only — not law" : "Review required — not verified"}</p><p className="mt-1 text-xs text-muted-foreground">{rule.effectiveFrom} to {rule.effectiveTo ?? "no end date"} (exclusive end)</p></li>)}</ul> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">No rule drafts on this page.</CardContent></Card>}
      <div className="flex flex-wrap gap-2">{page.nextCursor ? <Button asChild variant="outline"><Link prefetch={false} href={`${base}&cursor=${page.nextCursor}`}>Next rules</Link></Button> : null}{cursor ? <Button asChild variant="outline"><Link href={base}>First page</Link></Button> : null}</div>
      {selected && preview ? <Card aria-label="Selected rule draft"><CardContent className="min-w-0 space-y-4 pt-6"><h2 className="break-all text-xl font-medium">{selected.applicability.taxCode}</h2><Badge variant="outline">{selected.demoOnly ? "Synthetic demo only — not law" : "Review required — not verified"}</Badge>
        <dl className="space-y-2 break-words text-sm"><dt>Status</dt><dd>Draft · version 1 · no posting authority</dd><dt>Calculation</dt><dd>{selected.definition.method === "percentage" ? `${selected.definition.rate}% · tax ${selected.definition.basis} · input credit ${selected.definition.inputCredit.replaceAll("_", " ")}` : selected.definition.treatment.replaceAll("_", " ")}</dd><dt>Evaluator</dt><dd>{selected.evaluatorVersion} · half-up rounding per line</dd><dt>Effective interval (AD)</dt><dd>{selected.effectiveFrom} to {selected.effectiveTo ?? "no end date"} (exclusive end)</dd><dt>Created</dt><dd>{selected.createdAt}</dd><dt>Definition fingerprint</dt><dd className="break-all font-mono text-xs">{selected.contentHash}</dd></dl>
        <section aria-label="Arithmetic example"><h3 className="font-medium">Arithmetic example · not posting authority</h3><p className="mt-2 text-sm">For a hypothetical NPR 100.00 {selected.definition.method === "percentage" && selected.definition.basis === "inclusive" ? "gross" : "net"} line: net {preview.net}, tax {preview.tax}, gross {preview.gross}, eligible input credit {preview.inputTaxCredit}.</p></section>
        <section aria-label="Unverified source references"><h3 className="font-medium">Unverified source references</h3><ul className="mt-2 space-y-3 text-sm">{selected.sourceReferences.map(source => <li key={`${source.url}-${source.section}-${source.sha256}`} className="min-w-0 rounded border p-3"><p className="break-words font-medium">{source.title}</p><p className="break-words">Section: {source.section}</p><a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline underline-offset-4">{source.url}</a><p className="mt-2 break-all font-mono text-xs">SHA-256: {source.sha256}</p></li>)}</ul><p className="mt-2 text-xs text-muted-foreground">Captured metadata only. No source content has been verified by the application.</p></section>
      </CardContent></Card> : null}
    </section><div className="space-y-4">{permissions.has("rules.create") ? <RuleForm key={selected?.id ?? "new"} url={url} base={base} demoAllowed={company.reportingProfile === "demo_accrual" && company.policyStatus === "demo"} /> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">Read-only rule access. A finance manager is required to create drafts.</CardContent></Card>}{selected ? <Button asChild variant="outline"><Link href={base}>Clear rule selection</Link></Button> : null}</div></div>
  </main>;
}
