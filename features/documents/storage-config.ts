import { z } from "zod";
import { S3Client } from "@aws-sdk/client-s3";

const Config = z.object({
  S3_ENDPOINT: z.url(), S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  S3_ACCESS_KEY_ID: z.string().min(16), S3_SECRET_ACCESS_KEY: z.string().min(32),
});
export function storageConfig(env: Record<string, string | undefined> = process.env) {
  const result = Config.safeParse(env);
  // Never include credential input in validation errors.
  if (!result.success) throw new Error("Private storage configuration is missing or invalid.");
  const config = result.data, endpoint = new URL(config.S3_ENDPOINT);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new Error("Storage endpoint must be an origin without embedded credentials.");
  const local = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost";
  if (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:" && !env.VERCEL && env.NODE_ENV !== "production")) throw new Error("Storage requires HTTPS outside local development.");
  if (local && (env.VERCEL || env.NODE_ENV === "production")) throw new Error("Deployment cannot use local storage.");
  return config;
}
export function storageClient(env: Record<string, string | undefined> = process.env) {
  const config = storageConfig(env);
  return new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
}
