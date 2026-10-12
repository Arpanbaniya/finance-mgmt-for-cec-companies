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
import { getParty, listParties } from "@/features/parties/service";
import { PartyForm, ArchiveParty } from "@/features/parties/party-form";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customers and suppliers" };
export default async function PartiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!configured()) redirect("/sign-in");
  const identity = await auth().api.getSession({ headers: await headers() }); if (!identity) redirect("/sign-in");
  const query = await searchParams, org = uuid.safeParse(query.org), entity = uuid.safeParse(query.entity);
  const cursor = query.cursor === undefined ? undefined : uuid.safeParse(query.cursor), id = query.party === undefined ? undefined : uuid.safeParse(query.party);
  if (!org.success || !entity.success || (cursor && !cursor.success) || (id && !id.success)) notFound();
  const memberships = await sessionMemberships(identity.user.id), member = memberships.find(m => m.organizationId === org.data && m.allowedEntityIds.includes(entity.data));
  const permissions = permissionsFor(member?.roleIds ?? []); if (!permissions.has("parties.read")) notFound();
  let data;
  try { data = await Promise.all([getEntity(identity.user.id, org.data, entity.data), listParties(identity.user.id, org.data, entity.data, 25, cursor?.data), id ? getParty(identity.user.id, org.data, entity.data, id.data) : Promise.resolve(null)]); }
  catch (error) { if (error instanceof DomainError && [403, 404].includes(error.status)) notFound(); throw error; }
  const [company, page, selected] = data, base = `/workspace/parties?org=${org.data}&entity=${entity.data}`, url = `/api/v1/orgs/${org.data}/entities/${entity.data}/parties`;
  const editor = selected ? { id: selected.id, version: selected.version, name: selected.name, roleSet: selected.roleSet, contact: selected.contact,
    address: selected.address, taxIdentifier: selected.taxIdentifier, paymentTermsDays: selected.paymentTermsDays, creditLimit: selected.creditLimit } : undefined;
  return <main className="mx-auto max-w-6xl px-5 py-8 sm:px-10"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-6"><Brand /><Button asChild variant="outline"><Link href="/workspace">Back to workspace</Link></Button></header><div className="py-8"><Badge variant="outline">Finance setup</Badge><h1 className="mt-4 text-3xl font-medium">Customers and suppliers</h1><p className="mt-3 break-words text-muted-foreground">{company.name} · One party can be both a customer and a supplier.</p><p className="mt-2 text-sm text-muted-foreground">Manage future payment terms and contact details without changing posted history. Select a party to read its dated statement.</p></div>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]"><section aria-label="Party register" className="min-w-0 space-y-4"><h2 className="text-xl font-medium">Party register</h2>{page.data.length ? <Table className="table-fixed"><TableHeader><TableRow><TableHead>Party</TableHead><TableHead className="w-28">Roles / status</TableHead><TableHead className="w-16">View</TableHead></TableRow></TableHeader><TableBody>{page.data.map(party => <TableRow key={party.id}><TableCell className="whitespace-normal break-words"><span className="font-medium">{party.name}</span><p className="mt-1 text-xs text-muted-foreground">Terms: {party.paymentTermsDays} days</p></TableCell><TableCell className="whitespace-normal text-xs">{party.roleSet.join(" / ")}<p className="mt-1">{party.active ? "Active" : "Archived"}</p></TableCell><TableCell><Link className="text-sm underline underline-offset-4" href={`${base}&party=${party.id}`} aria-label={`View party ${party.name}`}>View</Link></TableCell></TableRow>)}</TableBody></Table> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">No parties on this page. A finance manager can create customer and supplier records.</CardContent></Card>}
      <div className="flex flex-wrap gap-2">{page.nextCursor ? <Button asChild variant="outline"><Link href={`${base}&cursor=${page.nextCursor}`}>Next parties</Link></Button> : null}{cursor ? <Button asChild variant="outline"><Link href={base}>First page</Link></Button> : null}</div>
      {selected ? <Card aria-label={`Party ${selected.name}`}><CardContent className="space-y-4 pt-6"><div className="flex flex-wrap justify-between gap-2"><h2 className="break-words text-xl font-medium">{selected.name}</h2><Badge variant="outline">{selected.active ? "Active" : "Archived"}</Badge></div><p className="text-sm">{selected.roleSet.join(" / ")} · version {selected.version}</p><dl className="space-y-2 break-words text-sm"><dt>Contact</dt><dd>{selected.contact ?? "Not configured"}</dd><dt>Address</dt><dd>{selected.address ?? "Not configured"}</dd><dt>Tax identifier</dt><dd>{selected.taxIdentifier ?? "Not configured"}</dd><dt>Payment terms</dt><dd>{selected.paymentTermsDays} days</dd><dt>Customer credit limit</dt><dd>{selected.creditLimit === null ? "Not configured" : `NPR ${selected.creditLimit}`}</dd><dt>Updated</dt><dd>{selected.updatedAt}</dd>{selected.archivedAt ? <><dt>Archive reason</dt><dd>{selected.archiveReason}</dd><dt>Archived</dt><dd>{selected.archivedAt}</dd></> : null}</dl>{selected.active && permissions.has("parties.update") ? <ArchiveParty key={selected.version} party={{ id: selected.id, version: selected.version, name: selected.name }} url={url} /> : null}</CardContent></Card> : null}
    </section><div className="space-y-4">{selected ? <Button asChild variant="outline"><Link prefetch={false} href={`/workspace/party-statement?${new URLSearchParams({ org: org.data, entity: entity.data, party: selected.id })}`}>View party statement</Link></Button> : null}{selected?.active && permissions.has("parties.update") ? <PartyForm key={`${selected.id}-${selected.version}`} party={editor} url={url} /> : permissions.has("parties.create") ? <PartyForm key={`create-${selected?.id ?? "new"}`} url={url} /> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">Read-only party access. A finance manager is required to create, edit or archive parties.</CardContent></Card>}{selected ? <Button asChild variant="outline"><Link href={base}>Clear party selection</Link></Button> : null}</div></div>
  </main>;
}
