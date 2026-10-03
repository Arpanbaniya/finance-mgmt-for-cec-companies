import Link from "next/link";
import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { configured } from "@/db/client";
import { auth } from "@/features/identity/auth";
import { sessionMemberships } from "@/features/identity/session";
import { permissionsFor } from "@/domain/permissions";
import { DomainError } from "@/domain/errors";
import { uuid } from "@/features/platform/contracts";
import { getEntity } from "@/features/platform/service";
import { listAccounts } from "@/features/accounting/accounts-service";
import { listFiscalYears, getAccountMappings } from "@/features/accounting/setup-service";
import { FinanceSetupForms } from "@/features/accounting/setup-forms";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
export const dynamic = "force-dynamic";
export const metadata = { title: "Finance setup" };
export default async function FinanceSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!configured()) redirect("/sign-in"); const identity = await auth().api.getSession({ headers: await headers() }); if (!identity) redirect("/sign-in");
  const query = await searchParams, org = uuid.safeParse(query.org), entity = uuid.safeParse(query.entity), cursor = query.cursor === undefined ? undefined : uuid.safeParse(query.cursor);
  if (!org.success || !entity.success || (cursor && !cursor.success)) notFound();
  const members = await sessionMemberships(identity.user.id), member = members.find(m => m.organizationId === org.data && m.allowedEntityIds.includes(entity.data));
  const permissions = permissionsFor(member?.roleIds ?? []); if (!permissions.has("periods.read") || !permissions.has("settings.read")) notFound();
  let data; try { data = await Promise.all([getEntity(identity.user.id, org.data, entity.data), listFiscalYears(identity.user.id, org.data, entity.data, 10, cursor?.data), getAccountMappings(identity.user.id, org.data, entity.data), permissions.has("settings.update") ? listAccounts(identity.user.id, org.data, entity.data, 100) : Promise.resolve({ data: [], nextCursor: null })]); }
  catch (error) { if (error instanceof DomainError && [403,404].includes(error.status)) notFound(); throw error; }
  const [company, years, mappings, accounts] = data, base = `/api/v1/orgs/${org.data}/entities/${entity.data}`, screen = `/workspace/finance-setup?org=${org.data}&entity=${entity.data}`;
  return <main className="mx-auto max-w-6xl px-5 py-8 sm:px-10"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-6"><Brand /><Button asChild variant="outline"><Link href="/workspace">Back to workspace</Link></Button></header><div className="space-y-3 py-8"><Badge variant="outline">Finance setup</Badge><h1 className="text-3xl font-medium">Fiscal calendars and mappings</h1><p className="break-words text-muted-foreground">{company.name} · Dates use the AD calendar. Period end dates are exclusive.</p><p className="text-sm text-muted-foreground">Posting and period closing are under development. Account mappings do not activate tax rules.</p><Button asChild variant="outline"><Link href={`/workspace/accounts?org=${org.data}&entity=${entity.data}`}>Chart of accounts</Link></Button></div>
    <section aria-label="Fiscal calendars" className="space-y-4"><h2 className="text-xl font-medium">Fiscal calendars</h2>{years.data.length ? years.data.map(year => <Card key={year.id} aria-label={`Fiscal year ${year.fiscalYearLabel}`}><CardContent className="space-y-3 pt-6"><h3 className="break-words text-lg font-medium">{year.fiscalYearLabel}</h3><p className="text-sm">{year.startDate} to {year.endDateExclusive} exclusive · {year.periods.length} periods</p><p className="break-all text-xs text-muted-foreground">Retained earnings account {year.retainedEarningsAccountId} · master version {year.retainedEarningsAccountVersion}</p><ol className="space-y-2 text-sm">{year.periods.map(period => <li key={period.id}>Period {period.ordinal}: {period.startDate} to {period.endDateExclusive} exclusive · {period.state}</li>)}</ol><details className="text-sm"><summary className="cursor-pointer">Document numbering series</summary><p className="mt-2 text-xs text-muted-foreground">Numbers are assigned atomically when posting. A committed source number is retained; cancellation cannot make it reusable.</p><ul className="mt-3 grid gap-2 sm:grid-cols-2">{year.documentSeries.map(series => <li key={series.documentType}>{series.documentType.replaceAll("_", " ")} · next {series.nextNumber}</li>)}</ul></details></CardContent></Card>) : <p className="rounded-lg border p-5 text-sm">No fiscal calendar has been configured.</p>}<div className="flex flex-wrap gap-2">{years.nextCursor ? <Button asChild variant="outline"><Link href={`${screen}&cursor=${years.nextCursor}`}>Next fiscal years</Link></Button> : null}{cursor ? <Button asChild variant="outline"><Link href={screen}>First fiscal years</Link></Button> : null}</div></section>
    <section aria-label="Saved account mappings" className="my-8 space-y-3"><h2 className="text-xl font-medium">Saved account mappings</h2><p className="text-sm">As of {mappings.asOfDate}: {mappings.current ? `version ${mappings.current.version}, effective ${mappings.current.effectiveFrom}` : "No effective mapping"}.</p>{mappings.latest ? <Card><CardContent className="space-y-3 pt-6"><h3 className="font-medium">Latest version {mappings.latest.version} · effective {mappings.latest.effectiveFrom}</h3><p className="break-words text-sm">{mappings.latest.reason}</p><dl className="grid gap-3 sm:grid-cols-2">{mappings.latest.mappings.map(entry => <div key={entry.purpose}><dt className="text-sm">{entry.purpose.replaceAll("_", " ")}</dt><dd className="break-all text-xs text-muted-foreground">{entry.accountId} · master version {entry.accountVersion}</dd></div>)}</dl></CardContent></Card> : <p className="rounded-lg border p-5 text-sm">Set up account-purpose mappings before posting financial sources.</p>}</section>
    {permissions.has("periods.create") && permissions.has("settings.update") ? <FinanceSetupForms base={base} initialAccounts={accounts.data.map(({ id, code, name, type, controlType, active }) => ({ id, code, name, type, controlType, active }))} nextCursor={accounts.nextCursor} mappings={{ version: mappings.version, selections: mappings.latest?.mappings.map(({ purpose, accountId }) => ({ purpose, accountId })) ?? [] }} /> : <p className="rounded-lg border p-5 text-sm">Read-only finance setup. A finance manager is required to configure calendars and mappings.</p>}
  </main>;
}
