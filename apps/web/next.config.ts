import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: ["@quiztaker/core"],
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  serverExternalPackages: ["@cursor/sdk"],
};

export default nextConfig;
