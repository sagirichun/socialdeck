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
} from "./types";

const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
const API = "https://www.googleapis.com/youtube/v3";

/** Resumable upload: YouTube requires the whole file put in one session; we stream it from disk. */
async function publish(input: PublishInput): Promise<PublishResult> {
  const { account, media } = input;
  const token = account.accessToken;
  if (!token) throw new Error("youtube account has no access token");
  const video = media.find((m) => m.mime.startsWith("video/"));
  if (!video) throw new Error("youtube posts require a video file");

  const meta = {
    snippet: {
      title: (input.title || input.body.split("\n")[0] || "Untitled").slice(0, 100),
      description: input.body,
      categoryId: account.meta.categoryId ?? "22",
    },
    status: {
      privacyStatus: account.meta.privacyStatus ?? "private",
      selfDeclaredMadeForKids: false,
    },
  };

  const init = await fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": video.mime,
      "X-Upload-Content-Length": String(fs.statSync(video.absPath).size),
    },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(`youtube session ${init.status}: ${(await init.text()).slice(0, 300)}`);
  const sessionUrl = init.headers.get("location");
  if (!sessionUrl) throw new Error("youtube did not return an upload session URL");

  const uploaded = await fetch(sessionUrl, {
    method: "PUT",
    headers: { "Content-Type": video.mime, "Content-Length": String(fs.statSync(video.absPath).size) },
    body: fs.createReadStream(video.absPath) as any,
    duplex: "half",
  } as any);
  const body = await uploaded.text();
  if (!uploaded.ok) throw new Error(`youtube upload ${uploaded.status}: ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body);
  return { externalId: parsed.id, permalink: `https://youtube.com/watch?v=${parsed.id}`, raw: parsed };
}

/** Captions-based comment sync: the channel's recent comment threads. */
async function fetchComments(account: AccountRef, sinceIso: string): Promise<InboundComment[]> {
  const token = account.accessToken;
  if (!token) return [];
  const res = await request<any>("youtube", `${API}/commentThreads`, {
    query: { part: "snippet,replies", allThreadsRelatedToChannelId: account.externalId, maxResults: 50, access_token: token },
  });
  const since = new Date(sinceIso).getTime();
  const out: InboundComment[] = [];
  for (const item of res?.items ?? []) {
    const top = item.snippet?.topLevelComment?.snippet;
    const published = top?.publishedAt ? new Date(top.publishedAt).getTime() : 0;
    if (published < since) continue;
    out.push({
      externalId: item.snippet.topLevelComment.id,
      threadKind: "comment",
      postExternalId: item.snippet.videoId,
      authorHandle: top?.authorChannelId?.value ?? null,
      authorName: top?.authorDisplayName ?? null,
      body: top?.textDisplay ?? "",
      receivedAt: top?.publishedAt,
    });
    for (const r of item.replies?.comments ?? []) {
      const rs = r.snippet;
      if (new Date(rs.publishedAt).getTime() < since) continue;
      out.push({
        externalId: r.id,
        parentExternalId: item.snippet.topLevelComment.id,
        threadKind: "comment",
        postExternalId: item.snippet.videoId,
        authorHandle: rs.authorChannelId?.value ?? null,
        authorName: rs.authorDisplayName ?? null,
        body: rs.textDisplay ?? "",
        receivedAt: rs.publishedAt,
      });
    }
  }
  return out;
}

async function reply(account: AccountRef, parentCommentId: string, body: string) {
  const res = await request<any>("youtube", `${API}/comments`, {
    method: "POST",
    query: { part: "snippet", access_token: account.accessToken },
    json: { snippet: { parentId: parentCommentId, textOriginal: body } },
  });
  return { externalId: res.id };
}

async function fetchMetrics(account: AccountRef): Promise<MetricSet> {
  const res = await request<any>("youtube", `${API}/channels`, {
    query: { part: "statistics", id: account.externalId, access_token: account.accessToken },
  });
  const s = res?.items?.[0]?.statistics ?? {};
  return {
    day: new Date().toISOString().slice(0, 10),
    followers: Number(s.subscriberCount ?? 0),
    impressions: Number(s.viewCount ?? 0),
    engagements: Number(s.commentCount ?? 0),
  };
}

async function exchangeCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<any> {
  const res = await request<any>("youtube", "https://oauth2.googleapis.com/token", {
    json: {
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: "authorization_code",
    },
  });
  const channel = await request<any>("youtube", `${API}/channels`, {
    query: { part: "snippet,statistics", mine: true, access_token: res.access_token },
  });
  const ch = channel?.items?.[0];
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresIn: res.expires_in ?? 3600,
    scopes: res.scope,
    externalId: ch?.id ?? "unknown",
    handle: ch?.snippet?.customUrl ?? null,
    displayName: ch?.snippet?.title ?? null,
    accountType: "channel",
    meta: { channelTitle: ch?.snippet?.title },
  };
}

async function refresh(account: AccountRef, clientId: string, clientSecret: string) {
  const res = await request<any>("youtube", "https://oauth2.googleapis.com/token", {
    json: {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    },
  });
  return {
    accessToken: res.access_token,
    refreshToken: account.refreshToken,
    expiresIn: res.expires_in ?? 3600,
    externalId: account.externalId,
  };
}

export const youtubeAdapter: PlatformAdapter = {
  key: "youtube",
  label: "YouTube",
  glyph: "youtube",
  docsUrl: "https://developers.google.com/youtube/v3/docs/videos/insert",
  capabilities: { oauth: "oauth2", nativeScheduling: true, kinds: ["video"], comments: true, metrics: true, rtmp: true, maxBodyLen: 5000 },
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.force-ssl",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    ],
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    pkce: false,
  },
  exchangeCode,
  refresh,
  publish,
  fetchComments,
  reply,
  fetchMetrics,
};

registerAdapter(youtubeAdapter);
