/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Native / proto-loading modules: keep external to the server bundle so
  // better-sqlite3's binary and grpc's runtime proto loading work at runtime.
  serverExternalPackages: [
    "better-sqlite3",
    "@grpc/grpc-js",
    "@grpc/proto-loader",
    "@bitgo/utxo-lib",
    "@d4mr/t2z-wasm", // keep external so the .wasm stays on disk for the runtime shim
  ],
  // Defense in depth: Caddy sets these at the proxy, but the app should not
  // be naked when someone reaches :3000 directly (smoke tests, a misconfigured
  // deploy, a future non-Caddy front). HSTS stays at the proxy only, the app
  // cannot know whether TLS is actually in front of it.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
