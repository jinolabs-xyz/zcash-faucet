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
};

export default nextConfig;
