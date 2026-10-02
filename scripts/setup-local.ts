import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";

if (process.env.VERCEL || process.env.NODE_ENV === "production") throw new Error("Local setup cannot run in production.");
mkdirSync(".local", { recursive: true });
if (existsSync(".env.local")) {
  const values = parse(readFileSync(".env.local"));
  const keys = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
  if (keys.some(key => values[key]) && !keys.every(key => values[key])) throw new Error("Partial storage configuration found; complete it without replacing existing credentials.");
  if (!keys.some(key => values[key])) appendFileSync(".env.local", storageEnvironment());
  console.log("Existing local credentials preserved; local storage configuration is available.");
  process.exit(0);
}
function storageEnvironment() {
  return `\nS3_ENDPOINT=http://127.0.0.1:59000\nS3_REGION=us-east-1\nS3_BUCKET=kaamledger-evidence\nS3_ACCESS_KEY_ID=${randomBytes(16).toString("hex")}\nS3_SECRET_ACCESS_KEY=${randomBytes(32).toString("hex")}\n`;
}
const admin = randomBytes(24).toString("hex"), runtime = randomBytes(24).toString("hex"), auth = randomBytes(48).toString("base64url");
// This script intentionally generates ignored local credentials; it never logs them.
writeFileSync(".env.local", `DATABASE_URL=postgresql://kaamledger_app:${runtime}@127.0.0.1:55432/kaamledger\nMIGRATION_DATABASE_URL=postgresql://postgres:${admin}@127.0.0.1:55432/kaamledger\nBETTER_AUTH_SECRET=${auth}\nBETTER_AUTH_URL=http://localhost:3000\n${storageEnvironment()}`, { mode: 0o600, flag: "wx" });
console.log("Generated private local database and authentication credentials in .env.local.");
