"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import type { AccountDTO } from "./contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
export function ArchiveAccount({ account, url }: { account: z.infer<typeof AccountDTO>; url: string }) {
  const router = useRouter(), key = useRef<string | null>(null);
  const [reason, setReason] = useState(""), [open, setOpen] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  async function archive() {
    if (pending) return; setPending(true); setError("");
    try {
      key.current ??= crypto.randomUUID();
      const response = await fetch(`${url}/${account.id}/archive`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": `"${account.version}"`, "Idempotency-Key": key.current }, body: JSON.stringify({ reason: reason.trim() }) });
      const payload = await response.json();
      if (!response.ok) { setConflict(response.status === 412); setError(payload.error?.message ?? "Account could not be archived."); return; }
      router.refresh();
    } catch { setError("The response was not confirmed. Retry unchanged to reuse the same key."); } finally { setPending(false); }
  }
  return <section aria-label="Archive account" className="space-y-3 border-t pt-5"><h2 className="font-medium">Archive account</h2><p className="text-sm text-muted-foreground">Active children must be moved or archived first. The code remains reserved and all versions are retained. This cannot be undone here.</p><Label htmlFor="account-archive-reason">Archive reason</Label><Input id="account-archive-reason" value={reason} disabled={pending} maxLength={1000} onChange={event => { key.current = null; setReason(event.target.value); }} /><Button variant="outline" disabled={pending || conflict || reason.trim().length < 3} onClick={() => setOpen(true)}>Archive account</Button>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{conflict ? <Button variant="outline" disabled={pending} onClick={() => router.refresh()}>Reload current account</Button> : null}
    <AlertDialog open={open} onOpenChange={setOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive {account.code}?</AlertDialogTitle><AlertDialogDescription>The account becomes inactive. Its classification, previous versions and archive reason remain available. No financial history is deleted.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancel archive</AlertDialogCancel><AlertDialogAction disabled={pending} onClick={() => void archive()}>Confirm archive</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
