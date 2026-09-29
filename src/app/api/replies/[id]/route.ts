import { one, run, audit } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";
import { sendReply, rejectReply, draftForComment } from "@/lib/replies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Approve / queue, reject, edit or redraft a single reply. */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole("owner", "admin", "operator");
  const { id } = await ctx.params;
  const body = await readJson<{ action?: string; body?: string; reason?: string }>(req);
  const row = one<any>("SELECT id, comment_id FROM replies WHERE id = ?", id);
  if (!row) return fail(404, "reply not found");

  switch (body.action) {
    case "approve": {
      if (body.body?.trim()) {
        run("UPDATE replies SET body = ? WHERE id = ?", body.body.trim(), id);
        audit({ userId: user.id, action: "reply.edited", entity: "reply", entityId: id });
      }
      return ok(await sendReply(id));
    }
    case "reject":
      rejectReply(id, body.reason ?? "rejected from inbox");
      return ok({ ok: true, rejected: id });
    case "edit": {
      if (!body.body?.trim()) return fail(400, "body is required");
      run("UPDATE replies SET body = ? WHERE id = ?", body.body.trim(), id);
      audit({ userId: user.id, action: "reply.edited", entity: "reply", entityId: id });
      return ok({ ok: true, updated: id });
    }
    case "regenerate": {
      run("DELETE FROM replies WHERE id = ? AND status IN ('pending','approved')", id);
      return ok((await draftForComment(row.comment_id)) ?? { ok: false, error: "no matching rule" });
    }
    case "blocked": {
      run("UPDATE replies SET status = 'blocked', error = ? WHERE id = ?", body.reason ?? "held for human escalation", id);
      audit({ userId: user.id, action: "reply.blocked", entity: "reply", entityId: id });
      return ok({ ok: true, blocked: id });
    }
    default:
      return fail(400, "unknown action");
  }
});

export const DELETE = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole("owner", "admin");
  const { id } = await ctx.params;
  run("DELETE FROM replies WHERE id = ?", id);
  audit({ userId: user.id, action: "reply.deleted", entity: "reply", entityId: id });
  return ok({ deleted: id });
});
