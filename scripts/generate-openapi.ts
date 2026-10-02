import { mkdirSync, writeFileSync } from "node:fs";
import { openapi } from "@/features/platform/openapi";
mkdirSync("docs/api", { recursive: true });
writeFileSync("docs/api/openapi.json", JSON.stringify(openapi(), null, 2) + "\n");
console.log("Generated concrete OpenAPI schemas for implemented operations.");
