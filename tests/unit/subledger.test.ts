import { describe, expect, it } from "vitest";
import { appendAllocationEvents, subledgerAt, validateSubledgerHistory, type SubledgerHistoryInput, type AllocationEventInput } from "@/domain/subledger";
import { money, Exact } from "@/domain/money";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = (day: string, micro = "000001") => `${day}T12:00:00.${micro}Z`;
const org = id(1), entity = id(2), party = id(3), control = id(4);
function line(n: number, date: string, amount: string, side: "debit" | "credit", patch: Record<string, unknown> = {}) {
  return { organizationId: org, entityId: entity, currency: "NPR" as const, journalId: id(n), ordinal: 1,
    sourceType: "settlement" as const, sourceId: id(n + 1000), eventKind: "post" as const,
    postingDate: date, recordedAt: instant(date), accountId: control, accountVersion: 1, controlType: "ar" as const,
    debit: side === "debit" ? amount : "0.00", credit: side === "credit" ? amount : "0.00", ...patch };
}
function fixture(): SubledgerHistoryInput {
  return { organizationId: org, entityId: entity, currency: "NPR", openItems: [{ id: id(10), side: "ar", partyId: party,
    amount: "3000.00", documentDate: "2026-01-01", dueDate: "2026-01-31",
    line: line(100, "2026-01-01", "3000.00", "debit", { sourceType: "invoice" }) }],
  settlements: [{ id: id(20), side: "ar", partyId: party, mode: "on_account", amount: "5000.00",
    line: line(200, "2026-01-10", "5000.00", "credit", { sourceId: id(20), controlType: "customer_deposits", accountId: id(5) }) }], events: [] };
}
function application(n = 30, amount = "3000.00", date = "2026-02-01"): AllocationEventInput {
  return { kind: "apply", id: id(n), sourceSettlementId: id(20), targetOpenItemId: id(10), amount,
    effectiveDate: date, recordedAt: instant(date), line: line(n + 300, date, amount, "credit") };
}
function reversal(original: AllocationEventInput, n = 40, date = "2026-03-01"): AllocationEventInput {
  if (original.kind !== "apply") throw new Error("Fixture requires an application");
  return { kind: "reverse", id: id(n), reversalOf: original.id, effectiveDate: date, recordedAt: instant(date),
    line: line(n + 300, date, original.amount, "debit", { eventKind: "reverse" }) };
}
const cutoff = (asOfDate = "2026-12-31", knownAt = instant("2026-12-31", "999999")) => ({ asOfDate, knownAt });
function expectCode(run: () => unknown, code: string) { expect(run).toThrow(expect.objectContaining({ code })); }

