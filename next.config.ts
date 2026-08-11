import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev badge otherwise sits directly over the sidebar's Settings control.
  devIndicators: false,
  // better-sqlite3 and the ONNX runtime behind @huggingface/transformers are native
  // modules. Leaving them external keeps the server bundler from trying to trace and
  // rewrite their .node binaries.
  serverExternalPackages: ["better-sqlite3", "@huggingface/transformers"],
};

export default nextConfig;
