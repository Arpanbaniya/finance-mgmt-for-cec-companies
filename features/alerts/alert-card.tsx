"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import type { AlertDTO } from "./contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AlertCard({ alert, url }: { alert: z.infer<typeof AlertDTO>; url: string }) {
  const router = useRouter(), key = useRef<string | null>(null);
  const [reason, setReason] = useState(""), [pending, setPending] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  async function acknowledge(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    try {
      key.current ??= crypto.randomUUID();
      const response = await fetch(`${url}/${alert.id}/acknowledge`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": `"${alert.version}"`, "Idempotency-Key": key.current }, body: JSON.stringify({ reason: reason.trim() }) });
      const payload = await response.json();
      if (!response.ok) { setConflict(response.status === 412); setError(payload.error?.message ?? "Acknowledgement could not be confirmed."); return; }
      router.refresh();
    } catch { setError("The response was not confirmed. Retry unchanged to reuse the same key."); }
    finally { setPending(false); }
  }
  return <Card aria-label={`Policy activation notification ${alert.policyId}`}><CardContent className="space-y-3 pt-6">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">Your policy was activated</h3><Badge variant="outline">{alert.acknowledgedAt ? "Acknowledged" : "Unread"}</Badge></div>
    <p className="break-all text-xs text-muted-foreground">Policy {alert.policyId}</p><time className="block text-xs text-muted-foreground" dateTime={alert.createdAt}>{alert.createdAt}</time>
    <p className="text-sm text-muted-foreground">An independent reviewer activated your definition. This notification does not authorize or post a financial document.</p>
    {alert.acknowledgedAt ? <time className="text-xs" dateTime={alert.acknowledgedAt}>Acknowledged {alert.acknowledgedAt}</time> : <form onSubmit={acknowledge} className="space-y-3" aria-label="Acknowledge policy notification">
      <Label htmlFor={`alert-reason-${alert.id}`}>Acknowledgement reason</Label><Input id={`alert-reason-${alert.id}`} value={reason} onChange={event => { key.current = null; setReason(event.target.value); }} minLength={3} maxLength={1000} required disabled={pending} />
      <Button type="submit" variant="outline" disabled={pending || conflict || reason.trim().length < 3}>{pending ? "Saving…" : "Acknowledge notification"}</Button>
    </form>}
    {conflict ? <Button variant="outline" disabled={pending} onClick={() => router.refresh()}>Reload notifications</Button> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </CardContent></Card>;
}
