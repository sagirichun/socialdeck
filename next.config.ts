import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Dev-only: without this, requests to /_next/* from a LAN address are rejected once Next
  // enforces the check. The wildcard keeps phone-on-the-same-wifi testing working.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "*.local"],
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/bullmq/**"],
  },
  experimental: {
    serverActions: { bodySizeLimit: "256mb" },
  },
};

export default nextConfig;
