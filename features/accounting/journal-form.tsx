"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import type { JournalDTO } from "./journal-contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
type AccountChoice = { id: string; code: string; name: string };
type Line = { localId: string; accountId: string; debit: string; credit: string; dimensions: { branchId?: string } };
export function JournalForm({ journal, accounts, url, screen }: { journal?: z.infer<typeof JournalDTO>; accounts: AccountChoice[]; url: string; screen: string }) {
  const router = useRouter(), key = useRef<string | null>(null);
  const [lines, setLines] = useState<Line[]>(() => journal ? journal.lines.map((line, i) => ({ ...line, localId: `existing-${i}` })) : [0, 1].map(i => ({ localId: `initial-${i}`, accountId: "", debit: "0.00", credit: "0.00", dimensions: {} })));
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  const prefix = journal?.id ?? "new-journal";
  function changeLine(id: string, field: "accountId" | "debit" | "credit", value: string) {
    key.current = null; setLines(old => old.map(line => line.localId === id ? { ...line, [field]: value } : line));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); setPending(true); setError("");
    try {
      key.current ??= crypto.randomUUID();
      const response = await fetch(journal ? `${url}/${journal.id}` : url, { method: journal ? "PATCH" : "POST", headers: { "Content-Type": "application/json", ...(journal ? { "If-Match": `"${journal.version}"` } : { "Idempotency-Key": key.current }) }, body: JSON.stringify({ postingDate: values.get("postingDate"), documentDate: values.get("documentDate"), description: values.get("description"), lines: lines.map(({ accountId, debit, credit, dimensions }) => ({ accountId, debit, credit, dimensions })) }) });
      const payload = await response.json();
      if (!response.ok) { setConflict(response.status === 412); setError(payload.error?.fieldErrors?.map((item: { message: string }) => item.message).join(" ") || payload.error?.message || "Draft could not be saved."); return; }
      key.current = null; router.replace(`${screen}&journal=${payload.data.id}`); router.refresh();
    } catch { setError("No save was confirmed. Keep these fields and retry when connected."); } finally { setPending(false); }
  }
  return <Card><CardContent className="space-y-4 pt-6"><h2 className="text-xl font-medium">{journal ? "Edit journal draft" : "Create journal draft"}</h2><p className="text-sm text-muted-foreground">NPR only. Exactly one positive side per line; totals must balance. Saving does not post money. Editing a submitted or approved journal returns it to draft and invalidates that submission.</p>
    <form aria-label={journal ? "Edit journal draft" : "Create journal draft"} onSubmit={save} onChange={() => { key.current = null; }} className="space-y-4">
      <fieldset disabled={pending || conflict} className="min-w-0 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${prefix}-posting`}>Posting date</Label><Input id={`${prefix}-posting`} name="postingDate" type="date" defaultValue={journal?.postingDate} required /></div><div className="space-y-2"><Label htmlFor={`${prefix}-document`}>Document date</Label><Input id={`${prefix}-document`} name="documentDate" type="date" defaultValue={journal?.documentDate} required /></div></div>
        <div className="space-y-2"><Label htmlFor={`${prefix}-description`}>Description</Label><Textarea id={`${prefix}-description`} name="description" defaultValue={journal?.description} required maxLength={1000} /></div>
        {lines.map((line, index) => <fieldset key={line.localId} className="min-w-0 space-y-3 rounded-lg border p-3"><legend className="px-1 text-sm">Line {index + 1}</legend><div className="space-y-2"><Label htmlFor={`${prefix}-${line.localId}-account`}>Account for line {index + 1}</Label><select id={`${prefix}-${line.localId}-account`} className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={line.accountId} onChange={event => changeLine(line.localId, "accountId", event.target.value)} required><option value="">Choose ordinary account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}{line.accountId && !accounts.some(account => account.id === line.accountId) ? <option value={line.accountId}>Current account · {line.accountId}</option> : null}</select></div>
          <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor={`${prefix}-${line.localId}-debit`}>Debit for line {index + 1}</Label><Input id={`${prefix}-${line.localId}-debit`} inputMode="decimal" value={line.debit} onChange={event => changeLine(line.localId, "debit", event.target.value)} required /></div><div className="space-y-2"><Label htmlFor={`${prefix}-${line.localId}-credit`}>Credit for line {index + 1}</Label><Input id={`${prefix}-${line.localId}-credit`} inputMode="decimal" value={line.credit} onChange={event => changeLine(line.localId, "credit", event.target.value)} required /></div></div>
          {line.dimensions.branchId ? <p className="break-all text-xs">Retained branch: {line.dimensions.branchId}</p> : null}
          {lines.length > 2 ? <Button type="button" variant="outline" onClick={() => { key.current = null; setLines(old => old.filter(item => item.localId !== line.localId)); }}>Remove line {index + 1}</Button> : null}
        </fieldset>)}
        <Button type="button" variant="outline" disabled={lines.length >= 500} onClick={() => { key.current = null; setLines(old => [...old, { localId: crypto.randomUUID(), accountId: "", debit: "0.00", credit: "0.00", dimensions: {} }]); }}>Add journal line</Button>
      </fieldset>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending || conflict}>{pending ? "Saving…" : journal ? "Save draft changes" : "Save journal draft"}</Button>{conflict ? <Button type="button" variant="outline" disabled={pending} onClick={() => router.refresh()}>Reload current draft</Button> : null}</div>
    </form>
  </CardContent></Card>;
}

export function CancelJournal({ journal, url }: { journal: z.infer<typeof JournalDTO>; url: string }) {
  const router = useRouter(), key = useRef<string | null>(null);
  const [reason, setReason] = useState(""), [confirm, setConfirm] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  async function cancel() {
    setPending(true); setError("");
    try { key.current ??= crypto.randomUUID(); const response = await fetch(`${url}/${journal.id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": `"${journal.version}"`, "Idempotency-Key": key.current }, body: JSON.stringify({ reason }) }); const payload = await response.json();
      if (!response.ok) { setConflict(response.status === 412); setError(payload.error?.message ?? "Cancellation could not be confirmed."); return; }
      key.current = null; setConfirm(false); router.refresh();
    } catch { setError("No cancellation was confirmed. Retry with the same reason when connected."); } finally { setPending(false); }
  }
  return <section aria-label="Cancel journal draft" className="space-y-3 border-t pt-4"><Label htmlFor={`cancel-${journal.id}`}>Cancellation reason</Label><Input id={`cancel-${journal.id}`} value={reason} disabled={pending || confirm || conflict} onChange={event => { key.current = null; setReason(event.target.value); }} maxLength={1000} />
    {confirm ? <div className="space-y-2"><p className="text-sm">Cancel this draft? Its saved history will remain; no ledger entry is created.</p><div className="flex flex-wrap gap-2"><Button disabled={pending || conflict} onClick={cancel}>Confirm cancellation</Button><Button variant="outline" disabled={pending} onClick={() => setConfirm(false)}>Keep draft</Button></div></div> : <Button variant="outline" disabled={pending || conflict || reason.trim().length < 3} onClick={() => setConfirm(true)}>Cancel journal draft</Button>}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{conflict ? <Button variant="outline" disabled={pending} onClick={() => router.refresh()}>Reload current draft</Button> : null}
  </section>;
}
