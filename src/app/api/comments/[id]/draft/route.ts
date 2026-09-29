import { one } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route } from "@/lib/api";
import { draftForComment } from "@/lib/replies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Generate (or regenerate) the AI draft for one inbound message. */
export const POST = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole("owner", "admin", "operator");
  const { id } = await ctx.params;
  const comment = one<{ id: string }>("SELECT id FROM comments WHERE id = ?", id);
  if (!comment) return fail(404, "comment not found");

  const draft = await draftForComment(id);
  if (!draft) return ok({ ok: false, error: "no matching reply rule, or the rule is disabled for this account" });
  return ok(draft);
});
