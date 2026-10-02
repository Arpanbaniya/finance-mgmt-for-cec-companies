import { expect, it } from "vitest";
import { businessDate, containsDate, localDate } from "@/domain/dates";
it("rejects invented calendar dates", () => { expect(() => businessDate("2026-02-29")).toThrow(); expect(businessDate("2024-02-29")).toBe("2024-02-29"); });
it("uses half-open effective intervals", () => { expect(containsDate("2026-01-01", "2026-02-01", "2026-01-31")).toBe(true); expect(containsDate("2026-01-01", "2026-02-01", "2026-02-01")).toBe(false); });
it("resolves Nepal midnight independent of host timezone", () => { expect(localDate(new Date("2026-10-01T18:14:59Z"))).toBe("2026-10-01"); expect(localDate(new Date("2026-10-01T18:15:00Z"))).toBe("2026-10-02"); });
