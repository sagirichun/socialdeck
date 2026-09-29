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

const API = "https://api.linkedin.com/v2";
const REST = "https://api.linkedin.com/rest";

/**
 * LinkedIn: register the asset (image/video) through the Assets API, upload the binary,
 * then create a ugcPost with the asset URN attached.
 */
async function uploadImage(account: AccountRef, absPath: string, mime: string) {
  const token = account.accessToken!;
  const register = await request<any>("linkedin", `${API}/assets?action=registerUpload`, {
    headers: { Authorization: `Bearer ${token}`, "X-Restli-Protocol-Version": "2.0.0" },
    json: {
      registerUploadRequest: {
        owner: `urn:li:person:${account.externalId}`,
        recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
        serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
      },
    },
  });
  const mech = register.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"];
  const bytes = await (await import("node:fs")).promises.readFile(absPath);
  const res = await fetch(mech.uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": mime },
    body: bytes,
  });
  if (!res.ok) throw new Error(`linkedin asset upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return register.value.asset as string;
}

async function publish(input: PublishInput): Promise<PublishResult> {
  const { account, media } = input;
  const token = account.accessToken;
  if (!token) throw new Error("linkedin account has no access token");
  const author = `urn:li:person:${account.externalId}`;
  const assets: string[] = [];
  for (const m of media.filter((x) => x.mime.startsWith("image/"))) assets.push(await uploadImage(account, m.absPath, m.mime));

  const body = {
    author,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: input.body },
        shareMediaCategory: assets.length ? "IMAGE" : input.linkUrl ? "ARTICLE" : "NONE",
        media: assets.map((a) => ({ status: "READY", media: a })),
        ...(input.linkUrl && !assets.length
          ? { media: [{ status: "READY", originalUrl: input.linkUrl }] }
          : {}),
      },
    },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  };

  const res = await request<any>("linkedin", `${API}/ugcPosts`, {
    headers: { Authorization: `Bearer ${token}`, "X-Restli-Protocol-Version": "2.0.0" },
    json: body,
  });
  const id = res.id as string;
  return { externalId: id, permalink: `https://www.linkedin.com/feed/update/${id}`, raw: res };
}

async function fetchComments(account: AccountRef, sinceIso: string): Promise<InboundComment[]> {
  const token = account.accessToken;
  if (!token) return [];
  const posts = await request<any>("linkedin", `${REST}/posts`, {
    headers: { Authorization: `Bearer ${token}`, "Linkedin-Version": "202411", "X-Restli-Protocol-Version": "2.0.0" },
    query: { author: `urn:li:person:${account.externalId}`, q: "author", count: 20 },
  }).catch(() => ({ elements: [] }));
  const since = new Date(sinceIso).getTime();
  const out: InboundComment[] = [];
  for (const post of posts?.elements ?? []) {
    const urn = post.id;
    const comments = await request<any>("linkedin", `${API}/socialActions/${encodeURIComponent(urn)}/comments`, {
      headers: { Authorization: `Bearer ${token}`, "X-Restli-Protocol-Version": "2.0.0" },
      query: { count: 50 },
    }).catch(() => ({ elements: [] }));
    for (const c of comments?.elements ?? []) {
      const created = c.created?.time ?? 0;
      if (created < since) continue;
      out.push({
        externalId: c.id,
        threadKind: "comment",
        postExternalId: urn,
        authorHandle: c.actor?.split(":").pop() ?? null,
        authorName: null,
        body: c.message?.text ?? "",
        receivedAt: new Date(created).toISOString(),
      });
    }
  }
  return out;
}

async function reply(account: AccountRef, commentUrn: string, body: string) {
  const postUrn = commentUrn.split(",")?.[0] ?? commentUrn;
  const res = await request<any>("linkedin", `${API}/socialActions/${encodeURIComponent(postUrn)}/comments`, {
    headers: { Authorization: `Bearer ${account.accessToken}`, "X-Restli-Protocol-Version": "2.0.0" },
    json: { actor: `urn:li:person:${account.externalId}`, message: { text: body }, parentComment: commentUrn },
  });
  return { externalId: res.id ?? "unknown" };
}

async function fetchMetrics(account: AccountRef): Promise<MetricSet> {
  const res = await request<any>("linkedin", `${REST}/networkSizes/urn:li:person:${account.externalId}`, {
    headers: { Authorization: `Bearer ${account.accessToken}`, "Linkedin-Version": "202411" },
    query: { edgeType: "CompanyFollowedByMember" },
  }).catch(() => null);
  return { day: new Date().toISOString().slice(0, 10), followers: res?.firstDegreeSize ?? 0 };
}

async function exchangeCode(params: { code: string; redirectUri: string; clientId: string; clientSecret: string }) {
  const res = await request<any>("linkedin", "https://www.linkedin.com/oauth/v2/accessToken", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    }),
  });
  const me = await request<any>("linkedin", `${API}/userinfo`, {
    headers: { Authorization: `Bearer ${res.access_token}` },
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresIn: res.expires_in ?? 5184000,
    scopes: res.scope,
    externalId: me.sub,
    handle: me.preferred_username ?? me.name,
    displayName: me.name,
    accountType: "profile",
    meta: { picture: me.picture },
  };
}

export const linkedinAdapter: PlatformAdapter = {
  key: "linkedin",
  label: "LinkedIn",
  glyph: "linkedin",
  docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
  capabilities: { oauth: "oauth2", nativeScheduling: false, kinds: ["text", "image"], comments: true, metrics: true, rtmp: false, maxBodyLen: 3000 },
  oauth: {
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid", "profile", "w_member_social", "r_organization_social", "w_organization_social"],
    pkce: false,
  },
  exchangeCode,
  publish,
  fetchComments,
  reply,
  fetchMetrics,
};

registerAdapter(linkedinAdapter);
