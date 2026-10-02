"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import { ControlType, statementSections, isParentCandidate, type AccountType, type ReportMapping } from "@/domain/accounts";
import type { AccountDTO } from "./contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function AccountForm({ url, account, parents }: { url: string; account?: z.infer<typeof AccountDTO>; parents: z.infer<typeof AccountDTO>[] }) {
  const router = useRouter(), key = useRef<string | null>(null);
  const [type, setType] = useState<z.infer<typeof AccountType>>(account?.type ?? "asset"), [side, setSide] = useState(account?.normalSide ?? "debit");
  const [control, setControl] = useState<string>(account?.controlType ?? "none"), [category, setCategory] = useState<z.infer<typeof ReportMapping>["cashFlowCategory"]>(account?.reportMapping.cashFlowCategory ?? "unclassified");
  const [parent, setParent] = useState(account?.parentId ?? "none");
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false), [saved, setSaved] = useState(false);
  const prefix = account?.id ?? "new-account";
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return; setPending(true); setError(""); setSaved(false);
    const form = event.currentTarget, fields = new FormData(form);
    const editable = { name: String(fields.get("name") ?? ""), parentId: parent === "none" ? null : parent,
      reportMapping: { statementSection: statementSections[type], cashFlowCategory: category } };
    try {
      key.current ??= crypto.randomUUID();
      const response = await fetch(account ? `${url}/${account.id}` : url, { method: account ? "PATCH" : "POST", headers: { "Content-Type": "application/json", ...(account ? { "If-Match": `"${account.version}"` } : { "Idempotency-Key": key.current }) },
        body: JSON.stringify(account ? editable : { ...editable, code: String(fields.get("code") ?? ""), type, normalSide: side, isControl: control !== "none", controlType: control === "none" ? null : control }) });
      const payload = await response.json();
      if (!response.ok) { setConflict(response.status === 412); setError(payload.error?.fieldErrors?.map((field: { message: string }) => field.message).join(" ") || payload.error?.message || "Account could not be saved."); return; }
      if (!account) { form.reset(); key.current = null; setParent("none"); }
      setSaved(true); router.refresh();
    } catch { setError(account ? "The edit was not confirmed. Reload the account before trying again." : "The response was not confirmed. Retry unchanged to reuse the same key."); }
    finally { setPending(false); }
  }
  return <Card><CardContent className="space-y-4 pt-6"><h2 className="text-xl font-medium">{account ? "Edit account" : "Create account"}</h2><p className="text-sm text-muted-foreground">{account ? `Version ${account.version}. Code, type, normal side and control classification cannot change.` : "Set up account metadata only. This does not post a balance or activate a statutory/reporting policy."}</p>
    <form aria-label={account ? "Edit account" : "Create account"} onSubmit={save} onChange={() => { key.current = null; setSaved(false); }} className="space-y-4">
      {!account ? <div className="space-y-2"><Label htmlFor={`${prefix}-code`}>Account code</Label><Input id={`${prefix}-code`} name="code" required maxLength={100} disabled={pending} placeholder="1000" /></div> : null}
      <div className="space-y-2"><Label htmlFor={`${prefix}-name`}>Account name</Label><Input id={`${prefix}-name`} name="name" defaultValue={account?.name ?? ""} required maxLength={200} disabled={pending} /></div>
      {!account ? <><div className="space-y-2"><Label htmlFor={`${prefix}-type`}>Account type</Label><Select value={type} onValueChange={value => { key.current = null; setType(value as z.infer<typeof AccountType>); }} disabled={pending}><SelectTrigger id={`${prefix}-type`} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{Object.keys(statementSections).map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label htmlFor={`${prefix}-side`}>Normal side</Label><Select value={side} onValueChange={value => { key.current = null; setSide(value as "debit" | "credit"); }} disabled={pending}><SelectTrigger id={`${prefix}-side`} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="debit">Debit</SelectItem><SelectItem value="credit">Credit</SelectItem></SelectContent></Select></div>
        <div className="space-y-2"><Label htmlFor={`${prefix}-control`}>Control role</Label><Select value={control} onValueChange={value => { key.current = null; setControl(value); }} disabled={pending}><SelectTrigger id={`${prefix}-control`} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Ordinary account</SelectItem>{ControlType.options.map(value => <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></div></> : null}
      <div className="space-y-2"><Label htmlFor={`${prefix}-parent`}>Parent account (optional)</Label><Select value={parent} onValueChange={value => { key.current = null; setParent(value); }} disabled={pending}><SelectTrigger id={`${prefix}-parent`} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Root account</SelectItem>{parents.filter(candidate => isParentCandidate(type, account?.id, candidate)).map(candidate => <SelectItem key={candidate.id} value={candidate.id}>{candidate.code} · {candidate.name}</SelectItem>)}{account?.parentId && !parents.some(candidate => candidate.id === account.parentId) ? <SelectItem value={account.parentId}>Current parent (another page)</SelectItem> : null}</SelectContent></Select><p className="text-xs text-muted-foreground">Eligible parents from this page. Hierarchy cycles are checked when saving. Choose Root account to clear the parent.</p></div>
      <div className="space-y-2"><Label htmlFor={`${prefix}-category`}>Cash-flow classification</Label><Select value={category} onValueChange={value => { key.current = null; setCategory(value as z.infer<typeof ReportMapping>["cashFlowCategory"]); }} disabled={pending}><SelectTrigger id={`${prefix}-category`} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["unclassified", "operating", "investing", "financing", "cash"].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">Statement section: {statementSections[type]}. Only cash control accounts use “cash”. Unclassified does not mean zero cash flow.</p></div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{saved ? <p role="status" className="text-sm">Account saved.</p> : null}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending || conflict}>{pending ? "Saving…" : account ? "Save account changes" : "Create account"}</Button>{conflict ? <Button type="button" variant="outline" disabled={pending} onClick={() => router.refresh()}>Reload current account</Button> : null}</div>
    </form>
  </CardContent></Card>;
}
