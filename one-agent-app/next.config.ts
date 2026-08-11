import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@one-agent/core"],
  // PDF 解析依赖 pdfjs-dist（含 wasm/worker），需在 Node 侧外部化
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
