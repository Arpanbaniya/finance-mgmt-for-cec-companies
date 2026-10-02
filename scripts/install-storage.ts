import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

if (process.env.VERCEL || process.env.NODE_ENV === "production") throw new Error("Local installer cannot run in production.");
const releases = {
  win32: { asset: "rustfs-windows-x86_64-v1.0.0.zip", sha256: "4ccf5858ce8e6f70f01af2394c8cc0e0878ee77faa6c20d3179153476554b7d8" },
  linux: { asset: "rustfs-linux-x86_64-gnu-v1.0.0.zip", sha256: "2d5059501745682664c3d345b22274b66079c952fbec7e1ce66980ef4515cd42" },
};
if (process.arch !== "x64" || !(process.platform in releases)) throw new Error("Local installer supports Windows x64 and Linux x64.");
const release = releases[process.platform as keyof typeof releases];
const directory = resolve(".local/tools/rustfs-1.0.0"); mkdirSync(directory, { recursive: true });
const archive = join(directory, release.asset), binaryName = process.platform === "win32" ? "rustfs.exe" : "rustfs";
async function checksum(path: string) {
  const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
if (!existsSync(archive) || await checksum(archive) !== release.sha256) {
  console.log("Downloading pinned RustFS 1.0.0 from the official release.");
  const response = await fetch(`https://github.com/rustfs/rustfs/releases/download/1.0.0/${release.asset}`);
  if (!response.ok || !response.body) throw new Error(`Storage download failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  async function* chunks() {
    try { for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; } }
    finally { reader.releaseLock(); }
  }
  await pipeline(Readable.from(chunks()), createWriteStream(archive));
}
if (await checksum(archive) !== release.sha256) throw new Error("Storage archive checksum mismatch; refusing to execute.");
const extracted = join(directory, "extracted"); mkdirSync(extracted, { recursive: true });
if (process.platform === "win32") {
  const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(extracted)} -Force`], { windowsHide: true, stdio: "pipe" });
} else execFileSync("unzip", ["-o", "-q", archive, "-d", extracted], { stdio: "pipe" });
function findBinary(path: string): string | undefined {
  for (const file of readdirSync(path, { withFileTypes: true })) {
    if (file.isFile() && file.name === binaryName) return join(path, file.name);
    if (file.isDirectory()) { const found = findBinary(join(path, file.name)); if (found) return found; }
  }
}
const source = findBinary(extracted); if (!source) throw new Error("Release archive did not contain the expected executable.");
const target = join(directory, binaryName); copyFileSync(source, target); chmodSync(target, 0o700);
console.log("Verified and installed local RustFS 1.0.0. Binary and data stay ignored by Git.");
