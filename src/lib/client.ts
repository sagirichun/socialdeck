"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ApiError {
  status: number;
  message: string;
}

export { useToast } from "@/components/ui";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const text = await res.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { ok: false, error: text.slice(0, 300) };
  }
  if (!res.ok || payload?.ok === false) {
    const err: ApiError = { status: res.status, message: payload?.error ?? `request failed (${res.status})` };
    throw err;
  }
  return (payload?.data ?? payload) as T;
}

export const api = {
  get: <T,>(url: string) => request<T>(url),
  post: <T,>(url: string, body?: unknown) =>
    request<T>(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T,>(url: string, body?: unknown) =>
    request<T>(url, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T,>(url: string, body?: unknown) =>
    request<T>(url, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T,>(url: string) => request<T>(url, { method: "DELETE" }),
  upload: <T,>(url: string, file: File) => {
    const form = new FormData();
    form.set("file", file);
    return request<T>(url, { method: "POST", body: form });
  },
};

/** Minimal data hook: fetch on mount, on demand, and optionally on a poll interval. */
export function useApi<T>(url: string | null, deps: unknown[] = [], opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      const result = await api.get<T>(url);
      if (mounted.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(err as ApiError);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);

  useInterval(() => void load(), opts.pollMs ?? null);

  return { data, error, loading, reload: load, setData };
}

/** Debounced value for the search inputs that filter client-side. */
export function useDebounced<T>(value: T, delay = 220) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  }, [fn]);
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function fmtNumber(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
}

export function fmtCompact(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function fmtBytes(bytes: number | null | undefined) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtRelative(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [60_000, "s"],
    [3_600_000, "m"],
    [86_400_000, "h"],
    [604_800_000, "d"],
  ];
  if (abs < 60_000) return diff >= 0 ? "just now" : "in a moment";
  if (abs < 3_600_000) return `${diff >= 0 ? "" : "in "}${Math.round(abs / 60_000)}m${diff >= 0 ? " ago" : ""}`;
  if (abs < 86_400_000) return `${diff >= 0 ? "" : "in "}${Math.round(abs / 3_600_000)}h${diff >= 0 ? " ago" : ""}`;
  if (abs < 604_800_000) return `${diff >= 0 ? "" : "in "}${Math.round(abs / 86_400_000)}d${diff >= 0 ? " ago" : ""}`;
  return fmtDateTime(iso);
}

export function fmtDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return "-";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtClock(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return "--:--";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function sentimentLabel(value: number | null | undefined) {
  if (value === null || value === undefined) return "unscored";
  if (value >= 0.35) return "positive";
  if (value >= -0.15) return "neutral";
  return "negative";
}

export function useLocalState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

export function useHotkey(combo: string, handler: () => void) {
  const map = useMemo(() => combo.toLowerCase().split("+"), [combo]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const needsMeta = map.includes("mod");
      const needsShift = map.includes("shift");
      if ((needsMeta ? e.metaKey || e.ctrlKey : !e.metaKey && !e.ctrlKey) && needsShift === e.shiftKey && map.includes(key)) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [map, handler]);
}
