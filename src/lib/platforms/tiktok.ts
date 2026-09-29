import fs from "node:fs";
import crypto from "node:crypto";
import {
  type PlatformAdapter,
  type PublishInput,
  type PublishResult,
  type MetricSet,
  type AccountRef,
  registerAdapter,
  request,
} from "./types";

const API = "https://open.tiktokapis.com/v2";

/**
 * TikTok Content Posting API: FILE_UPLOAD flow.
 * 1) POST /post/publish/video/init/   -> returns publish_id + upload_url
 * 2) PUT the whole file to upload_url (single chunk)
 * 3) POST /post/publish/ with post_info is implicit in the init for direct post
 */
async function publish(input: PublishInput): Promise<PublishResult> {
  const { account, media } = input;
  const token = account.accessToken;
  if (!token) throw new Error("tiktok account has no access token");
  const video = media.find((m) => m.mime.startsWith("video/"));
  if (!video) throw new Error("tiktok requires a video file");
  const size = fs.statSync(video.absPath).size;

  const init = await request<any>("tiktok", `${API}/post/publish/video/init/`, {
    headers: { Authorization: `Bearer ${token}` },
    json: {
      post_info: {
        title: (input.title || input.body).slice(0, 2200),
        privacy_level: account.meta.privacyLevel ?? "SELF_ONLY",
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 },
    },
  });
  if (init?.error?.code && init.error.code !== "ok") {
    throw new Error(`tiktok init: ${init.error.code} ${init.error.message}`);
  }

  const upload = await fetch(init.data.upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": video.mime || "video/mp4",
      "Content-Range": `bytes 0-${size - 1}/${size}`,
      "Content-Length": String(size),
    },
    body: fs.createReadStream(video.absPath) as any,
    duplex: "half",
  } as any);
  if (!upload.ok) throw new Error(`tiktok upload ${upload.status}: ${(await upload.text()).slice(0, 300)}`);

  return {
    externalId: init.data.publish_id,
    permalink: undefined,
    raw: { publishId: init.data.publish_id },
  };
}

async function fetchMetrics(account: AccountRef): Promise<MetricSet> {
  const res = await request<any>("tiktok", `${API}/user/info/`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
    query: { fields: "follower_count,likes_count,video_count" },
  });
  const u = res?.data?.user ?? {};
  return { day: new Date().toISOString().slice(0, 10), followers: u.follower_count ?? 0, engagements: u.likes_count ?? 0, impressions: u.video_count ?? 0 };
}

async function exchangeCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier?: string;
}): Promise<any> {
  const res = await request<any>("tiktok", `${API}/oauth/token/`, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      grant_type: "authorization_code",
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier ?? "",
    }),
  });
  const user = await request<any>("tiktok", `${API}/user/info/`, {
    headers: { Authorization: `Bearer ${res.access_token}` },
    query: { fields: "open_id,union_id,avatar_url,display_name" },
  });
  const u = user?.data?.user ?? {};
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresIn: res.expires_in ?? 86400,
    scopes: res.scope,
    externalId: u.open_id ?? res.open_id,
    handle: u.display_name ?? null,
    displayName: u.display_name ?? null,
    accountType: "business",
    meta: { avatar: u.avatar_url },
  };
}

async function refresh(account: AccountRef, clientId: string, clientSecret: string) {
  const res = await request<any>("tiktok", `${API}/oauth/token/`, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: account.refreshToken ?? "",
    }),
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? account.refreshToken,
    expiresIn: res.expires_in ?? 86400,
    externalId: account.externalId,
    handle: account.handle,
  };
}

export const tiktokAdapter: PlatformAdapter = {
  key: "tiktok",
  label: "TikTok",
  glyph: "music-2",
  docsUrl: "https://developers.tiktok.com/doc/content-posting-api-get-started",
  capabilities: { oauth: "oauth2", nativeScheduling: false, kinds: ["video"], comments: true, metrics: true, rtmp: false, maxBodyLen: 2200 },
  oauth: {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: `${API}/oauth/token/`,
    scopes: ["user.info.basic", "video.upload", "video.publish", "video.list"],
    pkce: true,
  },
  exchangeCode,
  refresh,
  publish,
  fetchMetrics,
};

registerAdapter(tiktokAdapter);
export const tiktokPkce = () => crypto.randomBytes(32).toString("hex");
