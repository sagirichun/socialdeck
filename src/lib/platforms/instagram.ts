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

const GRAPH = "https://graph.facebook.com/v21.0";

/** Instagram Graph API: container + publish handshake, with polling for video containers. */
async function publish(input: PublishInput): Promise<PublishResult> {
  const { account, media } = input;
  const token = account.accessToken;
  const igId = account.externalId;
  if (!token) throw new Error("instagram account has no access token");

  if (media.length === 0) throw new Error("instagram requires at least one image or video");

  const first = media[0];
  const isVideo = first.mime.startsWith("video/");
  const isReel = isVideo && (input.kind === "reel" || input.kind === "short");
  const isStory = input.kind === "story";

  const containerParams: Record<string, string | undefined> = isVideo
    ? {
        media_type: isReel ? "REELS" : "VIDEO",
        video_url: first.publicUrl,
        caption: input.body,
        cover_url: media[1]?.publicUrl,
      }
    : { image_url: first.publicUrl, caption: input.body, is_carousel_item: media.length > 1 ? "true" : undefined };

  if (isStory) containerParams.media_type = "STORIES";

  const container = await request<any>("instagram", `${GRAPH}/${igId}/media`, {
    json: { ...containerParams, access_token: token },
  });

  // Carousel children need their own containers.
  if (!isVideo && media.length > 1) {
    const children: string[] = [container.id];
    for (const extra of media.slice(1)) {
      const child = await request<any>("instagram", `${GRAPH}/${igId}/media`, {
        json: { image_url: extra.publicUrl, is_carousel_item: true, access_token: token },
      });
      children.push(child.id);
    }
    const carousel = await request<any>("instagram", `${GRAPH}/${igId}/media`, {
      json: { media_type: "CAROUSEL", children: children.join(","), caption: input.body, access_token: token },
    });
    return finalize(igId, carousel.id, token, isVideo);
  }

  return finalize(igId, container.id, token, Boolean(containerParams.media_type));
}

async function finalize(igId: string, containerId: string, token: string | null, waitForReady: boolean): Promise<PublishResult> {
  if (waitForReady) {
    for (let i = 0; i < 30; i++) {
      const status = await request<any>("instagram", `${GRAPH}/${containerId}`, {
        query: { fields: "status_code,status", access_token: token },
      });
      if (status.status_code === "FINISHED") break;
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
        throw new Error(`instagram container ${status.status_code}: ${status.status ?? ""}`);
      }
      await sleep(5000 * Math.min(i + 1, 4));
    }
  }
  const published = await request<any>("instagram", `${GRAPH}/${igId}/media_publish`, {
    json: { creation_id: containerId, access_token: token },
  });
  const info = await request<any>("instagram", `${GRAPH}/${published.id}`, {
    query: { fields: "permalink", access_token: token },
  }).catch(() => null);
  return { externalId: published.id, permalink: info?.permalink, raw: published };
}

async function fetchComments(account: AccountRef, sinceIso: string): Promise<InboundComment[]> {
  const token = account.accessToken;
  if (!token) return [];
  const since = Math.floor(new Date(sinceIso).getTime() / 1000);
  const media = await request<any>("instagram", `${GRAPH}/${account.externalId}/media`, {
    query: { fields: "id,caption,timestamp,comments{id,text,username,timestamp}", limit: 25, access_token: token },
  });
  const out: InboundComment[] = [];
  for (const m of media?.data ?? []) {
    for (const c of m.comments?.data ?? []) {
      if (new Date(c.timestamp).getTime() / 1000 < since) continue;
      out.push({
        externalId: c.id,
        threadKind: "comment",
        postExternalId: m.id,
        authorHandle: c.username ?? null,
        authorName: c.username ?? null,
        body: c.text ?? "",
        receivedAt: c.timestamp,
      });
    }
  }
  return out;
}

async function reply(account: AccountRef, commentId: string, body: string) {
  const res = await request<any>("instagram", `${GRAPH}/${commentId}/replies`, {
    json: { message: body, access_token: account.accessToken },
  });
  return { externalId: res.id };
}

async function fetchMetrics(account: AccountRef): Promise<MetricSet> {
  const res = await request<any>("instagram", `${GRAPH}/${account.externalId}`, {
    query: { fields: "followers_count,media_count", access_token: account.accessToken },
  });
  return { day: new Date().toISOString().slice(0, 10), followers: res.followers_count ?? 0 };
}

async function exchangeCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<any> {
  const token = await request<any>("instagram", `${GRAPH}/oauth/access_token`, {
    query: {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      code: params.code,
    },
  });
  const pages = await request<any>("facebook", `${GRAPH}/me/accounts`, {
    query: { fields: "id,name,instagram_business_account", access_token: token.access_token },
  });
  const page = (pages?.data ?? []).find((p: any) => p.instagram_business_account);
  const igId = page?.instagram_business_account?.id;
  if (!igId) throw new Error("no Instagram business account linked to any managed Facebook page");
  const ig = await request<any>("instagram", `${GRAPH}/${igId}`, {
    query: { fields: "id,username,name,followers_count", access_token: token.access_token },
  });
  return {
    accessToken: token.access_token,
    expiresIn: 5184000,
    externalId: ig.id,
    handle: ig.username,
    displayName: ig.name ?? ig.username,
    accountType: "business",
    meta: { pageId: page.id, igId: ig.id },
  };
}

export const instagramAdapter: PlatformAdapter = {
  key: "instagram",
  label: "Instagram",
  glyph: "instagram",
  docsUrl: "https://developers.facebook.com/docs/instagram-api",
  capabilities: { oauth: "oauth2", nativeScheduling: false, kinds: ["image", "video"], comments: true, metrics: true, rtmp: false, maxBodyLen: 2200 },
  oauth: {
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: `${GRAPH}/oauth/access_token`,
    scopes: ["instagram_basic", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_insights", "pages_show_list"],
    pkce: false,
  },
  exchangeCode,
  publish,
  fetchComments,
  reply,
  fetchMetrics,
};

registerAdapter(instagramAdapter);
