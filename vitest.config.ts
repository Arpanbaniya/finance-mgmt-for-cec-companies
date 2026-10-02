import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { projects: [
    { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
    { extends: true, test: { name: "contract", include: ["tests/contract/**/*.test.ts"] } },
    { extends: true, test: { name: "integration", include: ["tests/integration/**/*.test.ts"], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false } }
  ] }
});
