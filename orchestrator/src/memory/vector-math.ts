// The arithmetic of finding a memory by meaning, with no database in it.
//
// A memory is stored as a vector (what the embedding model made of the exchange). Finding the
// ones that mean something like a new question is comparing that question's vector with each:
// the most similar, above a floor. At the size Shiro's memory has (hundreds, a few thousand a
// year) comparing every one is instant, so there is nothing to index.

/**
 * Scales a vector to length 1. Between two such vectors the cosine similarity is simply their
 * dot product, which is also what Pinecone's "cosine" metric reports, so scores here and there
 * are the same numbers.
 */
export function normalize(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    out[i] = v;
    sum += v * v;
  }
  const length = Math.sqrt(sum);
  if (!(length > 0) || !Number.isFinite(length)) return new Float32Array(values.length); // a zero vector matches nothing
  for (let i = 0; i < out.length; i++) out[i] /= length;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export type Scored<T> = { item: T; score: number };

/**
 * The `k` items whose vectors are most similar to `query`, best first, leaving out any below
 * `threshold`. Both sides are expected to be normalized. An item of a different size than the
 * query (an embedding model that was changed) is skipped rather than compared.
 */
export function topMatches<T extends { vec: Float32Array }>(
  items: Iterable<T>,
  query: Float32Array,
  k: number,
  threshold: number
): Scored<T>[] {
  const found: Scored<T>[] = [];
  for (const item of items) {
    if (item.vec.length !== query.length) continue;
    const score = dot(item.vec, query);
    if (score >= threshold) found.push({ item, score });
  }
  found.sort((a, b) => b.score - a.score);
  return found.slice(0, Math.max(0, k));
}

/** A vector as the bytes SQLite keeps. */
export function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** And back. The bytes are copied: a Buffer read from SQLite is not guaranteed to be aligned for a Float32Array. */
export function fromBlob(blob: Buffer): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
