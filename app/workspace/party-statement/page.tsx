import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ZodError, type z } from "zod";
import { configured } from "@/db/client";
import { auth } from "@/features/identity/auth";
import { DomainError } from "@/domain/errors";
import { uuid } from "@/features/platform/contracts";
import { getEntity } from "@/features/platform/service";
import { getParty } from "@/features/parties/service";
import { parseStatementQuery } from "@/features/parties/statement-query";
import { readPartyStatement } from "@/features/parties/statement-service";
import type { PartyStatement } from "@/features/parties/statement-contracts";
import { PartyStatementView } from "@/features/parties/statement-view";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export const dynamic = "force-dynamic";
export const metadata = { title: "Party statement" };
export default async function PartyStatementPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!configured()) redirect("/sign-in");
  const identity = await auth().api.getSession({ headers: await headers() }); if (!identity) redirect("/sign-in");
  const params = await searchParams, org = uuid.safeParse(params.org), entity = uuid.safeParse(params.entity), party = uuid.safeParse(params.party);
  if (!org.success || !entity.success || !party.success) notFound();
  let scope;
  try { scope = await Promise.all([getEntity(identity.user.id, org.data, entity.data), getParty(identity.user.id, org.data, entity.data, party.data)]); }
  catch (error) { if (error instanceof DomainError && [403, 404].includes(error.status)) notFound(); throw error; }
  const [company, master] = scope;
  let statement: z.infer<typeof PartyStatement> | undefined, message = "", limit = 25;
  if (Object.keys(params).some(k => !["org", "entity", "party"].includes(k))) {
    try {
      const entries: [string, string][] = [];
      for (const [k, v] of Object.entries(params)) if (!["org", "entity", "party"].includes(k) && v !== undefined) {
        if (Array.isArray(v)) throw new DomainError("INVALID_STATEMENT_QUERY", "Each statement filter must occur once.", 400);
        if (k === "fromDate" && v === "") continue;
        entries.push([k, v]);
      }
      const query = parseStatementQuery(entries); limit = query.limit;
      statement = await readPartyStatement(identity.user.id, org.data, entity.data, party.data, query);
    } catch (error) {
      if (error instanceof DomainError && [403, 404].includes(error.status)) notFound();
      if (error instanceof DomainError) message = error.message;
      else if (error instanceof ZodError) message = `Check statement filters. ${error.issues[0]?.message ?? "Choose valid dates."}`;
      else throw error;
    }
  }
  const field = (key: string) => typeof params[key] === "string" ? params[key] as string : "";
  return <main className="mx-auto max-w-5xl px-5 py-8 sm:px-10"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-6"><Brand />
    <Button asChild variant="outline"><Link href={`/workspace/parties?${new URLSearchParams({ org: org.data, entity: entity.data, party: party.data })}`}>Back to party</Link></Button></header>
    <div className="py-8"><h1 className="text-3xl font-medium">Party statement</h1><p className="mt-3 break-words text-muted-foreground">{company.name} · Current party name: {master.name}</p><p className="mt-2 text-sm text-muted-foreground">Separate receivables, payables, deposits and advances from committed history. No net party balance.</p></div>
    <form method="get" action="/workspace/party-statement" aria-label="Statement filters" className="mb-8 grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
      <input type="hidden" name="org" value={org.data} /><input type="hidden" name="entity" value={entity.data} /><input type="hidden" name="party" value={party.data} />
      <div className="space-y-2"><Label htmlFor="statement-from">From date (optional)</Label><Input id="statement-from" name="fromDate" type="date" defaultValue={field("fromDate")} /><p className="text-xs text-muted-foreground">Blank includes history from 1900-01-01.</p></div>
      <div className="space-y-2"><Label htmlFor="statement-asof">As-of date (inclusive)</Label><Input id="statement-asof" name="asOfDate" type="date" defaultValue={field("asOfDate")} required /></div>
      <p className="text-xs text-muted-foreground sm:col-span-2">Run statement captures fresh knowledge. Replay preserves the displayed cutoff; changing dates starts a new statement.</p>
      <Button type="submit" className="w-fit">Run statement</Button>
    </form>
    {message ? <p role="alert" className="mb-6 rounded-lg border p-4 text-sm text-destructive">{message}</p> : null}
    {statement ? <PartyStatementView statement={statement} org={org.data} entity={entity.data} limit={limit} /> : !message ? <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">Choose an as-of date to read committed history. Unavailable data is not a zero balance.</p> : null}
  </main>;
}
