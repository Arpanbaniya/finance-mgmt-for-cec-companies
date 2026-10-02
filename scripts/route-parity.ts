import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function catalogRows() {
  const text = readFileSync("docs/contracts/api-catalog.csv", "utf8");
  // CSV grammar: quoted fields may contain commas, double quotes, CR/LF.
  const rows: string[][] = []; let row: string[] = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === "," && !quoted) { row.push(value); value = ""; }
    else if (c === "\n" && !quoted) { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += c;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  const headers = rows.shift()!;
  return rows.filter(r => r.length === headers.length).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}
export function implementedRoutes() {
  const results: { method: string; path: string }[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "route.ts") {
        const url = "/" + path.replaceAll("\\", "/").replace(/^app\//, "").replace(/\/route\.ts$/, "").replace(/\[([^\]]+)\]/g, "{$1}");
        if (url.startsWith("/api/auth/")) continue;
        const source = readFileSync(path, "utf8");
        for (const m of source.matchAll(/export\s+(?:async\s+function|const|function)\s+(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\b/g)) results.push({ method: m[1], path: url });
      }
    }
  }
  walk("app/api");
  // Filesystem enumeration differs between Windows and Linux. Contracts must not.
  return results.sort((a, b) => {
    const left = `${a.path} ${a.method}`, right = `${b.path} ${b.method}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
export function parity() {
  const catalog = catalogRows(), keys = new Set(catalog.map(r => `${r.method} ${r.path}`));
  if (keys.size !== 256 || new Set(catalog.map(r => r.operation_id)).size !== 256) throw new Error("Catalog IDs/routes are not unique or total differs from 256.");
  const implemented = implementedRoutes();
  for (const r of implemented) if (!keys.has(`${r.method} ${r.path}`)) throw new Error(`Undocumented route: ${r.method} ${r.path}`);
  return { planned: catalog.length, implemented: implemented.length, remaining: catalog.length - implemented.length };
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/route-parity.ts")) console.log(JSON.stringify(parity()));
