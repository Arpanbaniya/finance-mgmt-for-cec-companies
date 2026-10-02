import { config } from "dotenv";
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { storageClient, storageConfig } from "../features/documents/storage-config";
import { startStorage } from "./storage-process";
config({ path: ".env.local", quiet: true });
const settings = storageConfig(), service = await startStorage(process.env, ".local/objects");
const client = storageClient();
try {
  try { await client.send(new HeadBucketCommand({ Bucket: settings.S3_BUCKET })); }
  catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    await client.send(new CreateBucketCommand({ Bucket: settings.S3_BUCKET }));
  }
  console.log(`Private local object storage ready at ${settings.S3_ENDPOINT}. Data persists in .local/objects. Console disabled.`);
} catch (error) { await service.stop(); throw error; }
finally { client.destroy(); }
process.once("SIGINT", async () => { await service.stop(); process.exit(0); });
process.once("SIGTERM", async () => { await service.stop(); process.exit(0); });
