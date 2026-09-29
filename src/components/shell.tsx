"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Bot,
  CalendarClock,
  Cpu,
  Film,
  Gauge,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MessagesSquare,
  Radio,
  ScrollText,
  Send,
  Settings2,
  Share2,
  ChevronRight,
  Menu,
  X,
  RefreshCw,
} from "lucide-react";
import { api, fmtRelative } from "@/lib/client";
import { Badge, Button, cn, IconButton, ToastHost } from "@/components/ui";

interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/composer", label: "Composer", icon: Send },
  { href: "/calendar", label: "Schedule", icon: CalendarClock },
  { href: "/inbox", label: "Engagement", icon: MessagesSquare },
  { href: "/accounts", label: "Accounts", icon: Share2 },
  { href: "/media", label: "Media", icon: Film },
  { href: "/streams", label: "Live relays", icon: Radio },
  { href: "/agent", label: "Copilot", icon: Bot },
  { href: "/ai", label: "AI providers", icon: Cpu },
  { href: "/queue", label: "Queue", icon: ListChecks },
  { href: "/audit", label: "Audit log", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

interface Health {
  status: string;
  database: string;
  queue: { mode: string; waiting: number; failed: number };
  ffmpeg: string;
  outboundMode: string;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    api
      .get<{ user: SessionUser | null }>("/api/auth/session")
      .then((res) => {
        if (!res.user) router.replace("/login");
        else setUser(res.user);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/health", { cache: "no-store" })
        .then((r) => r.json())
        .then((h) => alive && setHealth(h))
        .catch(() => {});
    load();
    const id = setInterval(load, 45_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => setNavOpen(false), [pathname]);

  const logout = async () => {
    await api.post("/api/auth/logout");
    router.replace("/login");
  };

  const sandbox = health?.outboundMode === "sandbox";

  return (
    <ToastHost>
      <div className="flex min-h-screen">
        {navOpen ? (
          <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setNavOpen(false)} />
        ) : null}

        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-[218px] shrink-0 flex-col border-r border-line bg-surface transition-transform lg:static lg:translate-x-0",
            navOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-[52px] items-center justify-between gap-2 border-b border-line px-4">
            <Link href="/dashboard" className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[12px] font-bold text-white">
                S
              </span>
              <span className="text-[13.5px] font-semibold tracking-tight text-ink">SocialDeck</span>
            </Link>
            <IconButton icon={X} label="Close navigation" className="lg:hidden" onClick={() => setNavOpen(false)} />
          </div>

          <nav className="flex-1 overflow-y-auto px-2 py-2.5">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "mb-0.5 flex items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-[12.5px] transition-colors",
                    active ? "bg-overlay text-ink" : "text-ink-mute hover:bg-raised hover:text-ink-dim",
                  )}
                >
                  <item.icon size={14} className={active ? "text-accent" : "text-ink-faint"} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-line px-3 py-2.5">
            <div className="mb-2 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2 text-[11px] text-ink-faint">
                <span>Queue</span>
                <span className="flex items-center gap-1.5">
                  <Badge tone={health?.queue.mode === "redis" ? "good" : "warn"} dot>
                    {health?.queue.mode ?? "checking"}
                  </Badge>
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px] text-ink-faint">
                <span>Waiting</span>
                <span className="tnum text-ink-dim">{health?.queue.waiting ?? 0}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px] text-ink-faint">
                <span>Failed</span>
                <span className={cn("tnum", (health?.queue.failed ?? 0) > 0 ? "text-bad" : "text-ink-dim")}>
                  {health?.queue.failed ?? 0}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-line pt-2.5">
              <span className="grid h-6 w-6 place-items-center rounded-full border border-line bg-raised text-[10.5px] font-semibold uppercase text-ink-dim">
                {user?.name?.slice(0, 2) ?? "--"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11.5px] font-medium text-ink-dim">{user?.name ?? "loading"}</p>
                <p className="truncate text-[10.5px] text-ink-faint">{user?.role ?? ""}</p>
              </div>
              <IconButton icon={LogOut} label="Sign out" onClick={logout} />
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-[52px] items-center justify-between gap-3 border-b border-line bg-canvas/95 px-4 backdrop-blur">
            <div className="flex items-center gap-2.5">
              <IconButton icon={Menu} label="Open navigation" className="lg:hidden" onClick={() => setNavOpen(true)} />
              <nav className="hidden items-center gap-1.5 text-[12px] text-ink-faint sm:flex">
                <span>Operations</span>
                <ChevronRight size={12} />
                <span className="text-ink-dim">
                  {NAV.find((n) => pathname.startsWith(n.href))?.label ?? "Overview"}
                </span>
              </nav>
            </div>
            <div className="flex items-center gap-2">
              {sandbox ? (
                <Badge tone="warn" dot>
                  Sandbox outbound
                </Badge>
              ) : (
                <Badge tone="good" dot>
                  Live outbound
                </Badge>
              )}
              <Badge tone={health?.status === "ok" ? "good" : "warn"}>
                <Gauge size={11} />
                {health?.status ?? "checking"}
              </Badge>
              <span className="hidden text-[11px] text-ink-faint md:inline">
                checked {health ? fmtRelative(new Date().toISOString()) : "-"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                icon={RefreshCw}
                onClick={() => window.location.reload()}
                className="hidden sm:inline-flex"
              >
                Refresh
              </Button>
            </div>
          </header>

          <main className="min-w-0 flex-1 px-4 py-5">
            <div className="mx-auto w-full max-w-[1400px]">{children}</div>
          </main>

          <footer className="border-t border-line px-4 py-2.5 text-[11px] text-ink-faint">
            <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2">
              <span>
                SocialDeck 1.0 - {health?.ffmpeg?.split(" ").slice(0, 3).join(" ") ?? "probing ffmpeg"}
              </span>
              <span className="flex items-center gap-1.5">
                <Activity size={11} />
                outbound {health?.outboundMode ?? "-"} - database {health?.database ?? "-"}
              </span>
            </div>
          </footer>
        </div>
      </div>
    </ToastHost>
  );
}
