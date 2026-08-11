/**
 * Rebuild the derived indexes: full-text and embeddings.
 *
 * Safe to run at any time. The FTS tables are rebuilt from scratch; embeddings are
 * computed only for facts that lack one for the current model, so re-running after an
 * interrupted pass picks up where it stopped.
 *
 *   npm run reindex
 *   npm run reindex -- --fts-only
 */
import { reindexMessages } from "../src/core/conversations";
import { openDb, defaultDbPath } from "../src/core/db";
import {
  EMBEDDING_MODEL,
  embedFacet,
  embedFact,
  embedPassage,
  embeddingsDisabled,
  facetsMissingEmbeddings,
  factsMissingEmbeddings,
  passagesMissingEmbeddings,
} from "../src/core/embed";
import { reindexFacets } from "../src/core/facets";
import { reindexFacts } from "../src/core/facts";
import { reindexPassages } from "../src/core/passages";

const ftsOnly = process.argv.includes("--fts-only");
const path = defaultDbPath();
const db = openDb(path);

console.log(`zeus: reindexing ${path}`);

const facts = reindexFacts(db);
const messages = reindexMessages(db);
const passages = reindexPassages(db);
const facets = reindexFacets(db);
console.log(
  `  full-text: ${facts} facts, ${messages} messages, ${passages} recallable passages, ${facets} facets`,
);

if (ftsOnly) {
  console.log("  embeddings: skipped (--fts-only)");
} else if (embeddingsDisabled()) {
  console.log("  embeddings: skipped (ZEUS_EMBEDDINGS=off)");
} else {
  const pendingFacts = factsMissingEmbeddings(db, 100_000);
  const pendingPassages = passagesMissingEmbeddings(db, 100_000);
  const pendingFacets = facetsMissingEmbeddings(db, 100_000);
  const pending = pendingFacts.length + pendingPassages.length + pendingFacets.length;
  if (pending === 0) {
    console.log("  embeddings: already current");
  } else {
    console.log(
      `  embeddings: ${pendingFacts.length} facts, ${pendingPassages.length} passages, ${pendingFacets.length} facets with ${EMBEDDING_MODEL}`,
    );
    const started = Date.now();
    let done = 0;
    let failed = false;

    for (const fact of pendingFacts) {
      const ok = await embedFact(db, fact.id, fact.text);
      if (!ok) {
        // embed() already explained why. Stop rather than loop over every fact failing.
        failed = true;
        break;
      }
      done += 1;
      if (done % 100 === 0) process.stdout.write(`    ${done}/${pending}\r`);
    }

    if (!failed) {
      for (const passage of pendingPassages) {
        const ok = await embedPassage(db, passage.id, passage.text);
        if (!ok) {
          failed = true;
          break;
        }
        done += 1;
        if (done % 100 === 0) process.stdout.write(`    ${done}/${pending}\r`);
      }
    }

    if (!failed) {
      for (const facet of pendingFacets) {
        const ok = await embedFacet(db, facet.id, facet.text);
        if (!ok) {
          failed = true;
          break;
        }
        done += 1;
        if (done % 100 === 0) process.stdout.write(`    ${done}/${pending}\r`);
      }
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      failed
        ? `  embeddings: stopped after ${done} — search will use full-text only`
        : `  embeddings: ${done} in ${seconds}s`,
    );
  }
}

db.close();
