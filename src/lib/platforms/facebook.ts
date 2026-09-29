import {
  type PlatformAdapter,
  type PublishInput,
  type PublishResult,
  type InboundComment,
  type MetricSet,
  type AccountRef,
  type TokenSet,
  registerAdapter,
  request,
  formEncode,
} from "./types";
import { platformBase } from "./rest";

const GRAPH = platformBase("facebook", "https://graph.facebook.com/v21.0");

async function publish(input: PublishInput): Promise<PublishResult> {
  const { account, media } = input;
  const token = account.accessToken;
  if (!token) throw new Error("facebook account has no access token");

  if (media.length === 0) {
    const res = await request<any>("facebook", `${GRAPH}/${account.externalId}/feed`, {
      json: { message: input.body, link: input.linkUrl ?? undefined, access_token: token },
    });
    return { externalId: res.id, permalink: `https://facebook.com/${res.id}`, raw: res };
  }

  const images = media.filter((m) => m.mime.startsWith("image/"));
  const videos = media.filter((m) => m.mime.startsWith("video/"));

  if (videos.length) {
    const res = await request<any>("facebook", `${GRAPH}/${account.externalId}/videos`, {
      json: {
        file_url: videos[0].publicUrl,
        description: input.body,
        title: input.title ?? undefined,
        access_token: token,
      },
    });
    return { externalId: res.id, permalink: `https://facebook.com/${res.id}`, raw: res };
  }

  // Multi-image post: upload unpublished photos then attach them.
  const ids: string[] = [];
  for (const img of images) {
    const up = await request<any>("facebook", `${GRAPH}/${account.externalId}/photos`, {
      json: { url: img.publicUrl, published: false, access_token: token },
    });
    ids.push(up.id);
  }
  const res = await request<any>("facebook", `${GRAPH}/${account.externalId}/feed`, {
    json: {
      message: input.body,
      attached_media: ids.map((id) => ({ media_fbid: id })),
      access_token: token,
    },
  });
  return { externalId: res.id, permalink: `https://facebook.com/${res.id}`, raw: res };
}

async function fetchComments(account: AccountRef, sinceIso: string): Promise<InboundComment[]> {
  const token = account.accessToken;
  if (!token) return [];
  const since = Math.floor(new Date(sinceIso).getTime() / 1000);
  const feed = await request<any>("facebook", `${GRAPH}/${account.externalId}/feed`, {
    query: { fields: "id,comments{id,message,from,created_time,parent{id}}", since, limit: 50, access_token: token },
  });
  const out: InboundComment[] = [];
  for (const post of feed?.data ?? []) {
    for (const c of post.comments?.data ?? []) {
      if (new Date(c.created_time).getTime() / 1000 < since) continue;
      out.push({
        externalId: c.id,
        parentExternalId: c.parent?.id ?? null,
        threadKind: "comment",
        postExternalId: post.id,
        authorHandle: c.from?.id ?? null,
        authorName: c.from?.name ?? null,
        body: c.message ?? "",
        receivedAt: c.created_time,
      });
    }
  }
  return out;
}

async function reply(account: AccountRef, commentId: string, body: string) {
  const res = await request<any>("facebook", `${GRAPH}/${commentId}/comments`, {
    json: { message: body, access_token: account.accessToken },
  });
  return { externalId: res.id };
}

async function fetchMetrics(account: AccountRef): Promise<MetricSet> {
  const res = await request<any>("facebook", `${GRAPH}/${account.externalId}`, {
    query: { fields: "followers_count,fan_count", access_token: account.accessToken } as Record<string, string | number>,
  });
  return { day: new Date().toISOString().slice(0, 10), followers: res.followers_count ?? res.fan_count ?? 0 };
}

async function exchangeCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenSet> {
  const tokenRes = await request<any>("facebook", `${GRAPH}/oauth/access_token`, {
    query: {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      code: params.code,
    },
  });
  // Exchange the short-lived user token for a long-lived one (60 days).
  const long = await request<any>("facebook", `${GRAPH}/oauth/access_token`, {
    query: {
      grant_type: "fb_exchange_token",
      client_id: params.clientId,
      client_secret: params.clientSecret,
      fb_exchange_token: tokenRes.access_token,
    },
  });
  const me = await request<any>("facebook", `${GRAPH}/me`, {
    query: { fields: "id,name", access_token: long.access_token },
  });
  const pages = await request<any>("facebook", `${GRAPH}/me/accounts`, {
    query: { access_token: long.access_token },
  });
  const page = pages?.data?.[0];
  return {
    accessToken: page?.access_token ?? long.access_token,
    expiresIn: long.expires_in ?? 5184000,
    externalId: page?.id ?? me.id,
    handle: page?.name ?? me.name,
    displayName: page?.name ?? me.name,
    accountType: page ? "page" : "profile",
    meta: { userToken: long.access_token, pages: (pages?.data ?? []).map((p: any) => ({ id: p.id, name: p.name })) },
  };
}

export const facebookAdapter: PlatformAdapter = {
  key: "facebook",
  label: "Facebook",
  glyph: "facebook",
  docsUrl: "https://developers.facebook.com/docs/pages-api",
  capabilities: { oauth: "oauth2", nativeScheduling: false, kinds: ["text", "image", "video"], comments: true, metrics: true, rtmp: false, maxBodyLen: 63206 },
  oauth: {
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: `${GRAPH}/oauth/access_token`,
    scopes: ["pages_manage_posts", "pages_read_engagement", "pages_manage_engagement", "read_insights"],
    pkce: false,
  },
  exchangeCode,
  publish,
  fetchComments,
  reply,
  fetchMetrics,
};

registerAdapter(facebookAdapter);
