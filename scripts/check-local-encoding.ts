import { config } from "dotenv";
import { Pool } from "pg";
config({ path: ".env.local", quiet: true });
const url = new URL(process.env.MIGRATION_DATABASE_URL ?? "");
if (url.hostname !== "127.0.0.1" || url.pathname !== "/kaamledger") throw new Error("Local encoding check requires the dedicated loopback database.");
const app = new Pool({ connectionString: url.href });
const count = await app.query("SELECT count(*) AS n FROM auth_user"); await app.end();
url.pathname = "/postgres";
const pool = new Pool({ connectionString: url.href });
try {
  const state = await pool.query("SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname='kaamledger'");
  if (state.rows[0].encoding !== "UTF8") {
    if (Number(count.rows[0].n) !== 0) throw new Error("Existing identity data needs a reviewed UTF8 migration.");
    await pool.query("ALTER DATABASE kaamledger RENAME TO kaamledger_initial_empty_win1252");
    await pool.query("CREATE DATABASE kaamledger TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'");
    console.log("Preserved empty initial database under an archive name; application database now UTF8.");
  } else console.log("UTF8 verified.");
} finally { await pool.end(); }
