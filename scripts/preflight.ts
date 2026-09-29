#!/usr/bin/env tsx
/**
 * Preflight for the script entry points. Runs before migrate/seed/worker so a wrong runtime
 * fails with one actionable line instead of a stack trace naming an internal module.
 */
import "../src/lib/require-node";
import { execFileSync } from "node:child_process";

console.log(`node ${process.versions.node} ok`);

try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  console.warn("warning: ffmpeg not found on PATH — the RTMP relay, media probing and aspect");
  console.warn("         variants will be unavailable. Everything else still works.");
}
