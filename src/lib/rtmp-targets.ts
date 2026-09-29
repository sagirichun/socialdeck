/**
 * RTMP ingest presets: the server URL plus the encoding profile each network expects.
 * Consumed by the console when creating a stream, so operators do not have to look up
 * per-network bitrate guidance.
 */
export interface RtmpTarget {
  key: string;
  label: string;
  server: string;
  preset: { resolution: string; videoBitrate: string; audioBitrate: string; fps: number };
}

export const RTMP_TARGETS: RtmpTarget[] = [
  {
    key: "youtube",
    label: "YouTube Live",
    server: "rtmp://a.rtmp.youtube.com/live2",
    preset: { resolution: "1920x1080", videoBitrate: "6000", audioBitrate: "160", fps: 30 },
  },
  {
    key: "facebook",
    label: "Facebook Live",
    server: "rtmps://live-api-s.facebook.com:443/rtmp",
    preset: { resolution: "1280x720", videoBitrate: "4000", audioBitrate: "128", fps: 30 },
  },
  {
    key: "twitch",
    label: "Twitch",
    server: "rtmp://live.twitch.tv/app",
    preset: { resolution: "1920x1080", videoBitrate: "6000", audioBitrate: "160", fps: 60 },
  },
  {
    key: "tiktok",
    label: "TikTok Live",
    server: "rtmp://push.tiktokcdn.com/live",
    preset: { resolution: "1080x1920", videoBitrate: "4000", audioBitrate: "128", fps: 30 },
  },
  {
    key: "custom",
    label: "Custom / self-hosted",
    server: "rtmp://example.com:1935/live",
    preset: { resolution: "1920x1080", videoBitrate: "3500", audioBitrate: "128", fps: 30 },
  },
];
