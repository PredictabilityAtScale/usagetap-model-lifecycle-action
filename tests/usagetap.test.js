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
