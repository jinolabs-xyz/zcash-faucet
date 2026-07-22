/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Native / proto-loading modules: keep external to the server bundle so
  // better-sqlite3's binary and grpc's runtime proto loading work at runtime.
  serverExternalPackages: ["better-sqlite3", "@grpc/grpc-js", "@grpc/proto-loader"],
};

export default nextConfig;
