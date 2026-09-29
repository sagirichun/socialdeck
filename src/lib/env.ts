import path from "node:path";
import fs from "node:fs";

// Load .env without any dependency. Node 21+ ships process.loadEnvFile.
if (typeof (process as { loadEnvFile?: (p?: string) => void }).loadEnvFile === "function") {
  try {
    (process as { loadEnvFile: (p?: string) => void }).loadEnvFile(path.resolve(process.cwd(), ".env"));
  } catch {
    /* .env is optional; real env wins */
  }
}

const root = process.cwd();
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const mediaDir = process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : path.join(root, "media");
// ponytail: runtime .env loading is a Node >= 21 capability; typed once the libdefs expose it.
for (const dir of [dataDir, mediaDir, path.join(mediaDir, "uploads"), path.join(mediaDir, "stream")]) {
  fs.mkdirSync(dir, { recursive: true });
}

const secret =
  process.env.APP_SECRET ||
  // Deterministic dev fallback so a fresh clone boots; operator must set APP_SECRET in production.
  "socialdeck-dev-secret-change-me-0000000000000000000000000000";

export const env = {
  root,
  dataDir,
  mediaDir,
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, "socialdeck.db"),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  appUrl: process.env.APP_URL || "http://127.0.0.1:3111",
  secret,
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 168),
  isProd: process.env.NODE_ENV === "production",
  // Deployment mode: sandbox never touches live platform endpoints.
  outboundMode: (process.env.OUTBOUND_MODE || "sandbox") as "sandbox" | "live",
  // Where ffmpeg children are allowed to read media from (used to validate playlist paths).
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
};

export const REDIS_REQUIRED = process.env.REDIS_REQUIRED === "1";
