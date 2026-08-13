/**
 * Download the local embedding model into the cache before the app needs it.
 *
 * Runs as part of `npm run build`, so a deployment ships with the model already on
 * disk instead of fetching ~140MB from a public CDN inside whichever user request
 * happens to search first.
 *
 * Never fails the build. The runtime degrades to full-text search on its own, and
 * failing a deploy because a CDN blipped would be a worse outcome than shipping
 * without a pre-warmed cache.
 *
 *   npm run models:fetch
 *   ZEUS_SKIP_MODEL_PREFETCH=1 npm run build   # CI, or an offline build
 */
import { resolve } from "node:path";

import {
  EMBEDDING_MODEL,
  embeddingsDisabled,
  modelCacheDirectory,
  warmEmbeddings,
} from "../src/core/embed";
import { loadLocalEnvironment } from "./local-env";

loadLocalEnvironment(resolve(import.meta.dirname, ".."));

if (process.env.ZEUS_SKIP_MODEL_PREFETCH?.trim()) {
  process.stdout.write("zeus: skipping embedding model prefetch (ZEUS_SKIP_MODEL_PREFETCH)\n");
} else if (embeddingsDisabled()) {
  process.stdout.write("zeus: skipping embedding model prefetch (ZEUS_EMBEDDINGS=off)\n");
} else {
  const directory = modelCacheDirectory();
  const started = Date.now();
  // Deliberately the same load path the server uses, so what the build caches is
  // exactly what the runtime looks for rather than a parallel guess at the layout.
  const status = await warmEmbeddings();
  const seconds = ((Date.now() - started) / 1_000).toFixed(1);

  if (status === "ready") {
    process.stdout.write(`zeus: cached ${EMBEDDING_MODEL} in ${directory} (${seconds}s)\n`);
  } else {
    process.stderr.write(
      `zeus: could not prefetch ${EMBEDDING_MODEL}; the server will retry and fall ` +
        "back to full-text search until it succeeds\n",
    );
  }
}
