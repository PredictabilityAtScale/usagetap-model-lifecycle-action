"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { lookupModel } = require("../src/usagetap.js");

test("calls the light retirement endpoint", async () => {
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      json: async () => ({ schemaVersion: 1, lifecycle: { status: "ACTIVE" }, action: "KEEP" }),
    };
  };
  const result = await lookupModel("openai/gpt-5.6-sol", { baseUrl: "https://example.test/", fetchImpl });
  assert.equal(result.action, "KEEP");
  assert.equal(requestedUrl, "https://example.test/v1/model-alternatives/openai/gpt-5.6-sol?purpose=retirement&response=light");
});

test("rejects an unexpected response schema", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(() => lookupModel("openai/gpt-4", { fetchImpl, retries: 0 }), /Unexpected response schema/);
});

test("rejects unknown actions and invalid optional field types", async () => {
  const base = { schemaVersion: 1, lifecycle: { status: "ACTIVE" }, action: "KEEP" };
  await assert.rejects(
    () => lookupModel("openai/gpt-4", {
      fetchImpl: async () => ({ ok: true, json: async () => ({ ...base, action: "RPELACE" }) }),
    }),
    /Unexpected response schema/,
  );
  await assert.rejects(
    () => lookupModel("openai/unknown", {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ schemaVersion: 1, lifecycle: { status: "UNKNOWN" }, action: "KEEP" }),
      }),
    }),
    /Unexpected response schema/,
  );
  await assert.rejects(
    () => lookupModel("openai/gpt-4", {
      fetchImpl: async () => ({ ok: true, json: async () => ({ ...base, degraded: "yes" }) }),
    }),
    /Unexpected response schema/,
  );
  await assert.rejects(
    () => lookupModel("openai/gpt-4", {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          ...base,
          lifecycle: { status: "ACTIVE", source: { url: "javascript:alert(1)" } },
        }),
      }),
    }),
    /Unexpected response schema/,
  );
});

test("honors Retry-After, disposes the response, and retries transient errors", async () => {
  let calls = 0;
  let cancelled = false;
  const delays = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => "0.01" },
        body: { cancel: async () => { cancelled = true; } },
      };
    }
    return {
      ok: true,
      json: async () => ({ schemaVersion: 1, lifecycle: { status: "ACTIVE" }, action: "KEEP" }),
    };
  };
  const result = await lookupModel("openai/gpt-4", {
    fetchImpl,
    retries: 1,
    sleepImpl: async (delay) => { delays.push(delay); },
  });
  assert.equal(result.action, "KEEP");
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
  assert.deepEqual(delays, [10]);
});

test("does not retry non-transient HTTP errors", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 404, text: async () => "missing" };
  };
  await assert.rejects(() => lookupModel("openai/gpt-4", { fetchImpl }), /HTTP 404/);
  assert.equal(calls, 1);
});
