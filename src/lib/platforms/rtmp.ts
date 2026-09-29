export const RTMP_KEY = "rtmp" as const;

import {
  type PlatformAdapter,
  type PublishInput,
  type MetricSet,
  registerAdapter,
} from "./types";

/**
 * Generic RTMP ingest target (YouTube Live, Facebook Live, Twitch, self-hosted nginx-rtmp,
 * any custom ingest). Publishing "as a post" is not meaningful here, so the adapter declares
 * rtmp capability and the stream supervisor owns the lifecycle. The account row stores the
 * ingest URL and (encrypted) stream key so the UI never has to hand them back to the browser.
 */
async function publish(): Promise<never> {
  throw new Error("RTMP targets are driven by the live stream supervisor, not the post queue");
}

async function fetchMetrics(): Promise<MetricSet> {
  return { day: new Date().toISOString().slice(0, 10) };
}

/** Stream targets have no OAuth: the operator pastes an ingest URL and key. */
export const rtmpAdapter: PlatformAdapter = {
  key: RTMP_KEY,
  label: "RTMP target",
  glyph: "radio",
  docsUrl: "https://ffmpeg.org/ffmpeg-protocols.html#rtmp",
  capabilities: { oauth: "manual", nativeScheduling: false, kinds: [], comments: false, metrics: false, rtmp: true, maxBodyLen: 0 },
  credentialFields: [
    { name: "rtmpUrl", label: "RTMP ingest URL", secret: false },
    { name: "streamKey", label: "Stream key", secret: true },
  ],
  publish: publish as unknown as (input: PublishInput) => Promise<any>,
  fetchMetrics,
};

registerAdapter(rtmpAdapter);
