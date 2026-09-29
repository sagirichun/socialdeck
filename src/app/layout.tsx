import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SocialDeck | Social Operations Platform",
  description:
    "Multi-account publishing, AI-assisted engagement, scheduled queues and 24/7 RTMP relays in one operations console.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0a0d12",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
