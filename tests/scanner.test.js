"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { extractModelRefs, normalizeCandidate, scanRepository } = require("../src/scanner.js");

test("finds common SDK, qualified, Bedrock, and Vertex forms", () => {
  const source = [
    `const a = { model: "gpt-4-turbo" };`,
    `client.messages.create({ model: 'claude-3-5-sonnet-20241022' });`,
    `model = "gemini-2.5-pro"`,
    `fallback = "openai/gpt-5.6-sol"`,
    `future = "openai/future-family-v1"`,
    `bedrock = "anthropic.claude-3-5-sonnet-20241022-v2:0"`,
    `vertex = "publishers/google/models/gemini-2.5-flash"`,
  ].join("\n");

  const refs = extractModelRefs(source, "src/models.ts");
  assert.deepEqual(refs.map((item) => item.modelKey), [
    "openai/gpt-5.6-sol",
    "openai/future-family-v1",
    "google/gemini-2.5-flash",
    "anthropic/claude-3-5-sonnet-20241022",
    "openai/gpt-4-turbo",
    "anthropic/claude-3-5-sonnet-20241022",
    "google/gemini-2.5-pro",
  ]);
  assert.equal(refs.find((item) => item.raw.startsWith("anthropic.claude")).platform, "bedrock");
  assert.equal(refs.find((item) => item.raw.startsWith("publishers/google")).platform, "vertex");
});

test("normalizes provider separators and cloud suffixes", () => {
  assert.equal(normalizeCandidate("OpenAI:gpt-4-turbo"), "openai/gpt-4-turbo");
  assert.equal(normalizeCandidate("claude-3-5-sonnet-20241022-v2:0", "anthropic"), "anthropic/claude-3-5-sonnet-20241022");
  assert.equal(normalizeCandidate("custom-deployment"), null);
});

test("does not treat arbitrary quoted strings as models", () => {
  assert.deepEqual(extractModelRefs(`const region = "us-east-1";`, "src/config.js"), []);
});

test("finds unquoted model assignments in environment and YAML files", () => {
  const source = [
    "OPENAI_MODEL=gpt-4o",
    "model: claude-sonnet-4-6 # production default",
    "  - model_name: gemini-2.5-flash",
  ].join("\n");
  assert.deepEqual(extractModelRefs(source, ".env").map((item) => item.modelKey), [
    "openai/gpt-4o",
    "anthropic/claude-sonnet-4-6",
    "google/gemini-2.5-flash",
  ]);
});

test("rejects unsafe explicit provider-qualified values", () => {
  assert.equal(normalizeCandidate("openai/model with spaces"), null);
  assert.equal(normalizeCandidate("openai/<script>"), null);
  assert.equal(normalizeCandidate("openai/custom-deployment"), "openai/custom-deployment");
});

test("model-like adversarial input is scanned without pathological backtracking", () => {
  const source = `"gpt-${"a-".repeat(5000)}!`;
  const started = performance.now();
  assert.deepEqual(extractModelRefs(source, "src/adversarial.js"), []);
  assert.ok(performance.now() - started < 1000, "scanner took longer than one second");
});

test("root globstars exclude root and nested matches and overlapping paths scan once", async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "usagetap-scanner-"));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "nested"));
  await fs.mkdir(path.join(workspace, "fixtures"));
  await fs.writeFile(path.join(workspace, "root.generated.ts"), `"gpt-4-turbo"`, "utf8");
  await fs.writeFile(path.join(workspace, "nested", "child.generated.ts"), `"gpt-4-turbo"`, "utf8");
  await fs.writeFile(path.join(workspace, "fixtures", "model.js"), `"gpt-4-turbo"`, "utf8");
  await fs.writeFile(path.join(workspace, "keep.js"), `"gpt-4o"`, "utf8");

  const scan = await scanRepository({
    root: workspace,
    paths: [".", "keep.js"],
    exclude: ["**/*.generated.ts", "**/fixtures/**"],
  });
  assert.equal(scan.filesScanned, 1);
  assert.equal(scan.occurrences.length, 1);
  assert.deepEqual([...scan.byModel.keys()], ["openai/gpt-4o"]);
});

test("missing scan paths have an actionable error", async () => {
  await assert.rejects(
    () => scanRepository({ root: process.cwd(), paths: ["does-not-exist"] }),
    /Scan path does not exist: does-not-exist/,
  );
});
