import type { Metadata } from "next";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = { title: "SocialDeck | Console" };

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
