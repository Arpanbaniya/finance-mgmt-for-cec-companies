import { DatabaseError } from "pg";
import { setTimeout as pause } from "node:timers/promises";
import { randomInt } from "node:crypto";
import { DomainError } from "@/domain/errors";

// The callback must encompass BEGIN through COMMIT, with rollback/release on
// failure. Only database work belongs inside it, never external side effects.
export async function retryTransaction<T>(attempt: () => Promise<T>): Promise<T> {
  for (let count = 1; count <= 3; count++) {
    try { return await attempt(); }
    catch (error) {
      if (!(error instanceof DatabaseError) || !["40001", "40P01"].includes(error.code ?? "")) throw error;
      if (count === 3) throw new DomainError("TRANSACTION_BUSY", "The database is busy. Retry with the same idempotency key.", 503);
      await pause(randomInt(10, 31) * count);
    }
  }
  throw new Error("Unreachable transaction attempt.");
}
