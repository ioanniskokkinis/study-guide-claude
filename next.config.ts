import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (via pdfjs-dist) resolves its worker script relative to its
  // own package files at runtime; bundling it breaks that resolution, so
  // it must run as plain, unbundled server code.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
