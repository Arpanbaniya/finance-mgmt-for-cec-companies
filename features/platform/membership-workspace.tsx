"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import { roleGrants, type Role } from "@/domain/permissions";
import { MembershipChange, type MembershipDTO, type EntityDTO } from "./contracts";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";

type Member = z.infer<typeof MembershipDTO>;
type Entity = z.infer<typeof EntityDTO>;
const roleLabels: Record<Role, string> = {
  organization_admin: "Organization administrator", owner: "Owner", finance_manager: "Finance manager",
  accountant: "Accountant", auditor: "Auditor", site_supervisor: "Site supervisor",
};
function label(role: string) { return role in roleLabels ? roleLabels[role as Role] : role; }

export function MembershipWorkspace({ organizationId, currentUserId, members, nextCursor, entities, entityChoicesTruncated, paginated }: {
  organizationId: string; currentUserId: string; members: Member[]; nextCursor: string | null; entities: Entity[]; entityChoicesTruncated: boolean; paginated: boolean;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null), [message, setMessage] = useState("");
  const selected = members.find(m => m.id === selectedId);
  return <main className="mx-auto max-w-6xl px-5 py-8 sm:px-10">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-6"><Brand /><Button variant="outline" asChild><Link href="/workspace">Company workspace</Link></Button></header>
    <div className="py-10"><Badge variant="outline">R1 · Access management</Badge><h1 className="mt-4 text-3xl font-medium">Membership administration</h1><p className="mt-3 max-w-2xl text-muted-foreground">Grant access to existing verified identities. Roles and legal-entity grants are checked on every authorized request.</p></div>
    {message ? <p role="status" className="mb-6 rounded-lg border p-4 text-sm">{message}</p> : null}
    <div className="grid gap-7 lg:grid-cols-[1fr_420px]">
      <section aria-label="Organization memberships" className="min-w-0"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-medium">Organization memberships</h2><Button variant="outline" onClick={() => { setSelectedId(null); setMessage(""); }}>Add membership</Button></div>
        <div className="space-y-3">{members.map(member => <Card key={member.id}><CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="break-all font-mono text-sm">{member.userId}</p><p className="mt-1 text-xs text-muted-foreground">Version {member.version}{member.userId === currentUserId ? " · Your membership" : ""}</p></div><Badge variant={member.active ? "secondary" : "outline"}>{member.active ? "Active" : "Revoked"}</Badge></div>
          <div className="flex flex-wrap gap-2">{member.roleIds.map(role => <Badge key={role} variant="outline">{label(role)}</Badge>)}</div>
          <p className="text-sm text-muted-foreground">{member.allowedEntityIds.length} legal-entity grants · {member.siteIds.length} site grants</p>
          <Button variant="outline" disabled={member.userId === currentUserId} aria-label={`Edit membership ${member.userId}`} onClick={() => { setSelectedId(member.id); setMessage(""); }}>Edit access</Button>
          {member.userId === currentUserId ? <p className="text-xs text-muted-foreground">Another administrator must change your membership.</p> : null}
        </CardContent></Card>)}</div>
        {!members.length ? <p className="rounded-lg border p-5 text-sm">No memberships on this page.</p> : null}
        <nav aria-label="Membership pages" className="mt-5 flex flex-wrap gap-3">{paginated ? <Button variant="outline" asChild><Link href={`/workspace/members?org=${organizationId}`}>First page</Link></Button> : null}{nextCursor ? <Button variant="outline" asChild><Link href={`/workspace/members?org=${organizationId}&cursor=${nextCursor}`}>Next page</Link></Button> : null}</nav>
      </section>
      <MembershipForm key={selected ? `${selected.id}-${selected.version}` : "new"} organizationId={organizationId} member={selected} entities={entities} entityChoicesTruncated={entityChoicesTruncated} onSaved={() => { setSelectedId(null); setMessage("Membership saved. Access checks will use the new grants on the next request."); router.refresh(); }} onReload={() => router.refresh()} />
    </div>
  </main>;
}

