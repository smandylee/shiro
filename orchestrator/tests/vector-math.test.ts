// The arithmetic behind long-term memory search: no database, no network.
//
//   cd orchestrator && npx tsx tests/vector-math.test.ts
import assert from "node:assert/strict";
import { dot, fromBlob, normalize, toBlob, topMatches } from "../src/memory/vector-math.js";

const rnd = (n: number, seed: number) => { let s = seed; return Array.from({ length: n }, () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 2147483648 - 1; }); };
const cosine = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); };

// normalizing: length one; direction kept; scale does not matter
{
  const v = normalize([3, 4]); assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
  const a = rnd(768, 1), b = a.map((x) => x * 37.5);
  const na = normalize(a), nb = normalize(b);
  assert.ok(Math.abs(dot(na, na) - 1) < 1e-5, "unit length");
  assert.ok(Math.abs(dot(na, nb) - 1) < 1e-5, "scaling a vector changes nothing");
  assert.deepEqual([...normalize([0, 0, 0])], [0, 0, 0], "a zero vector stays zero");
  assert.deepEqual([...normalize([])], []);
  assert.equal(dot(normalize([0, 0]), normalize([1, 0])), 0, "and matches nothing");
}
// the dot product of normalized vectors IS the cosine similarity Pinecone reports
for (let i = 0; i < 25; i++) {
  const a = rnd(768, 100 + i), b = rnd(768, 900 + i);
  assert.ok(Math.abs(dot(normalize(a), normalize(b)) - cosine(a, b)) < 1e-5);
}
console.log("1 normalizing: unit length, scale-free, and dot == cosine on 25 random 768-d pairs");

// ranking
{
  const q = normalize([1, 0, 0]);
  const items = [
    { name: "far", vec: normalize([0, 1, 0]) }, { name: "close", vec: normalize([1, 0.1, 0]) }, { name: "same", vec: normalize([2, 0, 0]) },
    { name: "mid", vec: normalize([1, 1, 0]) }, { name: "odd size", vec: normalize([1, 0]) },
  ];
  const got = topMatches(items, q, 3, 0.5);
  assert.deepEqual(got.map((g) => g.item.name), ["same", "close", "mid"], "best first; the wrong-sized one is skipped, the far one is under the floor");
  assert.ok(got[0].score > got[1].score && got[1].score > got[2].score);
  assert.equal(topMatches(items, q, 1, 0.5).length, 1, "at most k");
  assert.equal(topMatches(items, q, 5, 0.9999).length, 1, "only what clears the floor");
  assert.equal(topMatches([], q, 5, 0).length, 0);
  assert.equal(topMatches(items, q, 0, 0).length, 0);
  assert.equal(topMatches(items, q, -2, 0).length, 0);
}
console.log("2 ranking: best first, floor, k, and a vector of another size is skipped");

// bytes in SQLite and back
{
  const v = normalize(rnd(768, 7));
  const back = fromBlob(toBlob(v)); assert.equal(back.length, 768); assert.deepEqual([...back], [...v], "exact round trip");
  const padded = Buffer.concat([Buffer.from([1, 2, 3]), toBlob(v)]).subarray(3); // starts at an odd offset, as a Buffer from a database can
  assert.deepEqual([...fromBlob(padded)], [...v], "an unaligned buffer is read correctly");
  assert.equal(toBlob(v).byteLength, 768 * 4);
}
console.log("3 a vector survives its trip through a database blob, aligned or not");

// 5000 memories: still instant
{
  const items = Array.from({ length: 5000 }, (_, i) => ({ i, vec: normalize(rnd(768, 5000 + i)) }));
  const q = normalize(rnd(768, 42)); const t = Date.now();
  topMatches(items, q, 5, 0.65); const ms = Date.now() - t;
  assert.ok(ms < 500, `5000 comparisons took ${ms} ms`); console.log(`4 5000 memories searched in ${ms} ms`);
}
console.log("vector math: ok");