describe("exact source-linked subledger history", () => {
  it("keeps an unapplied deposit separate from an invoice, without silent netting", () => {
    const result = subledgerAt(fixture(), cutoff("2026-01-31"));
    expect(result.openItems).toEqual([{ id: id(10), partyId: party, side: "ar", dueDate: "2026-01-31",
      originalAmount: "3000.00", allocatedAmount: "0.00", outstandingAmount: "3000.00", status: "open" }]);
    expect(result.settlements[0]).toMatchObject({ originalAmount: "5000.00", allocatedAmount: "0.00", unappliedAmount: "5000.00" });
  });
  it("reconstructs the independent deposit/application fixture at inclusive business dates", () => {
    const history = appendAllocationEvents(fixture(), [application()]);
    expect(subledgerAt(history, cutoff("2026-01-31")).openItems[0].outstandingAmount).toBe("3000.00");
    expect(subledgerAt(history, cutoff("2026-02-01")).openItems[0]).toMatchObject({ outstandingAmount: "0.00", status: "settled" });
    expect(subledgerAt(history, cutoff()).settlements[0].unappliedAmount).toBe("2000.00");
  });
  it("hides future origins as well as future allocations", () => {
    expect(subledgerAt(fixture(), cutoff("2025-12-31")).openItems).toEqual([]);
    expect(subledgerAt(fixture(), cutoff("2026-01-05")).settlements).toEqual([]);
  });
  it("preserves what was known at close, including exact microsecond boundaries", () => {
    const a = application(); a.recordedAt = instant("2026-02-15", "123456"); a.line.recordedAt = a.recordedAt;
    const history = appendAllocationEvents(fixture(), [a]);
    expect(subledgerAt(history, cutoff("2026-02-01", instant("2026-02-15", "123455"))).openItems[0].outstandingAmount).toBe("3000.00");
    expect(subledgerAt(history, cutoff("2026-02-01", instant("2026-02-15", "123456"))).openItems[0].outstandingAmount).toBe("0.00");
  });
  it("reopens balances through append-only dated inverse evidence, preserving earlier cut-offs", () => {
    const a = application(), r = reversal(a), history = appendAllocationEvents(fixture(), [a, r]);
    expect(subledgerAt(history, cutoff("2026-02-28")).openItems[0].outstandingAmount).toBe("0.00");
    expect(subledgerAt(history, cutoff("2026-03-01")).openItems[0].outstandingAmount).toBe("3000.00");
    expect(subledgerAt(history, cutoff("2026-03-01", instant("2026-02-28"))).openItems[0].outstandingAmount).toBe("0.00");
    expect(subledgerAt(history, cutoff()).settlements[0].unappliedAmount).toBe("5000.00");
  });
  it("derives partial state and never mutates or sorts its caller's records", () => {
    const history = fixture(), before = structuredClone(history), a = application(30, "1000.01");
    const appended = appendAllocationEvents(history, [a]);
    expect(history).toEqual(before); expect(history.events).toHaveLength(0); expect(appended.events).toHaveLength(1);
    const frozen = structuredClone(appended); subledgerAt(appended, cutoff()); expect(appended).toEqual(frozen);
    expect(subledgerAt(appended, cutoff()).openItems[0]).toMatchObject({ allocatedAmount: "1000.01", outstandingAmount: "1999.99", status: "partial" });
  });
  it("orders history by business effect rather than input order", () => {
    const a = application(), r = reversal(a), history = { ...fixture(), events: [r, a] };
    expect(subledgerAt(history, cutoff()).openItems[0].outstandingAmount).toBe("3000.00");
  });
  it("handles exact values above JavaScript integer precision", () => {
    const history = fixture(), max = "999999999999999999.99";
    history.openItems[0].amount = max; history.openItems[0].line.debit = max;
    history.settlements[0].amount = max; history.settlements[0].line.credit = max;
    expect(subledgerAt(appendAllocationEvents(history, [application(30, "0.01")]), cutoff()).openItems[0].outstandingAmount).toBe("999999999999999999.98");
  });
  it("rejects over-allocation of the target even if a later reversal masks the final total", () => {
    const a = application(), extra = application(31, "0.01", "2026-02-02");
    expectCode(() => appendAllocationEvents(fixture(), [a, extra, reversal(a)]), "OVER_ALLOCATION");
  });
  it("rejects source over-allocation across multiple targets", () => {
    const history = fixture(); history.openItems.push({ ...structuredClone(history.openItems[0]), id: id(11), line: { ...history.openItems[0].line, journalId: id(101) } });
    const a = application(), b = application(31); if (b.kind === "apply") b.targetOpenItemId = id(11);
    expectCode(() => appendAllocationEvents(history, [a, b]), "OVER_ALLOCATION");
  });
  it("does not let a backdated reuse spend funds released by a later reversal", () => {
    const a = application(), r = reversal(a), b = application(31, "3000.00", "2026-02-15");
    expectCode(() => appendAllocationEvents(fixture(), [a, r, b]), "OVER_ALLOCATION");
    const later = application(31, "3000.00", "2026-03-02");
    expect(subledgerAt(appendAllocationEvents(fixture(), [a, r, later]), cutoff()).openItems[0].outstandingAmount).toBe("0.00");
  });
  it("rejects reuse recorded before the releasing reversal was known", () => {
    const a = application(), r = reversal(a); r.recordedAt = instant("2026-05-01"); r.line.recordedAt = r.recordedAt;
    const reuse = application(31, "3000.00", "2026-03-02");
    expectCode(() => appendAllocationEvents(fixture(), [a, r, reuse]), "OVER_ALLOCATION");
  });
  it("checks every business-date and knowledge rectangle, not just the two complete orders", () => {
    const a = application(30, "3000.00", "2026-02-01"), ra = reversal(a, 40, "2026-02-02");
    const b = application(31, "3000.00", "2026-02-03"), rb = reversal(b, 41, "2026-02-05");
    for (const [event, day] of [[a, "2026-02-03"], [ra, "2026-02-05"], [b, "2026-02-01"], [rb, "2026-02-02"]] as const) {
      event.recordedAt = instant(day); event.line.recordedAt = event.recordedAt;
    }
    // Complete business order A, inverse A, B, inverse B and complete
    // knowledge order B, inverse B, A, inverse A each stay within 3000.
    // At Feb 3 / known Feb 3 both applications appear without either inverse.
    expectCode(() => validateSubledgerHistory({ ...fixture(), events: [a, ra, b, rb] }), "OVER_ALLOCATION");
  });
  it("allows one direct settlement line to allocate exactly across several invoices", () => {
    const h = fixture(); h.openItems.push({ ...structuredClone(h.openItems[0]), id: id(11), line: { ...h.openItems[0].line, journalId: id(101) } });
    h.settlements[0] = { ...h.settlements[0], mode: "direct", amount: "5000.00",
      line: line(200, "2026-02-01", "5000.00", "credit", { sourceId: id(20) }) };
    const a = application(), b = application(31, "2000.00");
    a.line = structuredClone(h.settlements[0].line); b.line = structuredClone(a.line);
    if (b.kind === "apply") b.targetOpenItemId = id(11);
    const result = subledgerAt({ ...h, events: [b, a] }, cutoff());
    expect(result.openItems.map(item => item.outstandingAmount)).toEqual(["0.00", "1000.00"]);
    expect(result.settlements[0]).toMatchObject({ allocatedAmount: "5000.00", unappliedAmount: "0.00" });
  });
  it("rejects an AR settlement against an AP target even with the same party", () => {
    const h = fixture(); h.openItems[0].side = "ap";
    h.openItems[0].line = line(100, "2026-01-01", "3000.00", "credit", { sourceType: "bill", controlType: "ap" });
    expectCode(() => appendAllocationEvents(h, [application()]), "SUBLEDGER_SCOPE_MISMATCH");
  });
  it("requires scoped existing counterparty-compatible references", () => {
    const missing = application(); if (missing.kind === "apply") missing.targetOpenItemId = id(99);
    expectCode(() => appendAllocationEvents(fixture(), [missing]), "SUBLEDGER_REFERENCE_MISSING");
    const wrongParty = fixture(); wrongParty.settlements[0].partyId = id(99);
    expectCode(() => appendAllocationEvents(wrongParty, [application()]), "SUBLEDGER_SCOPE_MISMATCH");
    const wrongEntity = fixture(); wrongEntity.openItems[0].line.entityId = id(99);
    expectCode(() => validateSubledgerHistory(wrongEntity), "SUBLEDGER_SCOPE_MISMATCH");
    const wrongOrg = application(); wrongOrg.line.organizationId = id(99);
    expectCode(() => appendAllocationEvents(fixture(), [wrongOrg]), "SUBLEDGER_SCOPE_MISMATCH");
  });
  it.each(["amount", "controlType", "sourceType", "eventKind", "side"])("rejects an originating open-item %s mismatch", field => {
    const h = fixture();
    const patches: Record<string, () => void> = {
      amount: () => { h.openItems[0].amount = "2999.99"; },
      controlType: () => { h.openItems[0].line.controlType = "ap"; },
      sourceType: () => { h.openItems[0].line.sourceType = "settlement"; },
      eventKind: () => { h.openItems[0].line.eventKind = "reverse"; },
      side: () => { h.openItems[0].line.debit = "0.00"; h.openItems[0].line.credit = "3000.00"; },
    }; patches[field](); expectCode(() => validateSubledgerHistory(h), "SUBLEDGER_LINK_MISMATCH");
  });
  it("rejects duplicate record IDs and reuse of one journal line as new capacity", () => {
    const h = fixture(); h.openItems.push({ ...structuredClone(h.openItems[0]), id: id(11) });
    expectCode(() => validateSubledgerHistory(h), "DUPLICATE_SUBLEDGER_SOURCE");
    const a = application(); expectCode(() => appendAllocationEvents(fixture(), [a, a]), "DUPLICATE_SUBLEDGER_SOURCE");
    const source = fixture(); source.settlements.push({ ...structuredClone(source.settlements[0]), id: id(21) });
    expectCode(() => validateSubledgerHistory(source), "DUPLICATE_SUBLEDGER_SOURCE");
  });
  it("requires separate exact deposit reclassification, not a second use of the receipt journal", () => {
    const sameJournal = application(); sameJournal.line.journalId = fixture().settlements[0].line.journalId;
    expectCode(() => appendAllocationEvents(fixture(), [sameJournal]), "SUBLEDGER_LINK_MISMATCH");
    const wrongAmount = application(); wrongAmount.line.credit = "2999.99";
    expectCode(() => appendAllocationEvents(fixture(), [wrongAmount]), "SUBLEDGER_LINK_MISMATCH");
    const wrongAccount = application(); wrongAccount.line.accountId = id(88);
    expectCode(() => appendAllocationEvents(fixture(), [wrongAccount]), "SUBLEDGER_LINK_MISMATCH");
  });
  it("does not permit two applications to consume one reclassification line", () => {
    const a = application(30, "1000.00"), b = application(31, "1000.00"); b.line = structuredClone(a.line);
    expectCode(() => appendAllocationEvents(fixture(), [a, b]), "DUPLICATE_SUBLEDGER_SOURCE");
  });
  it("requires chronological application and atomic recorded/journal evidence", () => {
    const early = application(30, "3000.00", "2026-01-05");
    expectCode(() => appendAllocationEvents(fixture(), [early]), "SUBLEDGER_DATE_MISMATCH");
    const mismatch = application(); mismatch.line.postingDate = "2026-02-02";
    expectCode(() => appendAllocationEvents(fixture(), [mismatch]), "SUBLEDGER_LINK_MISMATCH");
    const recorded = application(); recorded.recordedAt = instant("2026-02-02");
    expectCode(() => appendAllocationEvents(fixture(), [recorded]), "SUBLEDGER_LINK_MISMATCH");
  });
  it("rejects orphan, duplicate, early or noninverse reversals and reversal chains", () => {
    const a = application(), r = reversal(a);
    expectCode(() => appendAllocationEvents(fixture(), [r]), "SUBLEDGER_REFERENCE_MISSING");
    expectCode(() => appendAllocationEvents(fixture(), [a, r, reversal(a, 41)]), "DUPLICATE_SUBLEDGER_SOURCE");
    expectCode(() => appendAllocationEvents(fixture(), [a, reversal(a, 40, "2026-01-31")]), "SUBLEDGER_DATE_MISMATCH");
    const wrong = reversal(a); wrong.line.debit = "2999.99";
    expectCode(() => appendAllocationEvents(fixture(), [a, wrong]), "SUBLEDGER_LINK_MISMATCH");
    const chain = { ...reversal(a, 41), reversalOf: r.id };
    expectCode(() => appendAllocationEvents(fixture(), [a, r, chain]), "SUBLEDGER_REFERENCE_MISSING");
  });
  it("retains the original control account version on inverse evidence", () => {
    const a = application(), r = reversal(a); r.line.accountVersion = 2;
    expectCode(() => appendAllocationEvents(fixture(), [a, r]), "SUBLEDGER_LINK_MISMATCH");
  });
  it("requires direct receipt capacity to be fully allocated in its original posting", () => {
    const h = fixture(); h.settlements[0] = { ...h.settlements[0], mode: "direct", amount: "3000.00",
      line: line(200, "2026-02-01", "3000.00", "credit", { sourceId: id(20) }) };
    expectCode(() => validateSubledgerHistory(h), "DIRECT_SETTLEMENT_INCOMPLETE");
    const a = application(); a.line = structuredClone(h.settlements[0].line);
    const complete = validateSubledgerHistory({ ...h, events: [a] });
    expect(subledgerAt(complete, cutoff()).settlements[0]).toMatchObject({ allocatedAmount: "3000.00", unappliedAmount: "0.00" });
    const reversed = appendAllocationEvents(complete, [reversal(a)]);
    expect(subledgerAt(reversed, cutoff()).openItems[0].outstandingAmount).toBe("3000.00");
    expect(subledgerAt(reversed, cutoff()).settlements[0].unappliedAmount).toBe("0.00");
    expectCode(() => appendAllocationEvents(reversed, [application(31)]), "SUBLEDGER_LINK_MISMATCH");
  });
  it("supports the payable/advance direction independently", () => {
    const h = fixture(); h.openItems[0].side = "ap"; h.openItems[0].line = line(100, "2026-01-01", "3000.00", "credit", { sourceType: "bill", controlType: "ap" });
    h.settlements[0].side = "ap"; h.settlements[0].line = line(200, "2026-01-10", "5000.00", "debit", { controlType: "supplier_advances", sourceId: id(20), accountId: id(5) });
    const a = application(); a.line = line(330, "2026-02-01", "3000.00", "debit", { controlType: "ap" });
    const r = reversal(a); r.line = line(340, "2026-03-01", "3000.00", "credit", { controlType: "ap", eventKind: "reverse" });
    const history = appendAllocationEvents(h, [a, r]);
    expect(subledgerAt(history, cutoff("2026-02-01")).openItems[0].outstandingAmount).toBe("0.00");
    expect(subledgerAt(history, cutoff()).settlements[0].unappliedAmount).toBe("5000.00");
  });
  it("allows opening provenance without turning old AR into a new invoice", () => {
    const h = fixture(); h.openItems[0].line.sourceType = "opening_batch"; h.openItems[0].documentDate = "2025-06-01";
    expect(validateSubledgerHistory(h).openItems[0].documentDate).toBe("2025-06-01");
  });
  it.each([0, "0.00", "-1.00", "0.001", "NaN", "Infinity", "1e3", "1000000000000000000.00"])("rejects invalid application amount %s", amount => {
    expect(() => appendAllocationEvents(fixture(), [{ ...application(), amount } as AllocationEventInput])).toThrow();
  });
  it("rejects unknown paid flags, unsupported currencies and invalid dates/watermarks", () => {
    expect(() => validateSubledgerHistory({ ...fixture(), paid: true })).toThrow();
    expect(() => validateSubledgerHistory({ ...fixture(), currency: "USD" })).toThrow();
    for (const query of [{ ...cutoff(), asOfDate: "2026-02-30" }, { ...cutoff(), knownAt: "2026-12-31T12:00:00.000Z" },
      { ...cutoff(), knownAt: "2026-02-30T12:00:00.000001Z" }, { ...cutoff(), knownAt: "2026-12-31T25:00:00.000001Z" }])
      expect(() => subledgerAt(fixture(), query)).toThrow();
    expect(() => validateSubledgerHistory({ ...fixture(), openItems: [{ ...fixture().openItems[0], paid: true }] })).toThrow();
  });
  it("conserves every paisa across deterministic partial applications and reversal", () => {
    // Independent integer expected results, not the production balance routine.
    for (let cents = 1; cents <= 100; cents++) {
      const a = application(30, `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);
      const applied = appendAllocationEvents(fixture(), [a]);
      const result = subledgerAt(applied, cutoff());
      const remaining = 300000 - cents;
      expect(result.openItems[0].outstandingAmount).toBe(`${Math.floor(remaining / 100)}.${String(remaining % 100).padStart(2, "0")}`);
      expect(money(new Exact(result.openItems[0].outstandingAmount).plus(result.openItems[0].allocatedAmount))).toBe("3000.00");
      expect(subledgerAt(appendAllocationEvents(applied, [reversal(a)]), cutoff()).openItems[0].outstandingAmount).toBe("3000.00");
    }
  });
});
