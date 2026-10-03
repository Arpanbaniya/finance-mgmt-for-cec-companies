"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import { EntityDTO } from "./contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Building2 } from "lucide-react";
import Link from "next/link";

export function EntityCard({ entity, canEdit, canReadPolicies, canReadAccounts, canReadFinanceSetup }: { entity: z.infer<typeof EntityDTO>; canEdit: boolean; canReadPolicies: boolean; canReadAccounts: boolean; canReadFinanceSetup: boolean }) {
  const router = useRouter();
  const [record, setRecord] = useState(entity), [editing, setEditing] = useState(false), [pending, setPending] = useState(false);
  const [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  const url = `/api/v1/orgs/${entity.organizationId}/entities/${entity.id}`;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); setPending(true); setError("");
    const identifier = (field: string) => String(values.get(field) ?? "").trim() || null;
    try {
      const response = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": `"${record.version}"` },
        body: JSON.stringify({ name: values.get("name"), registrationIdentifier: identifier("registrationIdentifier"), taxIdentifier: identifier("taxIdentifier") }) });
      const result = await response.json();
      if (!response.ok) { setConflict(response.status === 412); setError(result.error?.message ?? "Company changes could not be saved."); return; }
      setRecord(EntityDTO.parse(result.data)); setEditing(false); setConflict(false); router.refresh();
    } catch { setError("Could not reach the server. Your changes have not been confirmed."); }
    finally { setPending(false); }
  }
  async function reload() {
    setPending(true);
    try {
      const response = await fetch(url, { cache: "no-store" }); const result = await response.json();
      if (!response.ok) { setError(result.error?.message ?? "Company is unavailable."); return; }
      setRecord(EntityDTO.parse(result.data)); setConflict(false); setError("");
    } catch { setError("Could not reload the company. Try again when connected."); }
    finally { setPending(false); }
  }
  return <Card><CardContent className="pt-6">
    <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-4 sm:grid-cols-[2rem_minmax(0,1fr)_auto]"><Building2 aria-hidden="true" className="size-8 shrink-0 text-primary" />
      <div className="min-w-0 flex-1"><h3 className="break-words font-medium">{record.name}</h3><p className="mt-1 text-xs text-muted-foreground">{record.baseCurrency} · {record.timezone}</p></div>
      <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-1"><Badge variant="outline">{record.policyStatus === "demo" ? "Demo policy" : "Review required"}</Badge>
      {canEdit && !editing ? <Button variant="outline" size="sm" onClick={() => setEditing(true)} aria-label={`Edit ${record.name}`}>Edit</Button> : null}</div>
    </div>
    {canReadPolicies ? <div className="mt-4"><Button variant="outline" size="sm" asChild><Link href={`/workspace/controls?org=${entity.organizationId}&entity=${entity.id}`}>Approval policies and audit</Link></Button></div> : null}
    {canReadAccounts ? <div className="mt-3"><Button variant="outline" size="sm" asChild><Link href={`/workspace/accounts?org=${entity.organizationId}&entity=${entity.id}`}>Chart of accounts</Link></Button></div> : null}
    {canReadFinanceSetup ? <div className="mt-3"><Button variant="outline" size="sm" asChild><Link href={`/workspace/finance-setup?org=${entity.organizationId}&entity=${entity.id}`}>Fiscal calendars and mappings</Link></Button></div> : null}
    {editing ? <form key={record.version} onSubmit={save} aria-label="Edit company" className="mt-5 space-y-4 border-t pt-5">
      <p className="text-xs text-muted-foreground">Company details · version {record.version}. Scope, currency and policy are not editable here.</p>
      <div className="space-y-2"><Label htmlFor={`name-${entity.id}`}>Company name</Label><Input id={`name-${entity.id}`} name="name" defaultValue={record.name} required maxLength={200} disabled={pending} /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor={`registration-${entity.id}`}>Registration identifier</Label><Input id={`registration-${entity.id}`} name="registrationIdentifier" defaultValue={record.registrationIdentifier ?? ""} maxLength={100} disabled={pending} /></div>
        <div className="space-y-2"><Label htmlFor={`tax-${entity.id}`}>Tax identifier</Label><Input id={`tax-${entity.id}`} name="taxIdentifier" defaultValue={record.taxIdentifier ?? ""} maxLength={100} disabled={pending} /></div>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending || conflict}>{pending ? "Saving…" : "Save changes"}</Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => { setEditing(false); setError(""); setConflict(false); }}>Cancel</Button>
        {conflict ? <Button type="button" variant="outline" disabled={pending} onClick={reload}>Reload current company</Button> : null}
      </div>
    </form> : null}
  </CardContent></Card>;
}
