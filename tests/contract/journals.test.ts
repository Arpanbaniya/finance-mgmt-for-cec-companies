import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { JournalCreate, JournalPatch } from "@/domain/manual-journal";
import { openapi } from "@/features/platform/openapi";
import { body } from "@/features/platform/http";
const lines = [{ accountId: randomUUID(), debit: "10", credit: "0", dimensions: {} }, { accountId: randomUUID(), debit: "0", credit: "10", dimensions: {} }];
const valid = { postingDate: "2026-10-10", documentDate: "2026-10-09", description: " Reviewed adjustment ", lines };
it("manual drafts normalize money but never accept source, actor, status or account versions", () => {
  expect(JournalCreate.parse(valid)).toMatchObject({ description: "Reviewed adjustment", lines: [{ debit: "10.00" }, { credit: "10.00" }] });
  for (const field of ["organizationId", "sourceId", "sourceType", "status", "journalId", "createdBy", "version", "currency", "approved"]) expect(JournalCreate.safeParse({ ...valid, [field]: "injected" }).success).toBe(false);
  expect(JournalCreate.safeParse({ ...valid, lines: lines.map(line => ({ ...line, accountVersion: 99 })) }).success).toBe(false);
});
it("rejects unsafe money, one-sided imbalance and unsupported dimensions", () => {
  for (const value of [10, "1e1", "10.001", "-10.00", "NaN", "1000000000000000000.00"]) expect(JournalCreate.safeParse({ ...valid, lines: [{ ...lines[0], debit: value }, lines[1]] }).success).toBe(false);
  for (const value of [{ ...valid, lines: [lines[0]] }, { ...valid, lines: [{ ...lines[0], credit: "10" }, lines[1]] }, { ...valid, postingDate: "2026-02-29" }, { ...valid, lines: [{ ...lines[0], dimensions: { workerId: randomUUID() } }, lines[1]] }]) expect(JournalCreate.safeParse(value).success).toBe(false);
});
it("draft patches are finite nonempty subsets and replace balanced lines as a whole", () => {
  expect(JournalPatch.safeParse({ description: "Changed explanation" }).success).toBe(true);
  for (const value of [{}, { description: null }, { status: "posted" }, { lines: [lines[0]] }, { amount: "20.00" }]) expect(JournalPatch.safeParse(value).success).toBe(false);
});
it("exposes only five draft catalog operations, with ETag and creation Location", () => {
  const doc = openapi(), base = "/api/v1/orgs/{orgId}/entities/{entityId}/journals";
  for (const name of ["Journal", "JournalList", "JournalCreate", "JournalPatch"]) expect(doc.components.schemas[name]).toBeDefined();
  expect(doc.paths[base].post).toMatchObject({ responses: { "201": { headers: { ETag: expect.anything(), Location: expect.anything() } } } });
  expect(doc.paths[`${base}/{id}/cancel`].post).toMatchObject({ parameters: expect.arrayContaining([expect.objectContaining({ name: "If-Match", required: true }), expect.objectContaining({ name: "Idempotency-Key", required: true })]), responses: { "200": expect.anything() } });
  for (const action of ["submit", "approve", "post", "reverse"]) expect(doc.paths[`${base}/{id}/${action}`]).toBeUndefined();
});
it("the journal request budget permits the declared 500 lines but remains bounded", async () => {
  const command = { ...valid, lines: Array.from({ length: 500 }, (_, i) => ({ ...lines[i % 2], dimensions: { branchId: randomUUID() } })) };
  expect(JournalCreate.safeParse(command).success).toBe(true);
  const content = JSON.stringify(command); expect(content.length).toBeGreaterThan(64000);
  expect(await body(new Request("http://localhost/journals", { method: "POST", headers: { "Content-Type": "application/json" }, body: content }), 300000)).toEqual(command);
  await expect(body(new Request("http://localhost/journals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field: "x".repeat(300000) }) }), 300000)).rejects.toMatchObject({ status: 413 });
  expect(JournalCreate.safeParse({ ...command, lines: [...command.lines, lines[0]] }).success).toBe(false);
});
