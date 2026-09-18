"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadModelFiles, parseIgnoreFile, parseIncludeFile } = require("../src/model-files.js");

test("parses exact model declarations and expiring waivers", () => {
  const includes = parseIncludeFile([
    "# runtime aliases",
    "openai/gpt-4o # Azure production",
    "anthropic:claude-sonnet-4-6",
  ].join("\n"), "models.include");
  assert.deepEqual(includes.map((entry) => entry.modelKey), [
    "openai/gpt-4o",
    "anthropic/claude-sonnet-4-6",
  ]);
  assert.equal(includes[0].note, "Azure production");

  const waivers = parseIgnoreFile(
    "openai/gpt-4-turbo | 2026-12-31 | Legacy fixture; UT-431",
    "models.ignore",
    { today: "2026-09-17" },
  );
  assert.deepEqual(waivers.get("openai/gpt-4-turbo"), {
    modelKey: "openai/gpt-4-turbo",
    expires: "2026-12-31",
    reason: "Legacy fixture; UT-431",
    file: "models.ignore",
    line: 1,
  });
});

test("rejects expired, malformed, duplicate, and unqualified entries", () => {
  assert.throws(
    () => parseIgnoreFile("openai/gpt-4-turbo | 2026-09-16 | old", "models.ignore", { today: "2026-09-17" }),
    /expired on 2026-09-16/,
  );
  assert.throws(
    () => parseIgnoreFile("openai/gpt-4-turbo | tomorrow | reason", "models.ignore", { today: "2026-09-17" }),
    /invalid expiry date/,
  );
  assert.throws(
    () => parseIgnoreFile("openai/gpt-4-turbo | 2026-12-31 |", "models.ignore", { today: "2026-09-17" }),
    /require a reason/,
  );
  assert.throws(
    () => parseIncludeFile("gpt-4o", "models.include"),
    /must be provider-qualified/,
  );
  assert.throws(
    () => parseIncludeFile("openai/gpt-4o\nopenai/gpt-4o", "models.include"),
    /duplicate model key/,
  );
});

test("loads optional model files under the repository root", async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "usagetap-model-files-"));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "models.include"), "openai/custom-deployment\n", "utf8");
  const loaded = await loadModelFiles({
    root: workspace,
    includeFile: "models.include",
    ignoreFile: "models.ignore",
    today: "2026-09-17",
  });
  assert.deepEqual(loaded.includes.map((entry) => entry.modelKey), ["openai/custom-deployment"]);
  assert.equal(loaded.waivers.size, 0);
  await assert.rejects(
    () => loadModelFiles({ root: workspace, includeFile: "../outside", ignoreFile: "" }),
    /escapes the repository root/,
  );
});
