import { currentUser } from "@/lib/auth";
import { ok, route } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await currentUser();
  return ok({ user });
});
