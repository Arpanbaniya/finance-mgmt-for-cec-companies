import { expect, it, vi } from "vitest";
import { DatabaseError } from "pg";
import { DomainError } from "@/domain/errors";
import { retryTransaction } from "@/features/platform/transaction-retry";
function failure(code: string) { const error = new DatabaseError("database diagnostic", 0, "error"); error.code = code; return error; }
it.each(["40001", "40P01"])("retries whole transactions for %s with at most three attempts", async code => {
  const task = vi.fn().mockRejectedValueOnce(failure(code)).mockRejectedValueOnce(failure(code)).mockResolvedValue("committed");
  expect(await retryTransaction(task)).toBe("committed"); expect(task).toHaveBeenCalledTimes(3);
});
it("returns a redacted retryable failure after three aborted attempts", async () => {
  const task = vi.fn().mockRejectedValue(failure("40001"));
  await expect(retryTransaction(task)).rejects.toMatchObject({ code: "TRANSACTION_BUSY", status: 503 }); expect(task).toHaveBeenCalledTimes(3);
});
it.each([failure("23505"), failure("23514"), failure("08006"), new DomainError("40001", "Not a database error"), new Error("network failure")])("does not retry constraints, domain errors or ambiguous connection failures", async error => {
  const task = vi.fn().mockRejectedValue(error); await expect(retryTransaction(task)).rejects.toBe(error); expect(task).toHaveBeenCalledTimes(1);
});
