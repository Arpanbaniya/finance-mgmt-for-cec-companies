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
import { listJournals, getJournal, availableJournalActions } from "@/features/accounting/journal-service";
import { JournalForm, CancelJournal } from "@/features/accounting/journal-form";
import { JournalActions } from "@/features/accounting/journal-actions";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
export const dynamic = "force-dynamic";
export const metadata = { title: "Manual journal drafts" };
export default async function JournalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!configured()) redirect("/sign-in");
  const identity = await auth().api.getSession({ headers: await headers() }); if (!identity) redirect("/sign-in");
  const query = await searchParams, org = uuid.safeParse(query.org), entity = uuid.safeParse(query.entity);
  const cursor = query.cursor === undefined ? undefined : uuid.safeParse(query.cursor), id = query.journal === undefined ? undefined : uuid.safeParse(query.journal);
  if (!org.success || !entity.success || (cursor && !cursor.success) || (id && !id.success)) notFound();
  const memberships = await sessionMemberships(identity.user.id), member = memberships.find(m => m.organizationId === org.data && m.allowedEntityIds.includes(entity.data));
  const permissions = permissionsFor(member?.roleIds ?? []); if (!permissions.has("journals.read")) notFound();
  let data;
  try { data = await Promise.all([getEntity(identity.user.id, org.data, entity.data), listJournals(identity.user.id, org.data, entity.data, 25, cursor?.data), listAccounts(identity.user.id, org.data, entity.data, 100), id ? getJournal(identity.user.id, org.data, entity.data, id.data) : Promise.resolve(null)]); }
  catch (error) { if (error instanceof DomainError && [403, 404].includes(error.status)) notFound(); throw error; }
  const [company, page, accounts, selected] = data, screen = `/workspace/journals?org=${org.data}&entity=${entity.data}`, url = `/api/v1/orgs/${org.data}/entities/${entity.data}/journals`;
  const choices = accounts.data.filter(account => account.active && !account.isControl).map(({ id, code, name }) => ({ id, code, name }));
  const actions = selected ? availableJournalActions(selected, identity.user.id, permissions) : [];
  return <main className="mx-auto max-w-6xl px-5 py-8 sm:px-10"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-6"><Brand /><Button asChild variant="outline"><Link href="/workspace">Back to workspace</Link></Button></header>
    <div className="space-y-3 py-8"><Badge variant="outline">R1 · Journal workflow</Badge><h1 className="text-3xl font-medium">Manual journal drafts</h1><p className="break-words text-muted-foreground">{company.name} · NPR</p><p className="text-sm text-muted-foreground">Drafts have no financial effect. Submission freezes the saved content and approval policy; independent review is required before posting. Posting creates an immutable numbered journal. A dated reversal preserves the original and requires a fresh independently approved inverse journal.</p></div>
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]"><section aria-label="Journal register" className="min-w-0 space-y-4"><h2 className="text-xl font-medium">Journal register</h2>{page.data.length ? page.data.map(journal => <Card key={journal.id}><CardContent className="space-y-2 pt-6"><p className="break-words font-medium">{journal.description}</p><p className="text-sm">{journal.postingDate} · NPR {journal.debit} · {journal.status} · version {journal.version}</p><Link className="text-sm underline underline-offset-4" href={`${screen}&journal=${journal.id}`} aria-label={`View journal ${journal.description}`}>View journal</Link></CardContent></Card>) : <p className="rounded-lg border p-5 text-sm text-muted-foreground">No journals on this page.</p>}
      <div className="flex flex-wrap gap-2">{page.nextCursor ? <Button asChild variant="outline"><Link href={`${screen}&cursor=${page.nextCursor}`}>Next journals</Link></Button> : null}{cursor ? <Button asChild variant="outline"><Link href={screen}>First page</Link></Button> : null}</div>
      {selected ? <Card role="region" aria-label="Selected journal"><CardContent className="space-y-4 pt-6"><h2 className="break-words text-xl font-medium">{selected.description}</h2><Badge variant="outline">{selected.status}</Badge><p className="text-sm">Version {selected.version} · Posting {selected.postingDate} · Document {selected.documentDate}</p><p className="text-sm">Debits NPR {selected.debit} · Credits NPR {selected.credit}</p><dl className="space-y-2 break-all text-xs text-muted-foreground"><dt>Source ID</dt><dd>{selected.id}</dd><dt>Created by</dt><dd>{selected.createdBy}</dd><dt>Updated</dt><dd>{selected.updatedAt}</dd></dl><ol className="space-y-3">{selected.lines.map((line, i) => <li key={i} className="break-all rounded-md border p-3 text-sm">Line {i + 1} · Account {line.accountId} · master version {line.accountVersion}<p className="mt-1">Debit {line.debit} · Credit {line.credit}</p>{line.dimensions.branchId ? <p className="mt-1">Branch {line.dimensions.branchId}</p> : null}</li>)}</ol>{selected.number ? <p className="text-sm font-medium">Posted journal {selected.number}</p> : null}
      {selected.review ? <section aria-label="Frozen journal review" className="space-y-3 border-t pt-4"><h3 className="font-medium">Frozen journal review</h3><p className="text-sm">Submission {selected.review.sourceVersion} · Independent approvals {selected.review.validApprovals} / {selected.review.requiredApprovals}</p><dl className="space-y-2 break-all text-xs text-muted-foreground"><dt>Content hash</dt><dd>{selected.review.contentHash}</dd><dt>Policy</dt><dd>{selected.review.policyId} · version {selected.review.policyVersion}</dd></dl>{!selected.review.snapshotValid ? <p role="status" className="text-sm">Snapshot invalidated. Edit and resubmit before further approval or posting.</p> : null}<ul className="space-y-2">{selected.review.approvals.map(approval => <li key={approval.actorId} className="break-words text-sm"><p className="break-all">Reviewer {approval.actorId} · {approval.eligible ? "Current authority" : "Authority revoked"}</p><p>{approval.reason}</p></li>)}</ul></section> : null}
      {selected.transitionReason ? <p className="break-words text-sm">Latest transition reason: {selected.transitionReason}</p> : null}
      {selected.reversalOfSourceId ? <p className="text-sm">Exact inverse of <Link className="underline" href={`${screen}&journal=${selected.reversalOfSourceId}`}>original posted journal</Link>. Dates and inverse lines are fixed; fresh independent approval is required.</p> : null}
      {selected.reversalRequestId ? <p className="text-sm">{selected.reversalJournalId ? "Reversed by" : "Pending reversal"}: <Link className="underline" href={`${screen}&journal=${selected.reversalRequestId}`}>Open linked reversal</Link>{selected.reversalJournalId ? ` · Journal ${selected.reversalJournalId}` : ""}. Original posting remains unchanged.</p> : null}
      {actions.length ? <JournalActions key={`actions-${selected.id}-${selected.version}-${selected.reversalRequestId ?? "none"}`} id={selected.id} version={selected.version} actions={actions} url={url} screen={screen} originalDate={selected.postingDate} /> : null}
      {selected.cancelReason ? <p className="break-words text-sm">Cancellation reason: {selected.cancelReason}</p> : null}{["draft", "submitted", "approved"].includes(selected.status) && permissions.has("journals.update") ? <CancelJournal key={`${selected.id}-${selected.version}`} journal={selected} url={url} /> : null}</CardContent></Card> : null}
    </section><div className="min-w-0 space-y-4">{selected && ["draft", "submitted", "approved"].includes(selected.status) && permissions.has("journals.update") ? <JournalForm key={`${selected.id}-${selected.version}`} journal={selected} accounts={choices} url={url} screen={screen} /> : !selected && permissions.has("journals.create") ? <JournalForm accounts={choices} url={url} screen={screen} /> : <p className="rounded-lg border p-5 text-sm text-muted-foreground">{permissions.has("journals.update") ? selected && ["posted", "reversed"].includes(selected.status) ? "Posted journals are immutable. Use the linked dated reversal workflow." : "Cancelled drafts are immutable." : "Read-only journal access."}</p>}
      <p className="text-xs text-muted-foreground">The picker contains active ordinary accounts from the first 100 chart entries.{accounts.nextCursor ? " More chart entries exist; later account-search support remains pending." : ""} Other dimensions are unavailable until their scoped masters are implemented.</p>
      {selected ? <Button asChild variant="outline"><Link href={screen}>Clear journal selection</Link></Button> : null}
    </div></div>
  </main>;
}
