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
import { getAccount, listAccounts } from "@/features/accounting/accounts-service";
import { AccountForm } from "@/features/accounting/account-form";
import { ArchiveAccount } from "@/features/accounting/archive-account";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chart of accounts" };
export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!configured()) redirect("/sign-in");
  const identity = await auth().api.getSession({ headers: await headers() }); if (!identity) redirect("/sign-in");
  const query = await searchParams, org = uuid.safeParse(query.org), entity = uuid.safeParse(query.entity);
  const cursor = query.cursor === undefined ? undefined : uuid.safeParse(query.cursor), id = query.account === undefined ? undefined : uuid.safeParse(query.account);
  if (!org.success || !entity.success || (cursor && !cursor.success) || (id && !id.success)) notFound();
  const memberships = await sessionMemberships(identity.user.id), member = memberships.find(m => m.organizationId === org.data && m.allowedEntityIds.includes(entity.data));
  const permissions = permissionsFor(member?.roleIds ?? []); if (!permissions.has("accounts.read")) notFound();
  let data;
  try { data = await Promise.all([getEntity(identity.user.id, org.data, entity.data), listAccounts(identity.user.id, org.data, entity.data, 25, cursor?.data), id ? getAccount(identity.user.id, org.data, entity.data, id.data) : Promise.resolve(null)]); }
  catch (error) { if (error instanceof DomainError && [403, 404].includes(error.status)) notFound(); throw error; }
  const [company, page, selected] = data, base = `/workspace/accounts?org=${org.data}&entity=${entity.data}`, url = `/api/v1/orgs/${org.data}/entities/${entity.data}/accounts`;
  return <main className="mx-auto max-w-6xl px-5 py-8 sm:px-10"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-6"><Brand /><Button asChild variant="outline"><Link href="/workspace">Back to workspace</Link></Button></header><div className="py-8"><Badge variant="outline">Finance setup</Badge><h1 className="mt-4 text-3xl font-medium">Chart of accounts</h1><p className="mt-3 break-words text-muted-foreground">{company.name} · Account hierarchy, classifications and retained master versions.</p><p className="mt-2 text-sm text-muted-foreground">Balances, fiscal calendars, posting and financial statements are still under development. This screen does not certify reporting or tax policy.</p></div>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]"><section aria-label="Account register" className="min-w-0 space-y-4"><h2 className="text-xl font-medium">Account register</h2>{page.data.length ? <Table className="table-fixed"><TableHeader><TableRow><TableHead>Account</TableHead><TableHead className="w-24">Type / status</TableHead><TableHead className="w-16">View</TableHead></TableRow></TableHeader><TableBody>{page.data.map(account => <TableRow key={account.id}><TableCell className="whitespace-normal break-words"><span className="font-medium">{account.code}</span><p className="mt-1">{account.name}</p>{account.isControl ? <p className="mt-1 text-xs text-muted-foreground">Control: {account.controlType?.replaceAll("_", " ")}</p> : null}</TableCell><TableCell className="whitespace-normal text-xs">{account.type}<p className="mt-1">{account.active ? "Active" : "Archived"}</p></TableCell><TableCell><Link className="text-sm underline underline-offset-4" href={`${base}&account=${account.id}`} aria-label={`View account ${account.code}`}>View</Link></TableCell></TableRow>)}</TableBody></Table> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">No accounts on this page. A finance manager can create the company chart.</CardContent></Card>}
      <div className="flex flex-wrap gap-2">{page.nextCursor ? <Button asChild variant="outline"><Link href={`${base}&cursor=${page.nextCursor}`}>Next accounts</Link></Button> : null}{cursor ? <Button asChild variant="outline"><Link href={base}>First page</Link></Button> : null}</div>
      {selected ? <Card aria-label={`Account ${selected.code}`}><CardContent className="space-y-4 pt-6"><div className="flex flex-wrap justify-between gap-2"><h2 className="break-words text-xl font-medium">{selected.code} · {selected.name}</h2><Badge variant="outline">{selected.active ? "Active" : "Archived"}</Badge></div><p className="text-sm">{selected.type} · normal {selected.normalSide} · version {selected.version}</p><dl className="space-y-2 break-all text-xs text-muted-foreground"><dt>Account ID</dt><dd>{selected.id}</dd><dt>Parent account</dt><dd>{selected.parentId ? <Link className="underline" href={`${base}&account=${selected.parentId}`}>{selected.parentId}</Link> : "Root account"}</dd><dt>Control role</dt><dd>{selected.controlType ?? "Ordinary account"}</dd><dt>Statement section</dt><dd>{selected.reportMapping.statementSection}</dd><dt>Cash-flow classification</dt><dd>{selected.reportMapping.cashFlowCategory}</dd><dt>Updated</dt><dd>{selected.updatedAt}</dd>{selected.archivedAt ? <><dt>Archive reason</dt><dd>{selected.archiveReason}</dd><dt>Archived</dt><dd>{selected.archivedAt}</dd></> : null}</dl>{selected.active && permissions.has("accounts.update") ? <ArchiveAccount key={selected.version} account={selected} url={url} /> : null}</CardContent></Card> : null}
    </section><div className="space-y-4">{selected?.active && permissions.has("accounts.update") ? <AccountForm key={`${selected.id}-${selected.version}`} account={selected} url={url} parents={page.data} /> : permissions.has("accounts.create") ? <AccountForm key="create" url={url} parents={page.data} /> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">Read-only account access. A finance manager is required to create, edit or archive accounts.</CardContent></Card>}{selected ? <Button asChild variant="outline"><Link href={base}>Clear account selection</Link></Button> : null}</div></div>
  </main>;
}
