"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import type { JobDTO } from "./contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

export function JobCard({ job }: { job: z.infer<typeof JobDTO> }) {
  const router = useRouter(), key = useRef<string | null>(null);
  const [reason, setReason] = useState(""), [pending, setPending] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  async function retry() {
    if (pending) return;
    setPending(true); setError("");
    try {
      key.current ??= crypto.randomUUID();
      const response = await fetch(`/api/v1/orgs/${job.organizationId}/entities/${job.entityId}/jobs/${job.id}/retry`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": `"${job.version}"`, "Idempotency-Key": key.current }, body: JSON.stringify({ reason: reason.trim() }) });
      const payload = await response.json();
      if (!response.ok) { setConflict(response.status === 412); setError(payload.error?.message ?? "Retry could not be confirmed."); return; }
      router.refresh();
    } catch { setError("The response was not confirmed. Retry unchanged to reuse the same key."); }
    finally { setPending(false); }
  }
  return <Card aria-label="Delivery job"><CardContent className="space-y-5 pt-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-medium">Policy activation notification</h2><Badge variant="outline">{job.status}</Badge></div>
    <p className="text-sm text-muted-foreground">This job creates one private in-app alert. Reload to see worker progress. It does not send email or post money.</p>
    <dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Delivered items</dt><dd>{job.completedItems} / {job.totalItems}</dd></div><div><dt className="text-muted-foreground">Lifetime attempts</dt><dd>{job.totalAttempts} / 12</dd></div><div><dt className="text-muted-foreground">Attempts in current cycle</dt><dd>{job.attempts} / 3</dd></div><div><dt className="text-muted-foreground">Manual recovery cycles</dt><dd>{job.retryCount} / {job.maxRetries}</dd></div><div><dt className="text-muted-foreground">Version</dt><dd>{job.version}</dd></div><div><dt className="text-muted-foreground">Last error</dt><dd className="break-all">{job.errorCode ?? "None"}</dd></div></dl>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Immutable source and timing</summary><dl className="mt-3 space-y-2 break-all"><dt>Job ID</dt><dd>{job.id}</dd><dt>Policy ID</dt><dd>{job.sourceId}</dd><dt>Policy version</dt><dd>{job.sourceVersion}</dd><dt>Input hash</dt><dd>{job.inputHash}</dd><dt>Created</dt><dd>{job.createdAt}</dd><dt>Updated</dt><dd>{job.updatedAt}</dd><dt>Available</dt><dd>{job.availableAt}</dd><dt>Lease expires</dt><dd>{job.leaseExpiresAt ?? "No active lease"}</dd><dt>Completed</dt><dd>{job.completedAt ?? "Not completed"}</dd></dl></details>
    {job.status === "failed" && job.retryCount < job.maxRetries ? <div className="space-y-3 border-t pt-4"><Label htmlFor="job-reason">Recovery reason</Label><Input id="job-reason" value={reason} minLength={3} maxLength={1000} required disabled={pending} onChange={event => { key.current = null; setReason(event.target.value); }} /><Button disabled={pending || conflict || reason.trim().length < 3} onClick={() => setConfirm(true)}>{pending ? "Queueing…" : "Retry failed job"}</Button></div> : <p className="border-t pt-4 text-sm text-muted-foreground">{job.status === "failed" ? "Manual recovery limit reached. This job cannot be requeued." : job.status === "pending" || job.status === "leased" ? "Delivery is queued or in progress. The scoped worker must process it; this page cannot run the worker." : "Completed and cancelled jobs cannot be reopened."}</p>}
    <Button variant="outline" disabled={pending} onClick={() => router.refresh()}>{conflict ? "Reload current job" : "Reload status"}</Button>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {job.retryHistory.length ? <section className="space-y-3 border-t pt-4" aria-label="Recovery history"><h3 className="font-medium">Recovery history</h3><ol className="space-y-3">{job.retryHistory.map(entry => <li key={entry.fromVersion} className="rounded-md bg-muted p-3 text-sm"><p className="break-words">{entry.reason}</p><p className="mt-2 break-all text-xs text-muted-foreground">Version {entry.fromVersion} · {entry.createdAt} · Request {entry.requestId}</p></li>)}</ol></section> : null}
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Retry this failed delivery?</AlertDialogTitle><AlertDialogDescription>Your reason is retained in immutable recovery history. This queues a new bounded delivery cycle and preserves previous attempts. It does not perform delivery in this request.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancel recovery</AlertDialogCancel><AlertDialogAction disabled={pending} onClick={() => void retry()}>Confirm retry</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </CardContent></Card>;
}
