"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { purposeRules, matchesPurpose, type AccountPurpose } from "@/domain/finance-setup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
export type SetupAccount = { id: string; code: string; name: string; type: string; controlType: string | null; active: boolean };
export type SetupMappings = { version: number; selections: { purpose: AccountPurpose; accountId: string }[] };
function AccountChoice({ id, label, purpose, value, onChange, accounts, disabled }: { id: string; label: string; purpose: AccountPurpose; value: string; onChange: (value: string) => void; accounts: SetupAccount[]; disabled: boolean }) {
  const eligible = accounts.filter(account => matchesPurpose(purpose, account));
  return <div className="min-w-0 space-y-2">
    <Label htmlFor={id}>{label}</Label>
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full min-w-0"><SelectValue placeholder="Choose account" className="min-w-0 truncate" /></SelectTrigger>
      <SelectContent className="max-w-[calc(100vw-2rem)]">
        {eligible.map(account => <SelectItem key={account.id} value={account.id} className="break-all whitespace-normal">{account.code} · {account.name}</SelectItem>)}
        {value && !eligible.some(account => account.id === value) ? <SelectItem value={value} className="break-all whitespace-normal">Current reference · {value}</SelectItem> : null}
      </SelectContent>
    </Select>
    <p className="text-xs text-muted-foreground">{purposeRules[purpose][0]} · {purposeRules[purpose][1]?.replaceAll("_", " ") ?? "ordinary account"}</p>
  </div>;
}
function errorMessage(payload: { error?: { message?: string; fieldErrors?: { message: string }[] } }) { return payload.error?.fieldErrors?.map(field => field.message).join(" ") || payload.error?.message || "The save was not confirmed."; }
export function FinanceSetupForms({ base, initialAccounts, nextCursor, mappings }: { base: string; initialAccounts: SetupAccount[]; nextCursor: string | null; mappings: SetupMappings }) {
  const [accounts, setAccounts] = useState(initialAccounts), [cursor, setCursor] = useState(nextCursor), [loading, setLoading] = useState(false), [error, setError] = useState("");
  async function moreAccounts() {
    if (!cursor || loading) return; setLoading(true); setError("");
    try {
      const response = await fetch(`${base}/accounts?limit=100&cursor=${cursor}`, { cache: "no-store" }), payload = await response.json();
      if (!response.ok) { setError(errorMessage(payload)); return; }
      setAccounts(previous => [...new Map([...previous, ...payload.data].map(account => [account.id, account])).values()] as SetupAccount[]); setCursor(payload.meta.nextCursor);
    } catch { setError("Could not load more accounts. Try again when connected."); } finally { setLoading(false); }
  }
  return <div className="space-y-6">{cursor ? <div className="space-y-2"><p className="text-sm text-muted-foreground">Load additional chart accounts if a required account is missing from the choices.</p><Button variant="outline" onClick={() => void moreAccounts()} disabled={loading}>{loading ? "Loading…" : "Load more account choices"}</Button></div> : null}{error ? <p role="alert">{error}</p> : null}<FiscalYearForm base={base} accounts={accounts} /><MappingForm key={mappings.version} base={base} accounts={accounts} mappings={mappings} /></div>;
}
function FiscalYearForm({ base, accounts }: { base: string; accounts: SetupAccount[] }) {
  const router = useRouter(), key = useRef<string | null>(null);
  const [periods, setPeriods] = useState([{ key: "period-1", startDate: "", endDateExclusive: "" }]), [retained, setRetained] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  function changed() { key.current = null; setSaved(false); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return; setPending(true); setError(""); setSaved(false); const form = event.currentTarget;
    try {
      key.current ??= crypto.randomUUID(); const fields = new FormData(form);
      const response = await fetch(`${base}/fiscal-years`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current }, body: JSON.stringify({ fiscalYearLabel: fields.get("label"), retainedEarningsAccountId: retained, periods: periods.map(({ startDate, endDateExclusive }) => ({ startDate, endDateExclusive })) }) });
      const payload = await response.json(); if (!response.ok) { setError(errorMessage(payload)); return; }
      form.reset(); setPeriods([{ key: "period-1", startDate: "", endDateExclusive: "" }]); setRetained(""); key.current = null; setSaved(true); router.refresh();
    } catch { setError("The response was not confirmed. Retry unchanged to reuse the same request key."); } finally { setPending(false); }
  }
  return <Card><CardContent className="space-y-4 pt-6"><h2 className="text-xl font-medium">Create fiscal year</h2><p className="text-sm text-muted-foreground">Enter actual AD dates. End dates are exclusive. The saved calendar and retained-earnings account version are preserved.</p><form aria-label="Create fiscal year" onSubmit={save} onChange={changed} className="space-y-4"><div className="space-y-2"><Label htmlFor="fiscal-label">Fiscal year label</Label><Input id="fiscal-label" name="label" required maxLength={100} disabled={pending} /></div><AccountChoice id="fiscal-retained" label="Retained earnings account" purpose="retained_earnings" value={retained} onChange={value => { changed(); setRetained(value); }} accounts={accounts} disabled={pending} />
    {periods.map((period, index) => <fieldset key={period.key} className="space-y-3 rounded-lg border p-4"><legend className="px-1 text-sm">Period {index + 1}</legend><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${period.key}-start`}>Period {index + 1} start date</Label><Input id={`${period.key}-start`} type="date" required value={period.startDate} disabled={pending} onChange={event => { changed(); setPeriods(previous => previous.map(item => item.key === period.key ? { ...item, startDate: event.target.value } : item)); }} /></div><div className="space-y-2"><Label htmlFor={`${period.key}-end`}>Period {index + 1} exclusive end date</Label><Input id={`${period.key}-end`} type="date" required value={period.endDateExclusive} disabled={pending} onChange={event => { changed(); setPeriods(previous => previous.map(item => item.key === period.key ? { ...item, endDateExclusive: event.target.value } : item)); }} /></div></div>{periods.length > 1 ? <Button type="button" variant="outline" disabled={pending} onClick={() => { changed(); setPeriods(previous => previous.filter(item => item.key !== period.key)); }}>Remove period {index + 1}</Button> : null}</fieldset>)}
    <Button type="button" variant="outline" disabled={pending || periods.length >= 24} onClick={() => { changed(); setPeriods(previous => [...previous, { key: crypto.randomUUID(), startDate: previous.at(-1)!.endDateExclusive, endDateExclusive: "" }]); }}>Add period</Button>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{saved ? <p role="status">Fiscal year saved.</p> : null}<div><Button disabled={pending || !retained}>{pending ? "Saving…" : "Save fiscal year"}</Button></div></form></CardContent></Card>;
}
function MappingForm({ base, accounts, mappings }: { base: string; accounts: SetupAccount[]; mappings: SetupMappings }) {
  const router = useRouter(); const [selection, setSelection] = useState<Record<string, string>>(() => Object.fromEntries(mappings.selections.map(entry => [entry.purpose, entry.accountId])));
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return; setPending(true); setError(""); const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${base}/account-mappings`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": `"${mappings.version}"` }, body: JSON.stringify({ effectiveFrom: form.get("effective"), reason: form.get("reason"), mappings: Object.keys(purposeRules).map(purpose => ({ purpose, accountId: selection[purpose] ?? "" })) }) });
      const payload = await response.json(); if (!response.ok) { setConflict(response.status === 412); setError(errorMessage(payload)); return; } router.refresh();
    } catch { setError("The save was not confirmed. Reload mappings to check the current version before retrying."); } finally { setPending(false); }
  }
  return <Card><CardContent className="space-y-4 pt-6">
    <h2 className="text-xl font-medium">Account-purpose mappings</h2>
    <p className="text-sm text-muted-foreground">Version {mappings.version}. Choose an account for every R1 posting purpose. One account may serve compatible purposes. Saving records a new effective-dated version and preserves previous selections.</p>
    <form aria-label="Account-purpose mappings" onSubmit={save} className="space-y-4">
      <div className="space-y-2"><Label htmlFor="mapping-effective">Mappings effective from</Label><Input id="mapping-effective" name="effective" type="date" required disabled={pending} /><p className="text-xs text-muted-foreground">After initial setup, dates must follow the latest version and cannot precede today.</p></div>
      <div className="space-y-2"><Label htmlFor="mapping-reason">Mapping reason</Label><Input id="mapping-reason" name="reason" required minLength={3} maxLength={1000} disabled={pending} /></div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{Object.keys(purposeRules).map(purpose => <AccountChoice key={purpose} id={`purpose-${purpose}`} label={purpose.replaceAll("_", " ")} purpose={purpose as AccountPurpose} value={selection[purpose] ?? ""} onChange={value => setSelection(previous => ({ ...previous, [purpose]: value }))} accounts={accounts} disabled={pending} />)}</div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2"><Button disabled={pending || conflict}>{pending ? "Saving…" : "Save mapping version"}</Button>{conflict ? <Button type="button" variant="outline" onClick={() => router.refresh()}>Reload current mappings</Button> : null}</div>
    </form>
  </CardContent></Card>;
}
