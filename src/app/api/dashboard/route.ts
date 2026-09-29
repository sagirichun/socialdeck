import { all, one } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, route } from "@/lib/api";
import { refreshAccountToken } from "@/lib/platforms";
import { syncComments } from "@/lib/replies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AccountRow {
  id: string;
  platform: string;
  handle: string | null;
  display_name: string | null;
  status: string;
}

/** Dashboard summary: totals, trend series, platform mix, health. */
export const GET = route(async (req: Request) => {
  await requireRole();
  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 7), 90);

  const totals = one<any>(
    `SELECT
       (SELECT COUNT(*) FROM accounts) AS accounts,
       (SELECT COUNT(*) FROM accounts WHERE status = 'connected') AS connected,
       (SELECT COUNT(*) FROM posts WHERE status = 'published' AND updated_at >= datetime('now', ?)) AS published,
       (SELECT COUNT(*) FROM posts WHERE status IN ('scheduled','queued')) AS queued,
       (SELECT COUNT(*) FROM posts WHERE status = 'failed') AS failed,
       (SELECT COUNT(*) FROM comments WHERE received_at >= datetime('now', ?)) AS inbound,
       (SELECT COUNT(*) FROM replies WHERE created_at >= datetime('now', ?)) AS replies,
       (SELECT COUNT(*) FROM replies WHERE status = 'pending') AS pending_replies,
       (SELECT AVG(sentiment) FROM comments WHERE received_at >= datetime('now', ?) AND sentiment IS NOT NULL) AS sentiment,
       (SELECT COUNT(*) FROM streams WHERE state = 'live') AS live_streams`,
    `-${days} day`,
    `-${days} day`,
    `-${days} day`,
    `-${days} day`,
  );

  const followerSeries = all<any>(
    `SELECT day, SUM(followers) AS followers, SUM(impressions) AS impressions,
            SUM(engagements) AS engagements, SUM(posts_published) AS posts, SUM(comments_in) AS inbound, SUM(replies_sent) AS replies
     FROM analytics_daily WHERE day >= date('now', ?) GROUP BY day ORDER BY day`,
    `-${days} day`,
  );

  const platformMix = all<any>(
    `SELECT a.platform,
            COUNT(DISTINCT a.id) AS accounts,
            COALESCE(SUM(ad.engagements), 0) AS engagements,
            COALESCE(MAX(ad.followers), 0) AS followers
     FROM accounts a LEFT JOIN analytics_daily ad ON ad.account_id = a.id AND ad.day >= date('now', ?)
     GROUP BY a.platform ORDER BY followers DESC`,
    `-${days} day`,
  );

  const recentPosts = all<any>(
    `SELECT p.id, p.status, p.kind, substr(p.body, 1, 120) AS body, p.scheduled_at, p.updated_at, p.permalink,
            a.platform, a.handle
     FROM posts p JOIN accounts a ON a.id = p.account_id
     ORDER BY p.updated_at DESC LIMIT 8`,
  );

  const recentInbound = all<any>(
    `SELECT c.id, c.platform, c.author_handle, substr(c.body, 1, 140) AS body, c.risk, c.sentiment, c.received_at,
            (SELECT status FROM replies r WHERE r.comment_id = c.id ORDER BY r.created_at DESC LIMIT 1) AS reply_status
     FROM comments c ORDER BY c.received_at DESC LIMIT 8`,
  );

  const sentimentByDay = all<any>(
    `SELECT date(received_at) AS day, AVG(sentiment) AS sentiment, COUNT(*) AS n
     FROM comments WHERE received_at >= datetime('now', ?) AND sentiment IS NOT NULL
     GROUP BY date(received_at) ORDER BY day`,
    `-${days} day`,
  );

  const platformHealth = all<any>(
    `SELECT platform, status, COUNT(*) AS count FROM accounts GROUP BY platform, status ORDER BY platform`,
  );

  const queueTrend = all<any>(
    `SELECT date(created_at) AS day,
            SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM job_runs WHERE created_at >= datetime('now', ?) GROUP BY date(created_at) ORDER BY day`,
    `-${days} day`,
  );

  return ok({
    days,
    totals: {
      accounts: Number(totals?.accounts ?? 0),
      connected: Number(totals?.connected ?? 0),
      published: Number(totals?.published ?? 0),
      queued: Number(totals?.queued ?? 0),
      failed: Number(totals?.failed ?? 0),
      inbound: Number(totals?.inbound ?? 0),
      replies: Number(totals?.replies ?? 0),
      pendingReplies: Number(totals?.pending_replies ?? 0),
      sentiment: totals?.sentiment ?? null,
      liveStreams: Number(totals?.live_streams ?? 0),
    },
    followerSeries,
    platformMix,
    recentPosts,
    recentInbound,
    sentimentByDay,
    platformHealth,
    queueTrend,
  });
});

/** Maintenance actions used from the dashboard: token refresh and inbox sync. */
export const POST = route(async (req: Request) => {
  await requireRole("owner", "admin", "operator");
  const body = (await req.json().catch(() => ({}))) as { action?: string; accountId?: string };
  if (body.action === "refresh" && body.accountId) {
    const account = await refreshAccountToken(body.accountId);
    return ok({ refreshed: account?.id ?? body.accountId, status: account ? "connected" : "skipped" });
  }
  if (body.action === "sync" && body.accountId) {
    return ok(await syncComments(body.accountId));
  }
  return ok({ noop: true });
});
