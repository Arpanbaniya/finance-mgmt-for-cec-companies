import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { StatementQuery, reconcilePartyStatement, PartyStatementCursor } from "@/domain/party-statement";
import { parseStatementQuery, encodeStatementCursor, decodeStatementCursor } from "@/features/parties/statement-query";
import { PartyStatement } from "@/features/parties/statement-contracts";
import { openapi } from "@/features/platform/openapi";
const books = ["ar", "ap", "customer_deposits", "supplier_advances"] as const;
const balances = () => books.map(book => ({ book, opening: "0.00", increases: "0.00", decreases: "0.00", closing: "0.00", subledgerOpening: "0.00", subledgerClosing: "0.00" }));
const ageing = () => ["ar", "ap"].map(side => ({ side, current: "0.00", days1To30: "0.00", days31To60: "0.00", days61To90: "0.00", daysOver90: "0.00" }));
it("requires an inclusive as-of date, preserves microseconds and defaults bounded history", () => {
  expect(StatementQuery.parse({ asOfDate: "2026-02-01" })).toEqual({ asOfDate: "2026-02-01", fromDate: "1900-01-01", limit: 25 });
  expect(parseStatementQuery(new URLSearchParams("asOfDate=2026-02-01&limit=100&knownAt=2026-10-01T00:00:00.123456Z")).knownAt).toBe("2026-10-01T00:00:00.123456Z");
});
it.each([{ asOfDate: "2026-02-30" }, { asOfDate: "2026-02-01", fromDate: "2026-02-02" }, { asOfDate: "2026-02-01", limit: 101 }, { asOfDate: "2026-02-01", partyId: randomUUID() }, { asOfDate: "2026-02-01", knownAt: "2026-01-01T00:00:00.000Z" }])("rejects invalid or injected statement query %j", q => {
  expect(StatementQuery.safeParse(q).success).toBe(false);
});
it("rejects duplicate keys and noncanonical HTTP limits", () => {
  expect(() => parseStatementQuery(new URLSearchParams("asOfDate=2026-01-01&asOfDate=2026-02-01"))).toThrow();
  for (const limit of ["01", "1e2", "1.5", "", "-1"]) expect(() => parseStatementQuery(new URLSearchParams(`asOfDate=2026-01-01&limit=${limit}`))).toThrow();
});
it("binds an opaque cursor to party, scope, dates and knowledge", () => {
  const org = randomUUID(), entity = randomUUID(), party = randomUUID(), query = StatementQuery.parse({ asOfDate: "2026-02-01" });
  const cursor = PartyStatementCursor.parse({ version: 1, organizationId: org, entityId: entity, partyId: party, fromDate: query.fromDate,
    asOfDate: query.asOfDate, knownAt: "2026-10-01T00:00:00.123456Z", postingDate: "2026-01-01", sourceId: randomUUID() });
  const encoded = encodeStatementCursor(cursor); expect(decodeStatementCursor(encoded, org, entity, party, query)).toEqual(cursor);
  for (const [o, e, p, q] of [[randomUUID(), entity, party, query], [org, randomUUID(), party, query], [org, entity, randomUUID(), query],
    [org, entity, party, { ...query, asOfDate: "2026-03-01" }], [org, entity, party, { ...query, knownAt: "2026-10-01T00:00:00.123457Z" }]] as const)
    expect(() => decodeStatementCursor(encoded, o, e, p, q)).toThrow();
  expect(() => decodeStatementCursor(`${encoded}=`, org, entity, party, query)).toThrow();
});
it("reconciles separate exact books above JavaScript safe-integer precision", () => {
  const b = balances(), a = ageing(); b[0] = { ...b[0], increases: "999999999999999999.99", closing: "999999999999999999.99", subledgerClosing: "999999999999999999.99" }; a[0].current = b[0].closing;
  expect(reconcilePartyStatement(b, a).balances[0].closing).toBe("999999999999999999.99");
});
it("fails closed on ledger, subledger, ageing, duplicate book or numeric boundary mismatches", () => {
  const b = balances(); b[0].closing = "1.00"; expect(() => reconcilePartyStatement(b, ageing())).toThrow();
  b[0].increases = "1.00"; expect(() => reconcilePartyStatement(b, ageing())).toThrow();
  b[0].subledgerClosing = "1.00"; expect(() => reconcilePartyStatement(b, ageing())).toThrow();
  expect(() => reconcilePartyStatement([balances()[0], ...balances().slice(0, 3)], ageing())).toThrow();
  expect(PartyStatement.shape.balances.element.shape.closing.safeParse(1).success).toBe(false);
});
it("documents a concrete read-only statement and bounded query without changing the original catalog", () => {
  const spec = openapi(), op = spec.paths["/api/v1/orgs/{orgId}/entities/{entityId}/parties/{id}/statement"].get;
  expect(op).toMatchObject({ "x-permission": "parties.read", parameters: expect.arrayContaining([{ name: "asOfDate", in: "query", required: true, schema: expect.any(Object) }]) });
  expect(JSON.stringify(spec.components.schemas.PartyStatement)).toContain("subledgerClosing");
  expect(JSON.stringify(spec.components.schemas.PartyStatement)).not.toContain("taxIdentifier");
  expect(spec.components.schemas.StatementQuery).toMatchObject({ required: ["asOfDate"] });
});
