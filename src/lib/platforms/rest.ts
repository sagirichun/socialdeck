/** Shared HTTP helper for platform adapters: consistent timeouts, retries and error text. */

export class PlatformError extends Error {
  constructor(
    readonly platform: string,
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(`[${platform}] ${status} ${message}`.slice(0, 500));
    this.name = "PlatformError";
  }
}

export interface QueryValue {
  [key: string]: string | number | boolean | null | undefined;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  json?: unknown;
  body?: BodyInit;
  query?: QueryValue;
  retries?: number;
  timeoutMs?: number;
}

function withQuery(url: string, query?: RequestOptions["query"]) {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

export async function request<T = any>(
  platform: string,
  url: string,
  opts: RequestOptions = {},
): Promise<T> {
  const attempts = (opts.retries ?? 2) + 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000);
    try {
      const res = await fetch(withQuery(url, opts.query), {
        method: opts.method ?? (opts.json || opts.body ? "POST" : "GET"),
        headers: {
          Accept: "application/json",
          ...(opts.json ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body ?? (opts.json ? JSON.stringify(opts.json) : undefined),
        signal: controller.signal,
      });
      const text = await res.text();
      const isJson = (res.headers.get("content-type") ?? "").includes("json");
      const payload = text && isJson ? safeJson(text) : text;
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && i < attempts - 1) {
          await sleep(400 * 2 ** i);
          continue;
        }
        throw new PlatformError(platform, res.status, extractMessage(payload, text), payload);
      }
      return payload as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof PlatformError) throw err;
      if (i === attempts - 1) break;
      await sleep(400 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new PlatformError(
    platform,
    0,
    lastErr instanceof Error ? lastErr.message : "network failure",
  );
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const p = payload as any;
    return (
      p.error?.message ??
      p.error_description ??
      p.message ??
      p.error?.error_user_msg ??
      (Array.isArray(p.errors) ? p.errors[0]?.message : undefined) ??
      fallback
    );
  }
  return String(payload || fallback);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a platform's base URL. Staging and sandbox deployments point the same adapter code at
 * a mock ingest without editing the adapter, which is also how the automated check exercises it.
 */
export const platformBase = (key: string, fallback: string): string =>
  (process.env[`PLATFORM_BASE_${key.toUpperCase()}`] || process.env.PLATFORM_BASE_OVERRIDE || fallback).replace(
    /\/+$/,
    "",
  );

export const formEncode = (data: Record<string, string | number | undefined>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) if (v !== undefined) body.set(k, String(v));
  return body;
};
