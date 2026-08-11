import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 and the ONNX runtime behind @huggingface/transformers are native
  // modules. Leaving them external keeps the server bundler from trying to trace and
  // rewrite their .node binaries.
  serverExternalPackages: ["better-sqlite3", "@huggingface/transformers"],
};

export default nextConfig;
