"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
const selectClass = "h-10 w-full rounded-md border bg-background px-3 text-sm";
export function RuleForm({ url, base, demoAllowed }: { url: string; base: string; demoAllowed: boolean }) {
  const router = useRouter(), requestKey = useRef<string | null>(null);
  const [kind, setKind] = useState("sales_tax"), [method, setMethod] = useState("percentage"), [pending, setPending] = useState(false), [error, setError] = useState("");
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return; setPending(true); setError("");
    const data = new FormData(event.currentTarget), field = (name: string) => String(data.get(name) ?? "");
    const definition = method === "percentage" ? { method, rate: field("rate"), basis: field("basis"), rounding: "half_up_line", inputCredit: kind === "sales_tax" ? "not_applicable" : field("inputCredit") }
      : { method, treatment: field("treatment"), rounding: "half_up_line", inputCredit: "not_applicable" };
    try {
      requestKey.current ??= crypto.randomUUID();
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey.current },
        body: JSON.stringify({ kind, applicability: { event: kind === "sales_tax" ? "invoice" : "bill", taxCode: field("taxCode") }, effectiveFrom: field("effectiveFrom"),
          ...(field("effectiveTo") ? { effectiveTo: field("effectiveTo") } : {}), definition, demoOnly: demoAllowed && field("demoOnly") === "true",
          sourceReferences: [{ title: field("sourceTitle"), url: field("sourceUrl"), section: field("sourceSection"), sha256: field("sourceHash") }] }) });
      const payload = await response.json();
      if (!response.ok) {
        setError([payload.error?.message ?? "Could not save the draft.", ...(payload.error?.fieldErrors ?? []).map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`)].join(" ")); return;
      }
      requestKey.current = null; router.push(`${base}&rule=${payload.data.id}`); router.refresh();
    } catch { setError("Could not reach the server. Retry without changing the form to retain the same request key."); }
    finally { setPending(false); }
  }
  return <Card><CardContent className="pt-6"><h2 className="text-xl font-medium">Create a rule draft</h2><p className="mt-2 text-sm text-muted-foreground">Immutable, unverified definition. Source references are recorded, not fetched or certified. A new draft does not enable posting.</p>
    <form onSubmit={create} onChange={() => { requestKey.current = null; }} className="mt-5 space-y-4"><fieldset disabled={pending} className="min-w-0 space-y-4">
      <div className="space-y-2"><Label htmlFor="rule-kind">Rule kind</Label><select id="rule-kind" className={selectClass} value={kind} onChange={event => setKind(event.target.value)}><option value="sales_tax">Sales tax · invoices</option><option value="purchase_tax">Purchase tax · bills</option></select></div>
      <div className="space-y-2"><Label htmlFor="taxCode">Tax code</Label><Input id="taxCode" name="taxCode" required maxLength={40} pattern="[A-Z][A-Z0-9_-]{0,39}" placeholder="DEMO_OUTPUT" /><p className="text-xs text-muted-foreground">Exact uppercase applicability code, not a wildcard or expression.</p></div>
      <div className="space-y-2"><Label htmlFor="effectiveFrom">Effective from (AD)</Label><Input id="effectiveFrom" name="effectiveFrom" type="date" min="1900-01-01" max="9999-12-31" required /></div>
      <div className="space-y-2"><Label htmlFor="effectiveTo">Exclusive end date (AD, optional)</Label><Input id="effectiveTo" name="effectiveTo" type="date" min="1900-01-01" max="9999-12-31" /></div>
      <div className="space-y-2"><Label htmlFor="rule-method">Calculation method</Label><select id="rule-method" className={selectClass} value={method} onChange={event => setMethod(event.target.value)}><option value="percentage">Percentage</option><option value="no_tax">Explicit no-tax treatment</option></select></div>
      {method === "percentage" ? <><div className="space-y-2"><Label htmlFor="rate">Rate (%)</Label><Input id="rate" name="rate" required inputMode="decimal" maxLength={12} placeholder="Enter the draft rate" /></div><div className="space-y-2"><Label htmlFor="basis">Tax basis</Label><select id="basis" name="basis" className={selectClass}><option value="exclusive">Tax exclusive</option><option value="inclusive">Tax inclusive</option></select></div>{kind === "purchase_tax" ? <div className="space-y-2"><Label htmlFor="inputCredit">Input tax credit</Label><select id="inputCredit" name="inputCredit" className={selectClass} defaultValue="" required><option value="" disabled>Choose eligibility explicitly</option><option value="eligible">Eligible</option><option value="ineligible">Ineligible</option></select></div> : null}</> : <div className="space-y-2"><Label htmlFor="treatment">No-tax treatment</Label><select id="treatment" name="treatment" className={selectClass} defaultValue="" required><option value="" disabled>Choose treatment explicitly</option><option value="zero_rated">Zero rated</option><option value="exempt">Exempt</option><option value="out_of_scope">Out of scope</option></select></div>}
      <p className="text-xs text-muted-foreground">NPR · half-up rounding per line · evaluator tax-line-v1. No thresholds, scripts or payroll formulas are supported here.</p>
      <div className="space-y-2"><Label htmlFor="demoOnly">Draft profile</Label><select id="demoOnly" name="demoOnly" className={selectClass} defaultValue={demoAllowed ? "true" : "false"}>{demoAllowed ? <option value="true">Synthetic demo only · not law</option> : null}<option value="false">Review required · not verified</option></select></div>
      <div className="space-y-2"><Label htmlFor="sourceTitle">Source title</Label><Input id="sourceTitle" name="sourceTitle" required maxLength={300} placeholder="Label synthetic fixtures explicitly" /></div>
      <div className="space-y-2"><Label htmlFor="sourceUrl">Source URL</Label><Input id="sourceUrl" name="sourceUrl" type="url" required maxLength={2000} placeholder="https://…" /></div>
      <div className="space-y-2"><Label htmlFor="sourceSection">Source section</Label><Input id="sourceSection" name="sourceSection" required maxLength={500} /></div>
      <div className="space-y-2"><Label htmlFor="sourceHash">Source SHA-256</Label><Input id="sourceHash" name="sourceHash" required minLength={64} maxLength={64} pattern="[a-f0-9]{64}" className="font-mono text-xs" /><p className="text-xs text-muted-foreground">Fingerprint of the captured source. Merely entering it does not verify the source.</p></div>
      {error ? <p role="alert" className="break-words text-sm text-destructive">{error}</p> : null}<Button type="submit" disabled={pending} className="w-full">{pending ? "Saving draft…" : "Create draft"}</Button>
    </fieldset></form></CardContent></Card>;
}
