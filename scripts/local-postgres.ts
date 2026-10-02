import { config } from "dotenv";
import { existsSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
config({ path: ".env.local", quiet: true });
const url = new URL(process.env.MIGRATION_DATABASE_URL ?? "");
if (process.env.VERCEL || url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Local server requires the dedicated loopback kaamledger database.");
const pg = new EmbeddedPostgres({ databaseDir: ".local/postgres", user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), port: 55432, persistent: true, authMethod: "scram-sha-256", initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-h", "127.0.0.1"] });
if (!existsSync(".local/postgres/PG_VERSION")) await pg.initialise();
await pg.start();
const client = pg.getPgClient(); await client.connect();
const exists = await client.query("SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname='kaamledger'");
if (!exists.rowCount) await client.query("CREATE DATABASE kaamledger TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'");
else if (exists.rows[0].encoding !== "UTF8") throw new Error("Existing database is not UTF8. Preserve it and create a UTF8 database before continuing.");
await client.end();
console.log("Local PostgreSQL ready on 127.0.0.1:55432. Data persists in .local/postgres.");
const keepAlive = setInterval(() => {}, 60000);
async function stop() { clearInterval(keepAlive); await pg.stop(); process.exit(0); }
process.once("SIGINT", stop); process.once("SIGTERM", stop);
