import type { NextConfig } from "next";

/**
 * `apps/api` sends no CORS headers and none are being added there as part of
 * this app. Routing `/api/:path*` through Next's own origin means every
 * fetch in this app hits a same-origin relative path, and a `set-cookie`
 * on the proxied `/api/auth/verify` response lands as an ordinary
 * same-origin cookie — no CORS configuration anywhere.
 */
const API_ORIGIN = process.env["API_ORIGIN"] ?? "http://localhost:8787";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_ORIGIN}/:path*`,
      },
    ];
  },
};

export default nextConfig;
