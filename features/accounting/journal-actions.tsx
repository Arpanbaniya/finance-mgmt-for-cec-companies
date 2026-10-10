"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
type Action = "submit" | "approve" | "reject" | "post" | "reverse";
const labels: Record<Action, string> = { submit: "Submit for review", approve: "Approve submission", reject: "Reject submission", post: "Post journal", reverse: "Prepare dated reversal" };
export function JournalActions({ id, version, actions, url, screen, originalDate }: { id: string; version: number; actions: Action[]; url: string; screen: string; originalDate: string }) {
  const router = useRouter(), key = useRef<string | null>(null);
  const [selected, setSelected] = useState<Action | null>(null), [reason, setReason] = useState(""), [pending, setPending] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  const [postingDate, setPostingDate] = useState(originalDate);
  async function execute() {
    if (!selected) return; setPending(true); setError("");
    try { key.current ??= crypto.randomUUID(); const response = await fetch(`${url}/${id}/${selected}`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": `"${version}"`, "Idempotency-Key": key.current }, body: JSON.stringify(selected === "reverse" ? { postingDate, reason } : selected === "post" ? {} : reason.trim() ? { reason } : {}) }); const payload = await response.json();
      if (!response.ok) { setConflict(response.status === 412); setError(payload.error?.message ?? "Transition could not be confirmed."); return; }
      if (selected === "reverse") router.push(`${screen}&journal=${payload.data.resourceId}`);
      key.current = null; setSelected(null); setReason(""); router.refresh();
    } catch { setError("No transition was confirmed. Retry the same action when connected."); } finally { setPending(false); }
  }
  return <section aria-label="Journal actions" className="space-y-3 border-t pt-4"><h3 className="font-medium">Journal actions</h3>{selected ? <div className="space-y-3 rounded-md border p-3"><p className="text-sm">{selected === "reverse" ? "Prepare a linked draft with the original debit and credit sides exchanged? No money is posted yet. Fresh independent approval and an open period are required before its posting. The original stays unchanged." : selected === "post" ? "Post the frozen, independently approved journal? This commits an immutable ledger entry, a document number and audit evidence. It cannot be edited afterward." : selected === "submit" ? "Freeze this saved version and its applicable policy for independent review?" : selected === "reject" ? "Return this submission to a new editable draft version? Earlier decisions remain as history." : "Approve this frozen submission as an independent reviewer?"}</p>
    {selected === "reverse" ? <div className="space-y-2"><Label htmlFor={`reversal-date-${id}`}>Reversal posting date</Label><Input id={`reversal-date-${id}`} type="date" min={originalDate} value={postingDate} disabled={pending} onChange={event => { key.current = null; setPostingDate(event.target.value); }} /></div> : null}
    {selected !== "post" ? <div className="space-y-2"><Label htmlFor={`transition-${id}`}>{selected === "reverse" ? "Reversal reason" : selected === "reject" ? "Rejection reason" : "Review note (optional)"}</Label><Input id={`transition-${id}`} value={reason} disabled={pending} onChange={event => { key.current = null; setReason(event.target.value); }} maxLength={1000} /></div> : null}
    <div className="flex flex-wrap gap-2"><Button onClick={execute} disabled={pending || conflict || ((selected === "reject" || selected === "reverse") && reason.trim().length < 3) || (selected === "reverse" && !postingDate) || (selected !== "post" && reason.trim().length > 0 && reason.trim().length < 3)}>{pending ? "Confirming…" : `Confirm ${selected}`}</Button><Button variant="outline" disabled={pending} onClick={() => { key.current = null; setSelected(null); setReason(""); setError(""); }}>Keep current state</Button></div></div> : <div className="flex flex-wrap gap-2">{actions.map(action => <Button key={action} variant={action === "post" ? "default" : "outline"} disabled={pending || conflict} onClick={() => { key.current = null; setSelected(action); }}>{labels[action]}</Button>)}</div>}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{conflict ? <Button variant="outline" disabled={pending} onClick={() => router.refresh()}>Reload current journal</Button> : null}
  </section>;
}
