import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
config({ path: ".env.local" });
export default defineConfig({ dialect: "postgresql", schema: "./db/schema.ts", out: "./db/generated", dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? "" } });
