"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { extractModelRefs, normalizeCandidate } = require("../src/scanner.js");

test("finds common SDK, qualified, Bedrock, and Vertex forms", () => {
  const source = [
    `const a = { model: "gpt-4-turbo" };`,
    `client.messages.create({ model: 'claude-3-5-sonnet-20241022' });`,
    `model = "gemini-2.5-pro"`,
    `fallback = "openai/gpt-5.6-sol"`,
    `bedrock = "anthropic.claude-3-5-sonnet-20241022-v2:0"`,
    `vertex = "publishers/google/models/gemini-2.5-flash"`,
  ].join("\n");

  const refs = extractModelRefs(source, "src/models.ts");
  assert.deepEqual(refs.map((item) => item.modelKey), [
    "openai/gpt-5.6-sol",
    "google/gemini-2.5-flash",
    "anthropic/claude-3-5-sonnet-20241022",
    "openai/gpt-4-turbo",
    "anthropic/claude-3-5-sonnet-20241022",
    "google/gemini-2.5-pro",
  ]);
});

test("normalizes provider separators and cloud suffixes", () => {
  assert.equal(normalizeCandidate("OpenAI:gpt-4-turbo"), "openai/gpt-4-turbo");
  assert.equal(normalizeCandidate("claude-3-5-sonnet-20241022-v2:0", "anthropic"), "anthropic/claude-3-5-sonnet-20241022");
  assert.equal(normalizeCandidate("custom-deployment"), null);
});

test("does not treat arbitrary quoted strings as models", () => {
  assert.deepEqual(extractModelRefs(`const region = "us-east-1";`, "src/config.js"), []);
});
