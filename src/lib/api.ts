import { NextResponse } from "next/server";
import { HttpError } from "./auth";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

/** Wraps a route so thrown HttpErrors become clean responses and everything else logs once. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message);
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api]", message);
      return fail(500, message);
    }
  };
}

export async function readJson<T = any>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip");
}

export function parsePaging(url: string, defaults: { limit?: number; offset?: number } = {}) {
  const u = new URL(url);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? defaults.limit ?? 50), 1), 200);
  const offset = Math.max(Number(u.searchParams.get("offset") ?? defaults.offset ?? 0), 0);
  return { limit, offset, params: u.searchParams };
}
