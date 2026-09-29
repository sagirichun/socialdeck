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
import { sleep } from "./rest";

const GRAPH = "https://graph.threads.net/v1.0";

/** Threads publishing: container then publish, same handshake as Instagram. */
async function publish(input: PublishInput): Promise<PublishResult> {
  const { account, media } = input;
  const token = account.accessToken;
  if (!token) throw new Error("threads account has no access token");
  const uid = account.externalId;
  const first = media[0];
  const isVideo = first?.mime.startsWith("video/");

  const params: Record<string, unknown> = {
    access_token: token,
    text: input.body.slice(0, 500),
  };
  if (first) {
    params.media_type = isVideo ? "VIDEO" : "IMAGE";
    if (isVideo) params.video_url = first.publicUrl;
    else params.image_url = first.publicUrl;
  } else {
    params.media_type = "TEXT";
  }

  const container = await request<any>("threads", `${GRAPH}/${uid}/threads`, { json: params });
  if (isVideo) {
    for (let i = 0; i < 30; i++) {
      const status = await request<any>("threads", `${GRAPH}/${container.id}`, {
        query: { fields: "status,error_message", access_token: token },
      });
      if (status.status === "FINISHED") break;
      if (status.status === "ERROR" || status.status === "EXPIRED") throw new Error(`threads container ${status.status}: ${status.error_message ?? ""}`);
      await sleep(5000);
    }
  }
  const pub = await request<any>("threads", `${GRAPH}/${uid}/threads_publish`, {
    json: { creation_id: container.id, access_token: token },
  });
  return { externalId: pub.id, permalink: `https://threads.net/@${account.handle ?? "i"}/post/${pub.id}`, raw: pub };
}

async function fetchComments(account: AccountRef, sinceIso: string): Promise<InboundComment[]> {
  const token = account.accessToken;
  if (!token) return [];
  const since = new Date(sinceIso).getTime();
  const posts = await request<any>("threads", `${GRAPH}/${account.externalId}/threads`, {
    query: { fields: "id,timestamp,replies{id,text,username,timestamp}", limit: 25, access_token: token },
  }).catch(() => ({ data: [] }));
  const out: InboundComment[] = [];
  for (const p of posts?.data ?? []) {
    const replies = await request<any>("threads", `${GRAPH}/${p.id}/replies`, {
      query: { fields: "id,text,username,timestamp", access_token: token },
    }).catch(() => ({ data: [] }));
    for (const r of replies?.data ?? []) {
      if (new Date(r.timestamp).getTime() < since) continue;
      out.push({
        externalId: r.id,
        threadKind: "comment",
        postExternalId: p.id,
        authorHandle: r.username ?? null,
        authorName: r.username ?? null,
        body: r.text ?? "",
        receivedAt: r.timestamp,
      });
    }
  }
  return out;
}

async function reply(account: AccountRef, replyToId: string, body: string) {
  const container = await request<any>("threads", `${GRAPH}/${account.externalId}/threads`, {
    json: { media_type: "TEXT", text: body.slice(0, 500), reply_to_id: replyToId, access_token: account.accessToken },
  });
  const pub = await request<any>("threads", `${GRAPH}/${account.externalId}/threads_publish`, {
    json: { creation_id: container.id, access_token: account.accessToken },
  });
  return { externalId: pub.id };
}

async function fetchMetrics(account: AccountRef): Promise<MetricSet> {
  const res = await request<any>("threads", `${GRAPH}/${account.externalId}`, {
    query: { fields: "followers_count", access_token: account.accessToken },
  }).catch(() => null);
  return { day: new Date().toISOString().slice(0, 10), followers: res?.followers_count ?? 0 };
}

async function exchangeCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<any> {
  const token = await request<any>("threads", "https://graph.threads.net/oauth/access_token", {
    json: {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: params.redirectUri,
      code: params.code,
    },
  });
  const long = await request<any>("threads", "https://graph.threads.net/access_token", {
    query: {
      grant_type: "th_exchange_token",
      client_secret: params.clientSecret,
      access_token: token.access_token,
    },
  });
  const me = await request<any>("threads", `${GRAPH}/me`, {
    query: { fields: "id,username,name", access_token: long.access_token },
  });
  return {
    accessToken: long.access_token,
    expiresIn: long.expires_in ?? 5184000,
    externalId: me.id,
    handle: me.username,
    displayName: me.name ?? me.username,
    accountType: "profile",
  };
}

export const threadsAdapter: PlatformAdapter = {
  key: "threads",
  label: "Threads",
  glyph: "at-sign",
  docsUrl: "https://developers.facebook.com/docs/threads",
  capabilities: { oauth: "oauth2", nativeScheduling: false, kinds: ["text", "image", "video"], comments: true, metrics: true, rtmp: false, maxBodyLen: 500 },
  oauth: {
    authorizeUrl: "https://threads.net/oauth/authorize",
    tokenUrl: "https://graph.threads.net/oauth/access_token",
    scopes: ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_manage_insights"],
    pkce: false,
  },
  exchangeCode,
  publish,
  fetchComments,
  reply,
  fetchMetrics,
};

registerAdapter(threadsAdapter);
