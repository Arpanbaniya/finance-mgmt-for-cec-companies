import Link from "next/link";
import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { ZodError } from "zod";
import { configured } from "@/db/client";
import { auth } from "@/features/identity/auth";
import { uuid } from "@/features/platform/contracts";
import { DomainError } from "@/domain/errors";
import { getEntity } from "@/features/platform/service";
import { readReport, reportAccess } from "@/features/reporting/report-service";
import { parseReportQuery } from "@/features/reporting/report-query";
import { availableReports, type ReportResultValue } from "@/features/reporting/report-contracts";
import { ReportView, reportLabels } from "@/features/reporting/report-view";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export const dynamic = "force-dynamic";
export const metadata = { title: "Financial reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!configured()) redirect("/sign-in");
  const identity = await auth().api.getSession({ headers: await headers() }); if (!identity) redirect("/sign-in");
  const params = await searchParams, org = uuid.safeParse(params.org), entity = uuid.safeParse(params.entity);
  if (!org.success || !entity.success || Array.isArray(params.reportType)) notFound();
  let scope;
  try { scope = await Promise.all([getEntity(identity.user.id, org.data, entity.data), reportAccess(identity.user.id, org.data, entity.data)]); }
  catch (error) { if (error instanceof DomainError && [403, 404].includes(error.status)) notFound(); throw error; }
  const [company, finance] = scope, reportType = typeof params.reportType === "string" ? params.reportType : "profit-loss";
  if (!(availableReports as readonly string[]).includes(reportType) || (!finance && ["trial-balance", "general-ledger"].includes(reportType))) notFound();
  const selected = reportType as typeof availableReports[number], base = `/workspace/reports?${new URLSearchParams({ org: org.data, entity: entity.data })}`;
  let report: ReportResultValue | undefined, errorMessage = "";
  if (Object.keys(params).some(key => !["org", "entity", "reportType"].includes(key))) {
    try {
      const entries: [string, string][] = [];
      for (const [key, value] of Object.entries(params)) if (!["org", "entity", "reportType"].includes(key) && value !== undefined) {
        if (Array.isArray(value)) throw new DomainError("INVALID_REPORT_QUERY", "Each report filter must occur once.", 400);
        entries.push([key, value]);
      }
      report = await readReport(identity.user.id, org.data, entity.data, parseReportQuery(reportType, entries));
    } catch (error) {
      if (error instanceof DomainError && [403, 404].includes(error.status)) notFound();
      if (error instanceof DomainError) errorMessage = error.message;
      else if (error instanceof ZodError) errorMessage = `Check report filters. ${error.issues[0]?.message ?? "Choose valid dates."}`;
      else throw error;
    }
  }
  const field = (name: string) => typeof params[name] === "string" ? params[name] as string : "";
  return <main className="mx-auto max-w-5xl px-5 py-8 sm:px-10"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-6"><Brand /><Button asChild variant="outline"><Link href="/workspace">Back to workspace</Link></Button></header>
    <div className="py-8"><h1 className="text-3xl font-medium">Financial reports</h1><p className="mt-3 break-words text-muted-foreground">{company.name} · Posted books, retained mappings and exact NPR amounts.</p><p className="mt-2 text-sm text-muted-foreground">{finance ? "Finance ledger access" : "Owner aggregate access only"}. Not a statutory filing or approved close snapshot.</p></div>
    <nav aria-label="Report selection" className="mb-6 flex flex-wrap gap-2">{availableReports.filter(type => finance || !["trial-balance", "general-ledger"].includes(type)).map(type => <Button key={type} asChild variant={type === selected ? "default" : "outline"}><Link prefetch={false} href={`${base}&reportType=${type}`}>{reportLabels[type]}</Link></Button>)}</nav>
    <form action="/workspace/reports" method="get" aria-label="Report filters" className="mb-8 grid gap-4 rounded-lg border p-4 sm:grid-cols-2"><input type="hidden" name="org" value={org.data} /><input type="hidden" name="entity" value={entity.data} /><input type="hidden" name="reportType" value={selected} />
      {selected === "balance-sheet" ? <div className="space-y-2"><Label htmlFor="report-asof">As-of date (inclusive)</Label><Input id="report-asof" name="asOfDate" type="date" defaultValue={field("asOfDate")} required /></div> : <><div className="space-y-2"><Label htmlFor="report-from">From date</Label><Input id="report-from" name="fromDate" type="date" defaultValue={field("fromDate")} required /></div><div className="space-y-2"><Label htmlFor="report-to">End date (exclusive)</Label><Input id="report-to" name="toDateExclusive" type="date" defaultValue={field("toDateExclusive")} required /></div></>}
      {selected === "general-ledger" ? <div className="space-y-2 sm:col-span-2"><Label htmlFor="report-account">Account ID</Label><Input id="report-account" name="accountId" defaultValue={field("accountId")} required maxLength={36} /><p className="text-xs text-muted-foreground">Choose a General ledger link on the trial balance to retain its account and cutoff.</p></div> : null}
      {report ? <p className="text-xs text-muted-foreground sm:col-span-2">Run report captures fresh knowledge. Replay this cutoff keeps the displayed history; changing filters starts a new report.</p> : null}<Button type="submit" className="w-fit">Run report</Button>
    </form>
    {errorMessage ? <p role="alert" className="mb-6 rounded-lg border p-4 text-sm text-destructive">{errorMessage}</p> : null}
    {report ? <ReportView report={report} org={org.data} entity={entity.data} /> : !errorMessage ? <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">Choose dates and run a report. No unposted drafts or placeholder balances are included.</p> : null}
  </main>;
}
