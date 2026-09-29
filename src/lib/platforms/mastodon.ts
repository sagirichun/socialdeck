import {
  type PlatformAdapter,
  type PublishInput,
  type PublishResult,
  type InboundComment,
  type MetricSet,
  type AccountRef,
  registerAdapter,
} from "./types";

/**
 * Mastodon is decentralised: the instance host lives in the account meta and every call is
 * scoped to it. Credentials are created with the instance's own developer console, so the
 * flow is manual rather than OAuth-redirect based.
 */
function host(account: AccountRef) {
  const h = account.meta.instance || account.meta.host;
  if (!h) throw new Error("mastodon account is missing its instance host in meta");
  return String(h).replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function publish(input: PublishInput): Promise<PublishResult> {
  const { account, media } = input;
  const base = `https://${host(account)}`;
  const token = account.accessToken;
  if (!token) throw new Error("mastodon account has no access token");
  const ids: string[] = [];
  for (const m of media.slice(0, 4)) {
    const form = new FormData();
    const bytes = await (await import("node:fs")).promises.readFile(m.absPath);
    form.set("file", new Blob([bytes as any], { type: m.mime }), m.filename);
    form.set("description", m.filename);
    const res = await fetch(`${base}/api/v2/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) throw new Error(`mastodon media ${res.status}: ${(await res.text()).slice(0, 200)}`);
    ids.push((await res.json()).id);
  }
  const res = await fetch(`${base}/api/v1/statuses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: input.body.slice(0, 500), media_ids: ids.length ? ids : undefined }),
  });
  if (!res.ok) throw new Error(`mastodon post ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { externalId: String(data.id), permalink: data.url, raw: data };
}

async function fetchComments(account: AccountRef, sinceIso: string): Promise<InboundComment[]> {
  const base = `https://${host(account)}`;
  const token = account.accessToken;
  if (!token) return [];
  const res = await fetch(`${base}/api/v1/notifications?types[]=mention&limit=40`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const items = (await res.json()) as any[];
  const since = new Date(sinceIso).getTime();
  return items
    .filter((n) => new Date(n.created_at).getTime() >= since)
    .map((n) => ({
      externalId: String(n.status?.id ?? n.id),
      threadKind: "mention" as const,
      postExternalId: n.status?.in_reply_to_id ? String(n.status.in_reply_to_id) : null,
      authorHandle: n.account?.acct ?? null,
      authorName: n.account?.display_name ?? null,
      body: stripHtml(n.status?.content ?? ""),
      receivedAt: n.created_at,
    }));
}

function stripHtml(html: string) {
  return html.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").trim();
}

async function reply(account: AccountRef, statusId: string, body: string) {
  const base = `https://${host(account)}`;
  const res = await fetch(`${base}/api/v1/statuses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${account.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: body, in_reply_to_id: statusId }),
  });
  if (!res.ok) throw new Error(`mastodon reply ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { externalId: String(data.id) };
}

async function fetchMetrics(account: AccountRef): Promise<MetricSet> {
  const base = `https://${host(account)}`;
  const res = await fetch(`${base}/api/v1/accounts/verify_credentials`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  }).catch(() => null);
  if (!res?.ok) return { day: new Date().toISOString().slice(0, 10) };
  const data: any = await res.json();
  return {
    day: new Date().toISOString().slice(0, 10),
    followers: data.followers_count ?? 0,
    engagements: data.statuses_count ?? 0,
  };
}

export const mastodonAdapter: PlatformAdapter = {
  key: "mastodon",
  label: "Mastodon",
  glyph: "globe",
  docsUrl: "https://docs.joinmastodon.org/methods/statuses/",
  capabilities: { oauth: "manual", nativeScheduling: false, kinds: ["text", "image", "video"], comments: true, metrics: true, rtmp: false, maxBodyLen: 500 },
  credentialFields: [
    { name: "instance", label: "Instance host", secret: false },
    { name: "accessToken", label: "Access token", secret: true },
  ],
  publish,
  fetchComments,
  reply,
  fetchMetrics,
};

registerAdapter(mastodonAdapter);
