import Link from "next/link";
import type { z } from "zod";
import type { EntityDTO } from "@/features/platform/contracts";
import type { ApprovalPolicyDTO, AuditEventDTO, AuditQuery } from "./contracts";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PolicyForm } from "./policy-form";
import { PolicyCard } from "./policy-card";
import type { AlertDTO } from "@/features/alerts/contracts";
import { AlertCard } from "@/features/alerts/alert-card";

type Props = { entity: z.infer<typeof EntityDTO>; policies: z.infer<typeof ApprovalPolicyDTO>[]; policyCursor: string | null; currentUserId: string; today: string; canCreate: boolean; canActivate: boolean;
  audit: { data: z.infer<typeof AuditEventDTO>[]; nextCursor: string | null } | null; auditQuery: z.infer<typeof AuditQuery>; alerts: { data: z.infer<typeof AlertDTO>[]; nextCursor: string | null }; paginated: boolean };
export function ControlsWorkspace({ entity, policies, policyCursor, currentUserId, today, canCreate, canActivate, audit, auditQuery, alerts, paginated }: Props) {
  const url = `/api/v1/orgs/${entity.organizationId}/entities/${entity.id}/approval-policies`;
  const base = `/workspace/controls?org=${entity.organizationId}&entity=${entity.id}`;
  const filters = new URLSearchParams(Object.entries(auditQuery).filter(([key, value]) => key !== "limit" && key !== "cursor" && typeof value === "string") as [string, string][]).toString();
  return <main className="mx-auto max-w-6xl px-5 py-8 sm:px-10"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-6"><Brand /><Button variant="outline" asChild><Link href="/workspace">Back to workspace</Link></Button></header>
    <div className="py-8"><Badge variant="outline">Entity controls</Badge><h1 className="mt-4 text-3xl font-medium">Approval policies and audit</h1><p className="mt-3 break-words text-muted-foreground">{entity.name} · Independent review, immutable definitions and scoped history.</p><p className="mt-2 text-sm text-muted-foreground">Financial document submission and posting are still under development. These policies alone do not enable live bookkeeping.</p></div>
    <div className="grid items-start gap-6 lg:grid-cols-2"><section aria-label="Approval policies" className="space-y-4"><h2 className="text-lg font-medium">Policy register</h2>{policies.length ? policies.map(policy => <PolicyCard key={`${policy.id}-${policy.version}`} policy={policy} url={url} currentUserId={currentUserId} canActivate={canActivate} />) : <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No policy drafts or active definitions on this page.</p>}
      {policyCursor ? <Button variant="outline" asChild><Link href={`${base}&policyCursor=${policyCursor}${filters ? `&${filters}` : ""}`}>Next policies</Link></Button> : null}
    </section>{canCreate ? <PolicyForm url={url} today={today} /> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">Only an organization administrator or finance manager can create a draft. The separate policy reviewer grant does not authorize drafting or transaction approval.</CardContent></Card>}</div>
    <section aria-label="Your policy notifications" className="mt-10 space-y-4 border-t pt-6"><h2 className="text-xl font-medium">Your policy notifications</h2><p className="text-sm text-muted-foreground">Private in-app alerts for your policy drafts. Delivery requires the scoped outbox worker; this page does not send email.</p>
      {alerts.data.length ? <div className="grid gap-4 sm:grid-cols-2">{alerts.data.map(alert => <AlertCard key={`${alert.id}-${alert.version}`} alert={alert} url={`/api/v1/orgs/${entity.organizationId}/entities/${entity.id}/alerts`} />)}</div> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">No delivered notifications on this page. An activated policy may still have a queued notification.</CardContent></Card>}
      {alerts.nextCursor ? <Button variant="outline" asChild><Link href={`${base}&alertCursor=${alerts.nextCursor}`}>Next notifications</Link></Button> : null}
    </section>
    {audit ? <section aria-label="Entity audit history" className="mt-10 space-y-4 border-t pt-6"><h2 className="text-xl font-medium">Entity audit history</h2><p className="text-sm text-muted-foreground">Append-only event metadata. Organization-wide membership changes and private change values are excluded.</p>
      <form action="/workspace/controls" className="flex flex-wrap items-end gap-3" aria-label="Filter audit history"><input type="hidden" name="org" value={entity.organizationId} /><input type="hidden" name="entity" value={entity.id} />
        <div className="space-y-2"><Label htmlFor="audit-action">Action</Label><Input id="audit-action" name="action" defaultValue={auditQuery.action ?? ""} placeholder="approval_policy.activate" /></div><Button type="submit">Filter history</Button><Button asChild variant="outline"><Link href={base}>Clear filters</Link></Button>
      </form>
      {audit.data.length ? <ol className="grid gap-3 sm:grid-cols-2">{audit.data.map(event => <li key={event.id} className="min-w-0 space-y-2 rounded-lg border p-4 text-sm"><p className="font-medium">{event.action}</p><time className="text-xs text-muted-foreground" dateTime={event.occurredAt}>{event.occurredAt}</time><dl className="space-y-1 break-all text-xs text-muted-foreground"><dt>Actor</dt><dd>{event.actorId}</dd><dt>Target</dt><dd>{event.targetId}</dd><dt>Request</dt><dd>{event.requestId}</dd></dl></li>)}</ol> : <p className="rounded-lg border p-5 text-sm text-muted-foreground">No matching audit events.</p>}
      {audit.nextCursor ? <Button variant="outline" asChild><Link href={`${base}&cursor=${audit.nextCursor}${filters ? `&${filters}` : ""}`}>Next audit events</Link></Button> : null}
    </section> : null}{paginated ? <div className="mt-6"><Button variant="outline" asChild><Link href={base}>First page</Link></Button></div> : null}
  </main>;
}
