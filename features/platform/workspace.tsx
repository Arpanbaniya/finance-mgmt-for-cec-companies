"use client";
import { useState, useRef, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { z } from "zod";
import type { EntityDTO, MembershipDTO } from "./contracts";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Building2, Plus } from "lucide-react";
import { EntityCard } from "./entity-card";
import { permissionsFor } from "@/domain/permissions";
type Organization = z.infer<typeof MembershipDTO> & { entities: z.infer<typeof EntityDTO>[] };
export function Workspace({ name, organizations }: { name: string; organizations: Organization[] }) {
  const router = useRouter();
  const requestKey = useRef<string | null>(null);
  const [orgId, setOrgId] = useState(organizations[0]?.organizationId ?? ""), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const selected = organizations.find(o => o.organizationId === orgId);
  const canCreate = selected?.roleIds.includes("organization_admin");
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); const form = event.currentTarget, data = new FormData(form);
    try {
      requestKey.current ??= crypto.randomUUID();
      const response = await fetch(`/api/v1/orgs/${orgId}/entities`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey.current }, body: JSON.stringify({ name: data.get("name"), baseCurrency: "NPR", timezone: "Asia/Kathmandu", activeModes: ["labour"], reportingProfile: "demo_accrual" }) });
      const payload = await response.json();
      if (!response.ok) { setError(payload.error?.message ?? "Could not save the legal entity."); return; }
      form.reset(); requestKey.current = null; router.refresh();
    } catch { setError("Could not reach the server. Try again when connected."); } finally { setPending(false); }
  }
  async function signOut() { await fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); router.replace("/sign-in"); router.refresh(); }
  return <main className="mx-auto max-w-6xl px-5 py-8 sm:px-10"><header className="flex items-center justify-between border-b pb-6"><Brand /><Button variant="outline" onClick={signOut}>Sign out</Button></header><div className="py-10"><Badge variant="outline">R1 · Company setup</Badge><h1 className="mt-4 text-3xl font-medium">Your company workspace</h1><p className="mt-3 text-muted-foreground">Welcome, {name}. Set up the legal entities that will hold your books.</p></div>
    {organizations.length ? <div className="mb-7 flex flex-wrap gap-2" aria-label="Organization selection">{organizations.map((org, i) => <Button key={org.organizationId} variant={orgId === org.organizationId ? "default" : "outline"} onClick={() => { requestKey.current = null; setOrgId(org.organizationId); }}>Organization {i + 1}</Button>)}</div> : <p className="rounded-lg border p-5">Your account has no active organization membership. Contact your administrator.</p>}
    <div className="grid gap-7 lg:grid-cols-[1fr_360px]"><section aria-label="Legal entities"><h2 className="mb-4 text-lg font-medium">Legal entities</h2>{selected?.entities.length ? <div className="space-y-3">{selected.entities.map(e => <EntityCard key={`${e.id}-${e.version}`} entity={e} canEdit={Boolean(canCreate)} canReadPolicies={permissionsFor(selected.roleIds).has("approvals.read")} canReadAccounts={permissionsFor(selected.roleIds).has("accounts.read")} canReadFinanceSetup={permissionsFor(selected.roleIds).has("periods.read") && permissionsFor(selected.roleIds).has("settings.read")} />)}</div> : <div className="rounded-xl border border-dashed p-8 text-center"><Building2 className="mx-auto mb-4 size-7 text-muted-foreground" /><h3 className="font-medium">No legal entities yet</h3><p className="mt-2 text-sm text-muted-foreground">Each legal entity will keep its own accounts, fiscal periods and financial records.</p></div>}</section>
    {canCreate ? <Card className="self-start"><CardContent className="pt-6"><h2 className="text-lg font-medium">Create a legal entity</h2><p className="mb-5 mt-2 text-sm leading-6 text-muted-foreground">Start with a fictional company. Live policy activation comes after review.</p><form onSubmit={create} onChange={() => { requestKey.current = null; }} className="space-y-4"><div className="space-y-2"><Label htmlFor="entity-name">Legal entity name</Label><Input id="entity-name" name="name" maxLength={200} required placeholder="Everest Workforce Services Pvt. Ltd." /></div>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<Button type="submit" className="w-full" disabled={pending}>{pending ? "Saving…" : <><Plus size={16} />Create entity</>}</Button></form></CardContent></Card> : null}</div>
    {canCreate ? <div className="mt-8"><Button variant="outline" asChild><Link href={`/workspace/members?org=${orgId}`}>Manage memberships</Link></Button></div> : null}
    <p className="mt-10 border-t pt-6 text-xs text-muted-foreground">Company setup is available. Accounting, payroll and billing will be added through the Phase 1 work packages.</p>
  </main>;
}
