"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { decisionMessage, normalizeFailOn } = require("../src/main.js");

test("defaults can distinguish official replacement from computed recommendation", () => {
  const message = decisionMessage("openai/gpt-4-turbo", {
    lifecycle: { status: "DEPRECATED", shutdownAt: "2026-10-23" },
    action: "REPLACE",
    providerReplacementModelKey: "openai/gpt-5.6-sol",
    recommendedModelKey: "openai/gpt-6-astra",
    recommendationSource: "computed",
  });
  assert.match(message, /official replacement openai\/gpt-5\.6-sol/);
  assert.match(message, /recommendation openai\/gpt-6-astra \(computed\)/);
});

test("never disables all decision failures", () => {
  assert.deepEqual([...normalizeFailOn("never")], []);
  assert.deepEqual([...normalizeFailOn("replace,review")].sort(), ["replace", "review"]);
});
