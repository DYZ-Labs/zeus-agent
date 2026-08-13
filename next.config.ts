import type { NextConfig } from "next";

function configuredServerActionOrigin(): string | null {
  const value = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.host;
  } catch {
    return null;
  }
}

const serverActionOrigin = configuredServerActionOrigin();

const nextConfig: NextConfig = {
  // The dev badge otherwise sits directly over the sidebar's Settings control.
  devIndicators: false,
  // better-sqlite3 and the ONNX runtime behind @huggingface/transformers are native
  // modules. Leaving them external keeps the server bundler from trying to trace and
  // rewrite their .node binaries.
  serverExternalPackages: ["better-sqlite3", "@huggingface/transformers"],
  // Railway forwards Server Actions through an internal service hostname. Next.js's
  // built-in CSRF check therefore needs the exact public hostname as an explicit
  // allowed origin; Zeus independently requires the same exact Origin in proxy.ts.
  ...(serverActionOrigin
    ? {
        experimental: {
          serverActions: { allowedOrigins: [serverActionOrigin] },
        },
      }
    : {}),
};

export default nextConfig;
