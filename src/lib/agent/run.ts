import { complete } from "../ai";
import { all, one, run, uid, json, audit } from "../db";
import { TOOL_MAP, catalogForPrompt, gate, type ToolContext } from "./tools";

/**
 * Plan / act / observe loop. The model only ever chooses tool names that exist in the catalogue
 * and arguments that are validated against the tool schema; policy (autonomy) is enforced by
 * the gate before anything is executed, never by the model.
 */
const MAX_STEPS = 12;
export { MAX_STEPS };

const PLANNER = `You are the operations copilot of SocialDeck. You act on a social media operations platform
through a fixed tool catalogue. You never invent tools and never invent data.

Answer with strict JSON only, no prose, no markdown fences:
{"thought": "<one short sentence>", "tool": "<tool name>", "args": {...}, "done": false}

Rules:
- One tool call per response.
- Use args exactly as declared in the catalogue. Omit optional args you do not need.
- When the goal is achieved, reply: {"thought": "<summary>", "done": true}
- Never claim an action succeeded before its tool result says so.
- Prefer read-only tools first, then mutations.
- Text values must be in the language of the goal.

TOOL CATALOGUE
${catalogForPrompt()}`;

export interface StepResult {
  idx: number;
  thought: string | null;
  tool: string | null;
  args: Record<string, unknown>;
  result?: unknown;
  status: "ok" | "error" | "blocked" | "awaiting_approval";
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed" | "awaiting_approval";
  steps: StepResult[];
  summary: string;
}

