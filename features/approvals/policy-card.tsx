"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { z } from "zod";
import type { ApprovalPolicyDTO } from "./contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

export function PolicyCard({ policy, url, currentUserId, canActivate }: { policy: z.infer<typeof ApprovalPolicyDTO>; url: string; currentUserId: string; canActivate: boolean }) {
  const router = useRouter(), key = useRef<string | null>(null);
  const [reason, setReason] = useState(""), [pending, setPending] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  const self = policy.createdBy === currentUserId;
  async function activate() {
    setPending(true); setError("");
    try {
      key.current ??= crypto.randomUUID();
      const response = await fetch(`${url}/${policy.id}/activate`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": `"${policy.version}"`, "Idempotency-Key": key.current }, body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}) });
      const payload = await response.json();
      if (!response.ok) { setConflict(response.status === 412); setError(payload.error?.message ?? "Activation could not be confirmed."); return; }
      router.refresh();
    } catch { setError("The response was not confirmed. Retry unchanged to reuse the same key."); }
    finally { setPending(false); }
  }
  return <Card aria-label={`Policy ${policy.name}`}><CardContent className="space-y-4 pt-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><h3 className="min-w-0 break-words font-medium">{policy.name}</h3><Badge variant={policy.status === "active" ? "default" : "outline"}>{policy.status}</Badge></div>
    <p className="text-sm text-muted-foreground">{policy.aggregateTypes.map(type => type.replaceAll("_", " ")).join(", ")} · NPR · version {policy.version}</p>
    <p className="text-sm">{policy.effectiveFrom} → {policy.effectiveTo ? `${policy.effectiveTo} (exclusive)` : "no end date"}</p>
    <ul className="space-y-2 text-sm">{policy.thresholds.map((row, index) => <li key={index} className="rounded-md bg-muted p-3"><span className="block">{row.minInclusive} ≤ amount {row.maxExclusive ? `< ${row.maxExclusive}` : "(unbounded)"}</span><span className="mt-1 block break-words text-muted-foreground">{row.numberOfDistinctApprovers} independent checker{row.numberOfDistinctApprovers === 1 ? "" : "s"} · {row.requiredPermission}</span></li>)}</ul>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Immutable policy reference</summary><dl className="mt-3 space-y-2 break-all"><dt>Policy ID</dt><dd>{policy.id}</dd><dt>Content hash</dt><dd>{policy.contentHash}</dd><dt>Created by</dt><dd>{policy.createdBy}</dd>{policy.activatedBy ? <><dt>Activated by</dt><dd>{policy.activatedBy}</dd><dt>Review reason</dt><dd>{policy.activationReason ?? "Not supplied"}</dd></> : null}</dl></details>
    {policy.status === "draft" ? <div className="space-y-3 border-t pt-4">{self ? <p className="text-sm text-muted-foreground">You created this draft. A different designated reviewer must activate it.</p> : !canActivate ? <p className="text-sm text-muted-foreground">Activation requires the policy reviewer grant and an admin or finance role.</p> : null}
      {canActivate && !self ? <div className="space-y-2"><Label htmlFor={`reason-${policy.id}`}>Review reason (optional)</Label><Input id={`reason-${policy.id}`} value={reason} onChange={e => { key.current = null; setReason(e.target.value); }} maxLength={1000} disabled={pending} /></div> : null}
      <Button variant="outline" disabled={pending || conflict || !canActivate || self || (reason.trim().length > 0 && reason.trim().length < 3)} onClick={() => setConfirm(true)}>Activate policy</Button>
      {conflict ? <Button variant="outline" disabled={pending} onClick={() => router.refresh()}>Reload current policy</Button> : null}
    </div> : <p className="border-t pt-4 text-sm text-muted-foreground">Active definition is immutable. Existing document submissions will retain their own policy snapshot.</p>}
    {policy.deliveryJobId ? <Button variant="outline" asChild><Link href={`/workspace/jobs?org=${policy.organizationId}&entity=${policy.entityId}&job=${policy.deliveryJobId}`}>Delivery job</Link></Button> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Activate this approval policy?</AlertDialogTitle><AlertDialogDescription>This immutable definition will govern submissions for its protected actions and effective dates. Activation does not post money or activate statutory rules. Existing submission snapshots are unaffected.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel review</AlertDialogCancel><AlertDialogAction onClick={() => void activate()}>Confirm activation</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </CardContent></Card>;
}
