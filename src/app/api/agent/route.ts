import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";
import { runGoal, agentHistory, agentRunDetail, approveStep, MAX_STEPS } from "@/lib/agent/run";
import { toolCatalog } from "@/lib/agent/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireRole();
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  if (runId) {
    const detail = agentRunDetail(runId);
    if (!detail) return fail(404, "run not found");
    return ok(detail);
  }

  const tools = toolCatalog();
  return ok({
    runs: agentHistory(30),
    tools,
    // The console renders a capability table; arguments are already in `tools`.
    catalog: tools.map((t) => ({
      name: t.name,
      description: t.description,
      writes: t.mutating,
      parameters: t.parameters,
    })),
    autonomy: ["suggest", "supervised", "autonomous"],
    maxSteps: MAX_STEPS,
  });
});

export const POST = route(async (req: Request) => {
  const user = await requireRole("owner", "admin", "operator");
  const body = await readJson<{
    action?: "run" | "approve";
    goal?: string;
    autonomy?: "suggest" | "supervised" | "autonomous";
    providerId?: string;
    stepId?: string;
  }>(req);

  if (body.action === "approve" && body.stepId) {
    const res = await approveStep(body.stepId, { autonomy: "autonomous", userId: user.id });
    return ok(res);
  }

  if (!body.goal?.trim()) return fail(400, "goal is required");
  const autonomy = body.autonomy ?? "supervised";
  const res = await runGoal(body.goal, { autonomy, userId: user.id, providerId: body.providerId ?? null });
  return ok(res);
});
