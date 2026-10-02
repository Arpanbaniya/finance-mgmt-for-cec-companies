"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { approvalPermissions, type AggregateType } from "@/domain/approval-policy";
import { ApprovalPolicyCreate } from "./contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Range = { id: number; minInclusive: string; maxExclusive: string; count: string };
export function PolicyForm({ url, today }: { url: string; today: string }) {
  const router = useRouter(), key = useRef<string | null>(null), sequence = useRef(1);
  const [aggregate, setAggregate] = useState<AggregateType>("journal"), [ranges, setRanges] = useState<Range[]>([{ id: 0, minInclusive: "0.00", maxExclusive: "", count: "1" }]);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  function changeRange(id: number, field: keyof Omit<Range, "id">, value: string) { key.current = null; setRanges(rows => rows.map(row => row.id === id ? { ...row, [field]: value } : row)); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form); setError(""); setNotice("");
    const parsed = ApprovalPolicyCreate.safeParse({ name: values.get("name"), effectiveFrom: values.get("effectiveFrom"), ...(values.get("effectiveTo") ? { effectiveTo: values.get("effectiveTo") } : {}),
      aggregateTypes: [aggregate], currency: "NPR", makerChecker: true,
      thresholds: ranges.map(row => ({ minInclusive: row.minInclusive, ...(row.maxExclusive ? { maxExclusive: row.maxExclusive } : {}), requiredPermission: approvalPermissions[aggregate], numberOfDistinctApprovers: Number(row.count) })) });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join(" ")); return; }
    setPending(true);
    try {
      key.current ??= crypto.randomUUID();
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current }, body: JSON.stringify(parsed.data) });
      const payload = await response.json();
      if (!response.ok) { setError(payload.error?.message ?? "The draft could not be saved."); return; }
      form.reset(); key.current = null; setRanges([{ id: sequence.current++, minInclusive: "0.00", maxExclusive: "", count: "1" }]); setNotice("Draft saved. A different designated reviewer must activate it."); router.refresh();
    } catch { setError("The server response was not confirmed. Retry unchanged to reuse the same key."); }
    finally { setPending(false); }
  }
  return <Card><CardContent className="pt-6"><h2 className="text-lg font-medium">Create an approval policy</h2><p className="my-3 text-sm leading-6 text-muted-foreground">Draft definitions cannot be edited. Review the complete amount ranges and dates before saving. This controls independent review, not tax or payroll rules.</p>
    <form aria-label="Create approval policy" onSubmit={save} onChange={() => { key.current = null; }} className="space-y-5">
      <fieldset disabled={pending} className="space-y-5">
        <div className="space-y-2"><Label htmlFor="policy-name">Policy name</Label><Input id="policy-name" name="name" required maxLength={200} /></div>
        <div className="space-y-2"><Label htmlFor="policy-type">Protected action</Label><Select value={aggregate} onValueChange={value => { key.current = null; setAggregate(value as AggregateType); }} disabled={pending}><SelectTrigger id="policy-type" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{Object.keys(approvalPermissions).map(type => <SelectItem key={type} value={type}>{type.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="policy-from">Effective from</Label><Input id="policy-from" name="effectiveFrom" type="date" defaultValue={today} required min="1900-01-01" max="9999-12-31" /></div><div className="space-y-2"><Label htmlFor="policy-to">Effective to (exclusive)</Label><Input id="policy-to" name="effectiveTo" type="date" min="1900-01-01" max="9999-12-31" /><p className="text-xs text-muted-foreground">Leave blank for no end date.</p></div></div>
        <div className="space-y-3"><h3 className="text-sm font-medium">NPR thresholds · {approvalPermissions[aggregate]}</h3><p className="text-xs leading-5 text-muted-foreground">Start at zero, with no gaps or overlaps. Leave the last upper bound blank. At least one distinct checker is always required.</p>
          {ranges.map((row, index) => <div key={row.id} className="space-y-3 rounded-lg border p-3"><div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2"><Label htmlFor={`min-${row.id}`}>Range {index + 1} minimum</Label><Input id={`min-${row.id}`} inputMode="decimal" value={row.minInclusive} onChange={e => changeRange(row.id, "minInclusive", e.target.value)} required /></div>
            <div className="space-y-2"><Label htmlFor={`max-${row.id}`}>Range {index + 1} upper bound</Label><Input id={`max-${row.id}`} inputMode="decimal" placeholder="Unbounded" value={row.maxExclusive} onChange={e => changeRange(row.id, "maxExclusive", e.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor={`count-${row.id}`}>Range {index + 1} checkers</Label><Input id={`count-${row.id}`} type="number" min={1} max={10} step={1} required value={row.count} onChange={e => changeRange(row.id, "count", e.target.value)} /></div>
          </div>{ranges.length > 1 ? <Button type="button" size="sm" variant="outline" onClick={() => { key.current = null; setRanges(rows => rows.filter(r => r.id !== row.id)); }}>Remove range {index + 1}</Button> : null}</div>)}
          <Button type="button" variant="outline" disabled={ranges.length >= 50} onClick={() => { key.current = null; setRanges(rows => [...rows, { id: sequence.current++, minInclusive: rows.at(-1)?.maxExclusive ?? "", maxExclusive: "", count: "1" }]); }}>Add threshold range</Button>
        </div>
      </fieldset>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{notice ? <p role="status" className="text-sm">{notice}</p> : null}
      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save policy draft"}</Button>
    </form></CardContent></Card>;
}
