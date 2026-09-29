import {
  type PlatformAdapter,
  type PublishInput,
  type PublishResult,
  type MetricSet,
  type AccountRef,
  registerAdapter,
  request,
  formEncode,
} from "./types";

const API = "https://api.pinterest.com/v5";

/** Pinterest pins: every pin needs a board id (stored on the account meta). */
async function publish(input: PublishInput): Promise<PublishResult> {
  const { account, media } = input;
  const token = account.accessToken;
  if (!token) throw new Error("pinterest account has no access token");
  const boardId = account.meta.boardId ?? account.externalId;
  const first = media[0];
  if (!first) throw new Error("pinterest pins require an image or video");
  const isVideo = first.mime.startsWith("video/");

  const res = await request<any>("pinterest", `${API}/pins`, {
    headers: { Authorization: `Bearer ${token}` },
    json: {
      board_id: boardId,
      title: (input.title || input.body.split("\n")[0]).slice(0, 100),
      description: input.body.slice(0, 800),
      link: input.linkUrl ?? undefined,
      media_source: isVideo
        ? { source_type: "video_id", cover_image_url: media[1]?.publicUrl, media_id: first.mediaId }
        : { source_type: "image_url", url: first.publicUrl },
    },
  });
  return { externalId: res.id, permalink: `https://pinterest.com/pin/${res.id}`, raw: res };
}

async function fetchMetrics(account: AccountRef): Promise<MetricSet> {
  const res = await request<any>("pinterest", `${API}/user_account`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  }).catch(() => null);
  return { day: new Date().toISOString().slice(0, 10), followers: res?.follower_count ?? 0, impressions: res?.pin_count ?? 0 };
}

async function exchangeCode(params: { code: string; redirectUri: string; clientId: string; clientSecret: string }) {
  const res = await request<any>("pinterest", "https://api.pinterest.com/v5/oauth/token", {
    headers: {
      Authorization: `Basic ${Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });
  const user = await request<any>("pinterest", `${API}/user_account`, {
    headers: { Authorization: `Bearer ${res.access_token}` },
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresIn: res.expires_in ?? 2592000,
    scopes: res.scope,
    externalId: user.username ?? user.id,
    handle: user.username,
    displayName: user.username,
    accountType: "business",
    meta: { accountId: user.id },
  };
}

async function refresh(account: AccountRef, clientId: string, clientSecret: string) {
  const res = await request<any>("pinterest", "https://api.pinterest.com/v5/oauth/token", {
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode({ grant_type: "refresh_token", refresh_token: account.refreshToken ?? "" }),
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? account.refreshToken,
    expiresIn: res.expires_in ?? 2592000,
    externalId: account.externalId,
    handle: account.handle,
  };
}

export const pinterestAdapter: PlatformAdapter = {
  key: "pinterest",
  label: "Pinterest",
  glyph: "pin",
  docsUrl: "https://developers.pinterest.com/docs/api/v5/",
  capabilities: { oauth: "oauth2", nativeScheduling: false, kinds: ["image", "video"], comments: false, metrics: true, rtmp: false, maxBodyLen: 800 },
  oauth: {
    authorizeUrl: "https://www.pinterest.com/oauth/",
    tokenUrl: "https://api.pinterest.com/v5/oauth/token",
    scopes: ["boards:read", "pins:read", "pins:write", "user_accounts:read"],
    pkce: false,
  },
  exchangeCode,
  refresh,
  publish,
  fetchMetrics,
};

registerAdapter(pinterestAdapter);
