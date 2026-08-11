import { describe, expect, it } from "vitest";

import { SEMANTIC_FLOOR, cosine, fromBlob, nearest, toBlob } from "./embed";

/**
 * The model itself is not exercised here — loading it would make the suite depend on a
 * 130MB download. What is exercised is the arithmetic and the retrieval policy around
 * it, which is where the behaviour that matters lives.
 */

function vec(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe("cosine", () => {
  it("is 1 for identical unit vectors and 0 for orthogonal ones", () => {
    expect(cosine(vec(1, 0, 0), vec(1, 0, 0))).toBeCloseTo(1);
    expect(cosine(vec(1, 0, 0), vec(0, 1, 0))).toBeCloseTo(0);
  });
});

describe("blob round-trip", () => {
  it("survives storage and reload intact", () => {
    const original = vec(0.5, -0.25, 0.125, 1);
    const restored = fromBlob(toBlob(original));
    expect(Array.from(restored)).toEqual(Array.from(original));
  });

  it("reads back correctly from an unaligned buffer", () => {
    // better-sqlite3 hands back buffers with no alignment guarantee; a naive
    // Float32Array view over one of those throws.
    const original = vec(1, 2, 3, 4);
    const padded = Buffer.concat([Buffer.alloc(1), toBlob(original)]).subarray(1);
    expect(Array.from(fromBlob(padded))).toEqual([1, 2, 3, 4]);
  });
});

describe("the semantic floor", () => {
  const store = [
    { ownerId: 1, vector: vec(1, 0, 0) },
    { ownerId: 2, vector: vec(0.9, 0.436, 0) },
    { ownerId: 3, vector: vec(0.42, 0.907, 0) },
    { ownerId: 4, vector: vec(0, 0, 1) },
  ];

  it("drops neighbours below the floor rather than always returning the top N", () => {
    // The whole point: an unrelated query must come back empty, not with the least-bad
    // guesses dressed up as recall.
    expect(nearest(vec(0, 0, 1), store, 10, 0.5).map((hit) => hit.ownerId)).toEqual([4]);
  });

  it("returns nothing at all when nothing clears the floor", () => {
    expect(nearest(vec(0, 1, 0), [{ ownerId: 1, vector: vec(1, 0, 0) }], 10, 0.5)).toEqual([]);
  });

  it("keeps genuine matches and orders them by similarity", () => {
    const hits = nearest(vec(1, 0, 0), store, 10, 0.5);
    expect(hits.map((hit) => hit.ownerId)).toEqual([1, 2]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("uses a floor calibrated for the current embedding model", () => {
    // Guards against someone lowering this without re-measuring: below ~0.46 the
    // unrelated-query results measured on bge-small start leaking back in.
    expect(SEMANTIC_FLOOR).toBeGreaterThanOrEqual(0.46);
    expect(SEMANTIC_FLOOR).toBeLessThan(0.6);
  });
});
