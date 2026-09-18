"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function runAction(environment) {
  const entry = path.resolve(__dirname, "../dist/index.js");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { env: environment, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("annotates a deprecated key, writes outputs, and fails the job", async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "usagetap-action-"));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "app.js"), `const model = "gpt-4-turbo";\n`, "utf8");
  const outputFile = path.join(workspace, "outputs.txt");
  const summaryFile = path.join(workspace, "summary.md");

  const server = http.createServer((request, response) => {
    assert.match(request.url, /\/v1\/model-alternatives\/openai\/gpt-4-turbo\?purpose=retirement&response=light/);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      schemaVersion: 1,
      lifecycle: {
        status: "DEPRECATED",
        shutdownAt: "2026-10-23",
        source: {
          label: "OpenAI API deprecations",
          url: "https://example.test/openai-deprecations",
          checkedAt: "2026-09-17",
        },
      },
      action: "REPLACE",
      providerReplacementModelKey: "openai/gpt-5.6-sol",
      recommendedModelKey: "openai/gpt-6-astra",
      recommendationSource: "computed",
      degraded: false,
      decisionId: "test-decision",
      validUntil: "2026-09-18T00:00:00Z",
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const result = await runAction({
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    "INPUT_API-BASE-URL": `http://127.0.0.1:${address.port}`,
    INPUT_PATHS: ".",
    "INPUT_FAIL-ON": "replace",
  });

  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /::error file=app\.js,line=1/);
  assert.match(await fs.readFile(outputFile, "utf8"), /replace-count.*\n1\n/s);
  const summary = await fs.readFile(summaryFile, "utf8");
  assert.match(summary, /openai\/gpt-4-turbo/);
  assert.match(summary, /\[OpenAI API deprecations\]\(https:\/\/example\.test\/openai-deprecations\)/);
});

test("reports unknown and degraded decisions according to policy", async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "usagetap-action-policy-"));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(workspace, "models.js"),
    `const primary = "gpt-4o";\nconst secondary = "claude-sonnet-4-6";\n`,
    "utf8",
  );
  const outputFile = path.join(workspace, "outputs.txt");
  const summaryFile = path.join(workspace, "summary.md");

  const server = http.createServer((request, response) => {
    const isClaude = request.url.includes("anthropic/claude-sonnet-4-6");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      schemaVersion: 1,
      lifecycle: { status: isClaude ? "ACTIVE" : "UNKNOWN" },
      action: isClaude ? "KEEP" : "REVIEW",
      degraded: isClaude,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const result = await runAction({
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    "INPUT_API-BASE-URL": `http://127.0.0.1:${address.port}`,
    INPUT_PATHS: ".",
    "INPUT_UNKNOWN-POLICY": "warn",
    "INPUT_API-ERROR-POLICY": "error",
  });

  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /::warning file=models\.js,line=1.*UNKNOWN/);
  assert.match(result.stdout, /::error file=models\.js,line=2.*response is degraded/);
  assert.match(result.stdout, /failing because 1 model check/);
  const outputs = await fs.readFile(outputFile, "utf8");
  assert.match(outputs, /unknown-count.*\n1\n/s);
  assert.match(outputs, /degraded-count.*\n1\n/s);
});

test("audits declared models and reports lifecycle waivers without hiding decisions", async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "usagetap-action-model-files-"));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "app.js"), `const legacy = "gpt-4-turbo";\n`, "utf8");
  await fs.writeFile(path.join(workspace, "models.include"), "openai/future-family-v1 # runtime alias\n", "utf8");
  await fs.writeFile(
    path.join(workspace, "models.ignore"),
    [
      "openai/gpt-4-turbo | 2099-12-31 | Compatibility fixture; UT-431",
      "anthropic/unused-model | 2099-12-31 | Stale waiver",
      "",
    ].join("\n"),
    "utf8",
  );
  const outputFile = path.join(workspace, "outputs.txt");
  const summaryFile = path.join(workspace, "summary.md");

  const server = http.createServer((request, response) => {
    const unknown = request.url.includes("future-family-v1");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      schemaVersion: 1,
      lifecycle: { status: unknown ? "UNKNOWN" : "DEPRECATED" },
      action: unknown ? "REVIEW" : "REPLACE",
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const result = await runAction({
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    "INPUT_API-BASE-URL": `http://127.0.0.1:${address.port}`,
    INPUT_PATHS: ".",
    "INPUT_FAIL-ON": "replace",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /::error/);
  assert.match(result.stdout, /::warning file=app\.js,line=1.*WAIVED through 2099-12-31/);
  assert.match(result.stdout, /::warning file=models\.include,line=1.*UNKNOWN/);
  assert.match(result.stdout, /::warning file=models\.ignore,line=2.*waiver is unused/);
  const outputs = await fs.readFile(outputFile, "utf8");
  assert.match(outputs, /models-found.*\n2\n/s);
  assert.match(outputs, /waived-count.*\n1\n/s);
  assert.match(outputs, /unused-waiver-count.*\n1\n/s);
  const summary = await fs.readFile(summaryFile, "utf8");
  assert.match(summary, /DEPRECATED \/ REPLACE \/ WAIVED/);
  assert.match(summary, /Compatibility fixture; UT-431/);
  assert.match(summary, /### Unused waivers/);
});