export async function runGoal(
  goal: string,
  ctx: ToolContext & { planOnly?: boolean },
): Promise<RunResult> {
  const runId = uid("run");
  run(
    "INSERT INTO agent_runs (id, goal, status, autonomy, provider_id, created_by) VALUES (?, ?, 'running', ?, ?, ?)",
    runId,
    goal,
    ctx.autonomy,
    ctx.providerId ?? null,
    ctx.userId,
  );

  const transcript: string[] = [`GOAL: ${goal}`];
  const steps: StepResult[] = [];
  let summary = "";

  for (let idx = 0; idx < MAX_STEPS; idx++) {
    let decision: { thought?: string; tool?: string; args?: Record<string, unknown>; done?: boolean };
    try {
      const res = await complete(
        [
          { role: "system", content: PLANNER },
          { role: "user", content: transcript.join("\n") },
        ],
        { providerId: ctx.providerId, temperature: 0.1, maxTokens: 500 },
      );
      const match = res.text.match(/\{[\s\S]*\}/);
      decision = match ? json<typeof decision>(match[0], {}) : { done: true, thought: res.text.slice(0, 200) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run("UPDATE agent_runs SET status = 'failed', summary = ?, finished_at = datetime('now') WHERE id = ?", `planner failed: ${message}`, runId);
      return { runId, status: "failed", steps, summary: `planner failed: ${message}` };
    }

    if (decision.done && !decision.tool) {
      summary = decision.thought ?? "completed";
      break;
    }

    const toolName = String(decision.tool ?? "");
    const tool = TOOL_MAP.get(toolName);
    const thought = decision.thought ?? null;
    const args = (decision.args ?? {}) as Record<string, unknown>;

    const step: StepResult = { idx, thought, tool: toolName || null, args, status: "error" };

    if (!tool) {
      step.result = { error: `unknown tool: ${toolName}` };
      step.status = "error";
    } else {
      // Schema validation: required args present, values coerced to the declared type.
      const prepared: Record<string, unknown> = {};
      let validationError: string | null = null;
      for (const p of tool.parameters) {
        const raw = args[p.name];
        if (raw === undefined || raw === null || raw === "") {
          if (p.required) validationError = `missing required argument: ${p.name}`;
          continue;
        }
        if (p.type === "number") {
          const n = Number(raw);
          if (!Number.isFinite(n)) validationError = `${p.name} must be a number`;
          else prepared[p.name] = n;
        } else if (p.type === "boolean") {
          prepared[p.name] = raw === true || raw === "true" || raw === 1 || raw === "1";
        } else if (p.type === "array") {
          prepared[p.name] = Array.isArray(raw) ? raw : String(raw).split(",").map((s) => s.trim()).filter(Boolean);
        } else {
          prepared[p.name] = String(raw);
        }
      }
      if (validationError) {
        step.result = { error: validationError };
        step.status = "error";
      } else {
        const allowed = gate(tool, ctx);
        if (!allowed.allowed) {
          step.status = "requiresApproval" in allowed ? "awaiting_approval" : "blocked";
          step.result = { policy: allowed.reason };
          run(
            `INSERT INTO agent_steps (id, run_id, idx, thought, tool, args_json, result_json, status, requires_approval)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
            uid("stp"),
            runId,
            idx,
            thought,
            tool.name,
            JSON.stringify(prepared),
            JSON.stringify({ policy: allowed.reason }),
            "requiresApproval" in allowed ? 1 : 0,
          );
          steps.push(step);
          transcript.push(`STEP ${idx}: ${tool.name} -> BLOCKED (${allowed.reason})`);
          if ("requiresApproval" in allowed) {
            run("UPDATE agent_runs SET status = 'awaiting_approval', plan_json = ?, steps_taken = ? WHERE id = ?", JSON.stringify(steps), steps.length, runId);
            return { runId, status: "awaiting_approval", steps, summary: `parked for approval: ${tool.name}` };
          }
          continue;
        }
        try {
          step.result = await tool.run(prepared, ctx);
          step.status = "ok";
        } catch (err) {
          step.result = { error: err instanceof Error ? err.message : String(err) };
          step.status = "error";
        }
      }
    }

    run(
      `INSERT INTO agent_steps (id, run_id, idx, thought, tool, args_json, result_json, status, requires_approval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      uid("stp"),
      runId,
      idx,
      thought,
      toolName || null,
      JSON.stringify(args),
      JSON.stringify(step.result ?? null).slice(0, 6000),
      step.status,
    );
    steps.push(step);
    transcript.push(
      `STEP ${idx}: ${toolName} args=${JSON.stringify(args)} -> ${step.status.toUpperCase()} ${JSON.stringify(step.result ?? null).slice(0, 800)}`,
    );
  }

  if (!summary) summary = steps.length ? `executed ${steps.length} step(s)` : "no action taken";
  run(
    "UPDATE agent_runs SET status = 'completed', summary = ?, plan_json = ?, steps_taken = ?, finished_at = datetime('now') WHERE id = ?",
    summary,
    JSON.stringify(steps),
    steps.length,
    runId,
  );
  audit({ userId: ctx.userId, actor: "agent", action: "agent.run", entity: "agent_run", entityId: runId, detail: { goal, steps: steps.length } });
  return { runId, status: "completed", steps, summary };
}

/** Approve a parked step: executes exactly the stored args, then resumes is left to the operator. */
export async function approveStep(stepId: string, ctx: ToolContext) {
  const step = one<any>("SELECT * FROM agent_steps WHERE id = ?", stepId);
  if (!step) throw new Error("step not found");
  const tool = TOOL_MAP.get(step.tool);
  if (!tool) throw new Error(`unknown tool ${step.tool}`);
  const args = json<Record<string, unknown>>(step.args_json, {});
  const result = await tool.run(args, { ...ctx, autonomy: "autonomous" });
  run(
    "UPDATE agent_steps SET status = 'ok', result_json = ?, requires_approval = 0 WHERE id = ?",
    JSON.stringify(result ?? null).slice(0, 6000),
    stepId,
  );
  const remaining = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_steps WHERE run_id = ? AND status = 'pending'",
    step.run_id,
  )?.n ?? 0;
  if (remaining === 0) {
    run("UPDATE agent_runs SET status = 'completed', finished_at = datetime('now') WHERE id = ?", step.run_id);
  }
  audit({ userId: ctx.userId, actor: "agent", action: "agent.step.approved", entity: "agent_step", entityId: stepId, detail: { tool: step.tool } });
  return { stepId, result };
}

export function agentHistory(limit = 20) {
  return all(
    `SELECT r.id, r.goal, r.status, r.autonomy, r.summary, r.steps_taken, r.created_at, r.finished_at
     FROM agent_runs r ORDER BY r.created_at DESC LIMIT ?`,
    limit,
  );
}

export function agentRunDetail(runId: string) {
  const head = one<any>("SELECT * FROM agent_runs WHERE id = ?", runId);
  if (!head) return null;
  const steps = all<any>("SELECT * FROM agent_steps WHERE run_id = ? ORDER BY idx", runId);
  return { run: head, steps };
}
