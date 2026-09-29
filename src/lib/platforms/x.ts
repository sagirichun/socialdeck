import crypto from "node:crypto";
import fs from "node:fs";
import {
  type PlatformAdapter,
  type PublishInput,
  type PublishResult,
  type InboundComment,
  type MetricSet,
  type AccountRef,
  registerAdapter,
  request,
  formEncode,
} from "./types";

const API = "https://api.x.com/2";
const UPLOAD = "https://upload.x.com/1.1/media/upload.json";

const pkceVerifier = () => crypto.randomBytes(48).toString("base64url");
export const pkceChallenge = (verifier: string) =>
  crypto.createHash("sha256").update(verifier).digest("base64url");

/** Chunked v1.1 media upload, then create the v2 post referencing the media ids. */
async function uploadMedia(account: AccountRef, absPath: string, mime: string, alt?: string) {
  const token = account.accessToken!;
  const size = fs.statSync(absPath).size;
  const mediaType = mime.startsWith("video/") ? "video/mp4" : mime.startsWith("image/gif") ? "image/gif" : "image/jpeg";

  const init = await request<any>("x", UPLOAD, {
    headers: { Authorization: `Bearer ${token}` },
    body: formEncode({ command: "INIT", total_bytes: size, media_type: mediaType, media_category: mediaType === "video/mp4" ? "tweet_video" : "tweet_image" }),
  });

  const chunkSize = 2 * 1024 * 1024;
  const buf = fs.readFileSync(absPath);
  for (let i = 0, seg = 0; i < buf.length; i += chunkSize, seg++) {
    const chunk = buf.subarray(i, Math.min(i + chunkSize, buf.length));
    const form = new FormData();
    form.set("command", "APPEND");
    form.set("media_id", String(init.media_id));
    form.set("segment_index", String(seg));
    form.set("media", new Blob([chunk as any], { type: mediaType }), "chunk");
    const res = await fetch(UPLOAD, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    if (!res.ok) throw new Error(`x append ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const finalize = await request<any>("x", UPLOAD, {
    headers: { Authorization: `Bearer ${token}` },
    body: formEncode({ command: "FINALIZE", media_id: init.media_id }),
  });

  // Video processing is asynchronous: poll until the platform reports success.
  let info = finalize?.processing_info;
  for (let i = 0; info && info.state !== "succeeded" && i < 30; i++) {
    if (info.state === "failed") throw new Error(`x media processing failed: ${JSON.stringify(info.error)}`);
    await new Promise((r) => setTimeout(r, Math.min((info.check_after_secs ?? 5) * 1000, 10000)));
    const status = await request<any>("x", UPLOAD, {
      query: { command: "STATUS", media_id: init.media_id },
      headers: { Authorization: `Bearer ${token}` },
    });
    info = status?.processing_info;
  }

  if (alt) {
    await request<any>("x", `${UPLOAD}/metadata`, {
      headers: { Authorization: `Bearer ${token}` },
      body: formEncode({ media_id: init.media_id, alt_text: { text: alt } as any }),
    }).catch(() => null);
  }
  return String(init.media_id);
}

async function publish(input: PublishInput): Promise<PublishResult> {
  const { account, media } = input;
  if (!account.accessToken) throw new Error("x account has no access token");
  const ids: string[] = [];
  for (const m of media.slice(0, 4)) {
    ids.push(await uploadMedia(account, m.absPath, m.mime, m.filename));
  }
  const payload: Record<string, unknown> = { text: input.body.slice(0, 280) };
  if (ids.length === 1) payload.media = { media_ids: [ids[0]] };
  else if (ids.length > 1) payload.media = { media_ids: ids };
  if (input.linkUrl && !input.body.includes(input.linkUrl)) payload.text = `${payload.text}\n${input.linkUrl}`;

  const res = await request<any>("x", `${API}/tweets`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
    json: payload,
  });
  const id = res?.data?.id;
  return { externalId: String(id), permalink: `https://x.com/i/status/${id}`, raw: res };
}

async function fetchComments(account: AccountRef, sinceIso: string): Promise<InboundComment[]> {
  if (!account.accessToken) return [];
  const since = Math.floor(new Date(sinceIso).getTime() / 1000);
  const res = await request<any>("x", `${API}/users/${account.externalId}/mentions`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
    query: {
      max_results: 100,
      "tweet.fields": "author_id,created_at,conversation_id",
      expansions: "author_id",
      "user.fields": "username,name",
      start_time: new Date(since * 1000).toISOString(),
    },
  }).catch(() => ({ data: [] }));
  const users = new Map<string, any>((res?.includes?.users ?? []).map((u: any) => [u.id, u]));
  return (res?.data ?? []).map((t: any) => {
    const u = users.get(t.author_id);
    return {
      externalId: t.id,
      threadKind: "mention" as const,
      postExternalId: t.conversation_id ?? null,
      authorHandle: u?.username ?? null,
      authorName: u?.name ?? null,
      body: t.text ?? "",
      receivedAt: t.created_at,
    };
  });
}

async function reply(account: AccountRef, tweetId: string, body: string) {
  const res = await request<any>("x", `${API}/tweets`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
    json: { text: body.slice(0, 280), reply: { in_reply_to_tweet_id: tweetId } },
  });
  return { externalId: String(res?.data?.id) };
}

async function fetchMetrics(account: AccountRef): Promise<MetricSet> {
  const res = await request<any>("x", `${API}/users/${account.externalId}`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
    query: { "user.fields": "public_metrics" },
  });
  const m = res?.data?.public_metrics ?? {};
  return {
    day: new Date().toISOString().slice(0, 10),
    followers: m.followers_count ?? 0,
    impressions: m.tweet_count ?? 0,
    engagements: (m.like_count ?? 0) + (m.retweet_count ?? 0),
  };
}

async function exchangeCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier?: string;
}): Promise<any> {
  const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64");
  const res = await request<any>("x", "https://api.x.com/2/oauth2/token", {
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }),
  });
  const me = await request<any>("x", `${API}/users/me`, {
    headers: { Authorization: `Bearer ${res.access_token}` },
    query: { "user.fields": "username,name,profile_image_url" },
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresIn: res.expires_in ?? 7200,
    scopes: res.scope,
    externalId: me?.data?.id,
    handle: me?.data?.username,
    displayName: me?.data?.name,
    accountType: "profile",
    meta: { avatar: me?.data?.profile_image_url },
  };
}

async function refresh(account: AccountRef, clientId: string, clientSecret: string) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await request<any>("x", "https://api.x.com/2/oauth2/token", {
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({ grant_type: "refresh_token", refresh_token: account.refreshToken ?? "" }),
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? account.refreshToken,
    expiresIn: res.expires_in ?? 7200,
    externalId: account.externalId,
    handle: account.handle,
  };
}

export const xAdapter: PlatformAdapter = {
  key: "x",
  label: "X",
  glyph: "x",
  docsUrl: "https://docs.x.com/x-api",
  capabilities: { oauth: "oauth2", nativeScheduling: false, kinds: ["text", "image", "video"], comments: true, metrics: true, rtmp: false, maxBodyLen: 280 },
  oauth: {
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"],
    pkce: true,
  },
  exchangeCode,
  refresh,
  publish,
  fetchComments,
  reply,
  fetchMetrics,
  credentialFields: [],
};

registerAdapter(xAdapter);
export { pkceVerifier };
