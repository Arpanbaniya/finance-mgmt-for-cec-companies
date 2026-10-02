// Supavisor appends the project reference to the PostgreSQL role name.
// Credentials stay opaque; configuration errors never contain connection strings.
export function runtimeRole(connectionString: string, projectRef?: string): "kaamledger_app" {
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.password || url.pathname.length < 2) throw new Error();
    const username = decodeURIComponent(url.username);
    if (username === "kaamledger_app") return "kaamledger_app";
    if (projectRef && /^[a-z]{20}$/.test(projectRef) && url.hostname.endsWith(".pooler.supabase.com") && username === `kaamledger_app.${projectRef}`) return "kaamledger_app";
  } catch { /* Do not expose URL/password parse diagnostics. */ }
  throw new Error("Database configuration requires the restricted kaamledger_app runtime role.");
}
