"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import type { PartyDTO } from "./contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type Party = Pick<z.infer<typeof PartyDTO>, "id" | "version" | "name" | "roleSet" | "contact" | "address" | "taxIdentifier" | "paymentTermsDays" | "creditLimit">;
export function PartyForm({ party, url }: { party?: Party; url: string }) {
  const router = useRouter(), key = useRef<string | null>(null), busy = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false), [saved, setSaved] = useState(false);
  const prefix = party ? `party-${party.id}` : "new-party";
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy.current) return; busy.current = true; setPending(true); setError(""); setSaved(false);
    const values = new FormData(event.currentTarget), optional = (field: string) => String(values.get(field) ?? "").trim() || null;
    try {
      key.current ??= crypto.randomUUID();
      const response = await fetch(party ? `${url}/${party.id}` : url, { method: party ? "PATCH" : "POST", headers: { "Content-Type": "application/json", ...(party ? { "If-Match": `"${party.version}"` } : { "Idempotency-Key": key.current }) },
        body: JSON.stringify({ name: values.get("name"), roleSet: values.getAll("roleSet"), contact: optional("contact"), address: optional("address"), taxIdentifier: optional("taxIdentifier"), paymentTermsDays: Number(values.get("paymentTermsDays")), creditLimit: optional("creditLimit") }) });
      const payload = await response.json();
      if (!response.ok) { setConflict(response.status === 412); setError([payload.error?.message ?? "Party could not be saved.", ...(payload.error?.fieldErrors ?? []).map((field: { path: string; message: string }) => `${field.path}: ${field.message}`)].join(" ")); return; }
      setSaved(true); router.push(`/workspace/parties?org=${payload.data.organizationId}&entity=${payload.data.entityId}&party=${payload.data.id}`); router.refresh();
    } catch { setError("The response was not confirmed. Retry unchanged; new records reuse the same request key."); }
    finally { busy.current = false; setPending(false); }
  }
  return <Card><CardContent className="pt-6"><h2 className="text-xl font-medium">{party ? "Edit party" : "Add customer or supplier"}</h2><form aria-label={party ? "Edit party" : "Create party"} className="mt-5 space-y-4" onSubmit={save} onChange={() => { key.current = null; setSaved(false); }}>
    <fieldset disabled={pending || conflict || saved} className="space-y-4">
      <div className="space-y-2"><Label htmlFor={`${prefix}-name`}>Party name</Label><Input id={`${prefix}-name`} name="name" required maxLength={200} defaultValue={party?.name} /></div>
      <fieldset className="space-y-2"><legend className="text-sm font-medium">Roles (choose one or both)</legend>{(["customer", "supplier"] as const).map(role => <label key={role} className="flex items-center gap-2 text-sm"><input type="checkbox" name="roleSet" value={role} defaultChecked={party ? party.roleSet.includes(role) : role === "customer"} />{role === "customer" ? "Customer" : "Supplier"}</label>)}</fieldset>
      <div className="space-y-2"><Label htmlFor={`${prefix}-contact`}>Contact (optional)</Label><Input id={`${prefix}-contact`} name="contact" maxLength={2000} defaultValue={party?.contact ?? ""} /></div>
      <div className="space-y-2"><Label htmlFor={`${prefix}-address`}>Address (optional)</Label><Input id={`${prefix}-address`} name="address" maxLength={2000} defaultValue={party?.address ?? ""} /></div>
      <div className="space-y-2"><Label htmlFor={`${prefix}-tax`}>Tax identifier (optional)</Label><Input id={`${prefix}-tax`} name="taxIdentifier" maxLength={100} defaultValue={party?.taxIdentifier ?? ""} /></div>
      <div className="space-y-2"><Label htmlFor={`${prefix}-terms`}>Payment terms (days)</Label><Input id={`${prefix}-terms`} name="paymentTermsDays" type="number" min={0} max={3650} step={1} required defaultValue={party?.paymentTermsDays ?? 0} /></div>
      <div className="space-y-2"><Label htmlFor={`${prefix}-credit`}>Customer credit limit (NPR, optional)</Label><Input id={`${prefix}-credit`} name="creditLimit" inputMode="decimal" maxLength={21} defaultValue={party?.creditLimit ?? ""} /><p className="text-xs text-muted-foreground">Leave blank for no configured limit. Supplier-only records cannot have a credit limit. Terms and limits are master data, not invoice approval or tax policy.</p></div>
      <Button type="submit" className="w-full">{pending ? "Saving…" : party ? "Save party" : "Create party"}</Button>
    </fieldset>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{saved ? <p role="status" className="text-sm">Party saved.</p> : null}{conflict ? <Button type="button" variant="outline" onClick={() => router.refresh()}>Reload current party</Button> : null}
  </form></CardContent></Card>;
}
export function ArchiveParty({ party, url }: { party: Pick<Party, "id" | "version" | "name">; url: string }) {
  const router = useRouter(), key = useRef<string | null>(null), busy = useRef(false);
  const [reason, setReason] = useState(""), [open, setOpen] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  async function archive() {
    if (busy.current) return; busy.current = true; setPending(true); setError("");
    try {
      key.current ??= crypto.randomUUID();
      const response = await fetch(`${url}/${party.id}/archive`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": `"${party.version}"`, "Idempotency-Key": key.current }, body: JSON.stringify({ reason: reason.trim() }) });
      const payload = await response.json(); if (!response.ok) { setConflict(response.status === 412); setError(payload.error?.message ?? "Party could not be archived."); return; }
      router.refresh();
    } catch { setError("The response was not confirmed. Retry unchanged to reuse the same key."); }
    finally { busy.current = false; setPending(false); }
  }
  return <section aria-label="Archive party" className="space-y-3 border-t pt-5"><h3 className="font-medium">Archive party</h3><p className="text-sm text-muted-foreground">Open balances and unapplied deposits or advances must be resolved first. All references and versions remain; the name and tax identifier stay reserved. Archival cannot be undone here.</p><Label htmlFor="party-archive-reason">Archive reason</Label><Input id="party-archive-reason" maxLength={1000} disabled={pending} value={reason} onChange={event => { key.current = null; setReason(event.target.value); }} /><Button variant="outline" disabled={pending || conflict || reason.trim().length < 3} onClick={() => setOpen(true)}>Archive party</Button>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{conflict ? <Button variant="outline" onClick={() => router.refresh()}>Reload current party</Button> : null}
    <AlertDialog open={open} onOpenChange={setOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive {party.name}?</AlertDialogTitle><AlertDialogDescription>The party becomes inactive. Previous versions, source references and archive reason remain available. No financial history is deleted.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancel archive</AlertDialogCancel><AlertDialogAction disabled={pending} onClick={() => void archive()}>Confirm archive</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
