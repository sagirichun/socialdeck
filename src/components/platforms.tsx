"use client";

import React from "react";
import {
  AtSign,
  Briefcase,
  Camera,
  Globe,
  Hash,
  MessageCircle,
  Music2,
  Pin,
  Play,
  Radio,
} from "lucide-react";

/**
 * Platform identity: a glyph plus the accent used in charts and badges.
 * Deliberately typographic rather than logo artwork so the console never ships
 * third-party marks into a customer's own deployment.
 */
export interface PlatformStyle {
  label: string;
  glyph: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}

export const PLATFORMS: Record<string, PlatformStyle> = {
  facebook: { label: "Facebook", glyph: MessageCircle, color: "#5b8def" },
  instagram: { label: "Instagram", glyph: Camera, color: "#c4709c" },
  tiktok: { label: "TikTok", glyph: Music2, color: "#63d4c8" },
  youtube: { label: "YouTube", glyph: Play, color: "#e5544b" },
  x: { label: "X", glyph: Hash, color: "#c8ced9" },
  threads: { label: "Threads", glyph: AtSign, color: "#a89ce0" },
  linkedin: { label: "LinkedIn", glyph: Briefcase, color: "#5fa4d8" },
  pinterest: { label: "Pinterest", glyph: Pin, color: "#e07a7a" },
  mastodon: { label: "Mastodon", glyph: Globe, color: "#8f7fd8" },
  rtmp: { label: "RTMP target", glyph: Radio, color: "#d9a441" },
};

export function platformStyle(key: string): PlatformStyle {
  return (
    PLATFORMS[key] ?? {
      label: key ? key.charAt(0).toUpperCase() + key.slice(1) : "Unknown",
      glyph: Globe,
      color: "#7d8798",
    }
  );
}

export function PlatformIcon({
  platform,
  size = 13,
  className,
  showLabel,
}: {
  platform: string;
  size?: number;
  className?: string;
  showLabel?: boolean;
}) {
  const style = platformStyle(platform);
  const Glyph = style.glyph;
  if (showLabel) {
    return (
      <span className={`inline-flex items-center gap-1.5 text-[12px] text-ink-dim ${className ?? ""}`}>
        <span style={{ color: style.color }} className="grid place-items-center">
          <Glyph size={size} />
        </span>
        {style.label}
      </span>
    );
  }
  return (
    <span
      className={`grid place-items-center rounded-md border border-line bg-raised ${className ?? ""}`}
      style={{ color: style.color, width: size + 14, height: size + 14 }}
      title={style.label}
    >
      <Glyph size={size} />
    </span>
  );
}

export function platformLabel(key: string) {
  return platformStyle(key).label;
}

export function platformColor(key: string) {
  return platformStyle(key).color;
}
