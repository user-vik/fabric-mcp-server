import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeOneLakeFilePath,
  pollJobInstance,
  pollLro,
  readResponseBytes,
} from "../index.js";

test("readResponseBytes retains at most the requested bytes and reports truncation", async () => {
  const capped = await readResponseBytes(new Response("abcdefghij"), 5);
  assert.equal(capped.buffer.subarray(0, 5).toString(), "abcde");
  assert.equal(capped.truncated, true);

  const exact = await readResponseBytes(new Response("abcde"), 5);
  assert.equal(exact.buffer.toString(), "abcde");
  assert.equal(exact.truncated, false);
});

test("normalizeOneLakeFilePath encodes paths and rejects traversal delimiters", () => {
  assert.equal(normalizeOneLakeFilePath("/Files/report 1.json"), "Files/report%201.json");
  for (const path of ["Files/../secret", "Files/%2e%2e/secret", "Files\\secret", "Files//secret"]) {
    assert.throws(() => normalizeOneLakeFilePath(path));
  }
});

test("pollJobInstance retries a throttled request and surfaces the next HTTP failure", async () => {
  const responses = [
    new Response("", { status: 429, headers: { "retry-after": "0" } }),
    new Response("upstream failed", { status: 500 }),
  ];
  const sleeps = [];
  const fetchCalls = [];

  await assert.rejects(
    () =>
      pollJobInstance("https://api.fabric.microsoft.com/operation", 0, {
        fetchFn: async (url, options) => {
          fetchCalls.push({ url, options });
          return responses.shift();
        },
        getTokenFn: async () => ({ token: "test-token" }),
        sleepFn: async (delay) => sleeps.push(delay),
      }),
    /500: upstream failed/,
  );

  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.ok(fetchCalls.every(({ options }) => options.signal instanceof AbortSignal));
});

test("pollLro surfaces a failed result retrieval after a successful operation", async () => {
  const responses = [
    new Response(JSON.stringify({ status: "Succeeded" }), {
      status: 200,
      headers: { location: "https://api.fabric.microsoft.com/operation/result" },
    }),
    new Response("result unavailable", { status: 500 }),
  ];

  await assert.rejects(
    () =>
      pollLro("https://api.fabric.microsoft.com/operation", 0, {
        fetchFn: async () => responses.shift(),
        getTokenFn: async () => ({ token: "test-token" }),
        sleepFn: async () => {},
      }),
    /500: result unavailable/,
  );
});
