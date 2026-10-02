import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { storageClient, storageConfig } from "../features/documents/storage-config";

export async function startStorage(env: NodeJS.ProcessEnv, dataDirectory: string) {
  if (env.VERCEL || env.NODE_ENV === "production") throw new Error("Local storage cannot run in production.");
  const config = storageConfig(env), endpoint = new URL(config.S3_ENDPOINT);
  if (endpoint.hostname !== "127.0.0.1" || !endpoint.port) throw new Error("Local storage must bind explicitly to loopback.");
  // Never attach to a different process that happens to use the same endpoint.
  await new Promise<void>((ok, fail) => {
    const probe = createServer(); probe.once("error", () => fail(new Error("Local storage port is already in use.")));
    probe.listen(Number(endpoint.port), "127.0.0.1", () => probe.close(() => ok()));
  });
  const binary = resolve(`.local/tools/rustfs-1.0.0/${process.platform === "win32" ? "rustfs.exe" : "rustfs"}`);
  if (!existsSync(binary)) throw new Error("Run pnpm storage:install first.");
  mkdirSync(dataDirectory, { recursive: true });
  const child = spawn(binary, ["server", "--address", `127.0.0.1:${endpoint.port}`, resolve(dataDirectory)], {
    windowsHide: true, stdio: "ignore",
    env: { ...process.env, RUSTFS_ACCESS_KEY: config.S3_ACCESS_KEY_ID, RUSTFS_SECRET_KEY: config.S3_SECRET_ACCESS_KEY, RUSTFS_CONSOLE_ENABLE: "false", RUST_LOG: "error" },
  });
  let startupError = false; child.once("error", () => { startupError = true; });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(res => child.once("exit", () => res()));
    child.kill("SIGTERM");
    await Promise.race([exited, pause(10000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  }
  const client = storageClient(env);
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (startupError || child.exitCode !== null) throw new Error("Local storage process failed to start.");
      try { await client.send(new ListBucketsCommand({}), { abortSignal: AbortSignal.timeout(1000) }); return { child, stop }; }
      catch { await pause(500); }
    }
    throw new Error("Local storage startup timed out.");
  } catch (error) { await stop(); throw error; }
  finally { client.destroy(); }
}
