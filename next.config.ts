import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/bullmq/**"],
  },
  experimental: {
    serverActions: { bodySizeLimit: "256mb" },
  },
};

export default nextConfig;
