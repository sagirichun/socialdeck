import { NextResponse } from "next/server";
import { authenticate, createSession, SESSION_COOKIE, bootstrapAdminIfEmpty } from "@/lib/auth";
import { env } from "@/lib/env";
import { audit } from "@/lib/db";
import { clientIp, route, readJson, fail } from "@/lib/api";
import { migrate } from "@/lib/db";

export const runtime = "nodejs";

export const POST = route(async (req: Request) => {
  migrate();
  const boot = bootstrapAdminIfEmpty();
  const body = await readJson<{ email?: string; password?: string }>(req);
  if (!body.email || !body.password) return fail(400, "email and password are required");

  const user = authenticate(body.email, body.password);
  if (!user) return fail(401, "invalid credentials");

  const { token, expires } = createSession(user.id, {
    userAgent: req.headers.get("user-agent"),
    ip: clientIp(req),
  });
  audit({ userId: user.id, action: "auth.login", entity: "user", entityId: user.id, ip: clientIp(req) });

  const res = NextResponse.json({
    ok: true,
    data: { user, expiresAt: expires.toISOString(), bootstrapCreated: boot?.email ?? null },
  });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "1",
    path: "/",
    expires,
  });
  return res;
});
