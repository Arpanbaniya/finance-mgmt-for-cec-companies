import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (process.env.VERCEL || process.env.NODE_ENV === "production") throw new Error("Local setup cannot run in production.");
if (existsSync(".env.local")) throw new Error(".env.local already exists; existing credentials will not be overwritten.");
mkdirSync(".local", { recursive: true });
const admin = randomBytes(24).toString("hex"), runtime = randomBytes(24).toString("hex"), auth = randomBytes(48).toString("base64url");
// This script intentionally generates ignored local credentials; it never logs them.
writeFileSync(".env.local", `DATABASE_URL=postgresql://kaamledger_app:${runtime}@127.0.0.1:55432/kaamledger\nMIGRATION_DATABASE_URL=postgresql://postgres:${admin}@127.0.0.1:55432/kaamledger\nBETTER_AUTH_SECRET=${auth}\nBETTER_AUTH_URL=http://localhost:3000\n`, { mode: 0o600, flag: "wx" });
console.log("Generated private local database and authentication credentials in .env.local.");
