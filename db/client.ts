import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

let pool: Pool | undefined;
export function databasePool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("Database is not configured.");
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 20000, connectionTimeoutMillis: 5000 });
  return pool;
}
export function database() { return drizzle(databasePool(), { schema }); }
export function configured(): boolean { return Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL); }