function MembershipForm({ organizationId, member, entities, entityChoicesTruncated, onSaved, onReload }: {
  organizationId: string; member?: Member; entities: Entity[]; entityChoicesTruncated: boolean; onSaved: () => void; onReload: () => void;
}) {
  const [userId, setUserId] = useState(member?.userId ?? "");
  const [roles, setRoles] = useState<string[]>(member?.roleIds ?? ["accountant"]);
  const [entityIds, setEntityIds] = useState<string[]>(member?.allowedEntityIds ?? []);
  const [active, setActive] = useState(member?.active ?? true);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [stale, setStale] = useState(false), [confirm, setConfirm] = useState(false);
  const requestKey = useRef<string | null>(null);
  const retained = entityIds.filter(id => !entities.some(e => e.id === id));
  function toggle(values: string[], id: string, checked: boolean) { return checked ? [...values, id] : values.filter(v => v !== id); }
  async function save() {
    if (pending || stale) return;
    const parsed = MembershipChange.safeParse({ userId: userId.trim(), roleIds: roles, allowedEntityIds: entityIds, siteIds: member?.siteIds ?? [], active });
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join(" ")); return; }
    setPending(true); setError("");
    try {
      requestKey.current ??= crypto.randomUUID();
      const response = await fetch(`/api/v1/orgs/${organizationId}/memberships${member ? `/${member.id}` : ""}`, {
        method: member ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...(member ? { "If-Match": `"${member.version}"` } : { "Idempotency-Key": requestKey.current }) },
        body: JSON.stringify(parsed.data),
      });
      const payload = await response.json();
      if (!response.ok) { setStale(response.status === 412); setError(payload.error?.message ?? "Could not save the membership."); return; }
      if (!member) { setUserId(""); setRoles(["accountant"]); setEntityIds([]); setActive(true); }
      requestKey.current = null; onSaved();
    } catch { setError("Could not reach the server. Retry with the same details when connected."); } finally { setPending(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (member?.active && !active) setConfirm(true); else void save(); }
  return <Card className="min-w-0 self-start"><CardContent className="pt-6"><h2 className="text-lg font-medium">{member ? "Edit membership" : "Add verified identity"}</h2>
    <p className="mb-5 mt-2 text-sm leading-6 text-muted-foreground">An operator must provision and verify the account first. This form does not create an account or send an invitation.</p>
    <form aria-label="Membership access" onSubmit={submit} onChange={() => { requestKey.current = null; }} className="space-y-5">
      <fieldset disabled={pending || stale} className="min-w-0 space-y-5">
        <div className="space-y-2"><Label htmlFor="member-user">Verified user ID</Label><Input id="member-user" value={userId} onChange={e => setUserId(e.target.value)} readOnly={Boolean(member)} required maxLength={200} autoComplete="off" /></div>
        <fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">Roles</legend>{Object.keys(roleGrants).map(role => <div key={role} className="flex items-center justify-between gap-3"><Label htmlFor={`role-${role}`}>{label(role)}</Label><Switch id={`role-${role}`} checked={roles.includes(role)} onCheckedChange={checked => { requestKey.current = null; setRoles(toggle(roles, role, checked)); }} /></div>)}</fieldset>
        <fieldset className="min-w-0 space-y-3"><legend className="mb-3 text-sm font-medium">Legal-entity grants</legend><p className="text-xs text-muted-foreground">Roles do not grant access to every legal entity. Choose the visible entities this identity may access.</p>{entities.map(entity => <div key={entity.id} className="flex items-center justify-between gap-3"><Label htmlFor={`grant-${entity.id}`} className="min-w-0 break-words">{entity.name}</Label><Switch id={`grant-${entity.id}`} checked={entityIds.includes(entity.id)} onCheckedChange={checked => { requestKey.current = null; setEntityIds(toggle(entityIds, entity.id, checked)); }} /></div>)}
          {!entities.length ? <p className="text-sm text-muted-foreground">No visible legal entities available.</p> : null}
          {entityChoicesTruncated ? <p className="text-xs text-muted-foreground">Showing the first 100 visible entities. Contact an operator for grants outside this list.</p> : null}
          {retained.length ? <p className="text-xs text-muted-foreground">{retained.length} existing grants outside the visible list will be retained.</p> : null}
        </fieldset>
        <div className="flex items-center justify-between gap-3"><Label htmlFor="member-active">Membership active</Label><Switch id="member-active" checked={active} onCheckedChange={value => { requestKey.current = null; setActive(value); }} /></div>
        <p className="text-xs text-muted-foreground">Site-specific access is unavailable until the workforce module is implemented. The last active organization administrator cannot be removed.</p>
      </fieldset>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {stale ? <Button type="button" variant="outline" onClick={onReload}>Reload current memberships</Button> : null}
      <Button className="w-full" type="submit" disabled={pending || stale || !roles.length}>{pending ? "Saving…" : member ? "Save access" : "Create membership"}</Button>
    </form>
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Revoke this membership?</AlertDialogTitle><AlertDialogDescription>The identity will lose access to this organization on its next authorized request. Financial history and audit records are retained.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep access</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void save()}>Revoke access</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </CardContent></Card>;
}
