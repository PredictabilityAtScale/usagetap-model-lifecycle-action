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
  assert.match(summary, /checked 2026-09-17/);
  assert.match(await fs.readFile(outputFile, "utf8"), /"lifecycleCheckedAt":"2026-09-17"/);
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
  context.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

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
  context.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

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

test("zero discoveries warn and succeed by default with a prominent summary callout", async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "usagetap-action-zero-"));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "app.js"), "const answer = 42;\n", "utf8");
  const outputFile = path.join(workspace, "outputs.txt");
  const summaryFile = path.join(workspace, "summary.md");

  const result = await runAction({
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    INPUT_PATHS: ".",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /::warning .*UsageTap found zero models.*Broaden paths.*models\.include or models/);
  assert.match(await fs.readFile(outputFile, "utf8"), /models-found.*\n0\n/s);
  assert.match(await fs.readFile(summaryFile, "utf8"), /> \[!WARNING\][\s\S]*No model keys were found/);
});

test("minimum-models fails after writing every output when discovery is empty", async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "usagetap-action-minimum-zero-"));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "app.js"), "const answer = 42;\n", "utf8");
  const outputFile = path.join(workspace, "outputs.txt");
  const summaryFile = path.join(workspace, "summary.md");

  const result = await runAction({
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    INPUT_PATHS: ".",
    "INPUT_MINIMUM-MODELS": "1",
  });

  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /::warning .*UsageTap found zero models/);
  assert.match(result.stdout, /below minimum-models=1/);
  const outputs = await fs.readFile(outputFile, "utf8");
  for (const name of [
    "models-found", "replace-count", "review-count", "keep-count", "unknown-count", "degraded-count",
    "error-count", "waived-count", "unused-waiver-count", "files-scanned", "files-skipped", "results-json",
  ]) assert.match(outputs, new RegExp(`${name}<<`));
  assert.match(outputs, /models-found.*\n0\n/s);
  assert.match(await fs.readFile(summaryFile, "utf8"), /This run fails because `minimum-models` is 1/);
});

test("one discovery satisfies minimum-models and follows normal policy", async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "usagetap-action-minimum-one-"));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "app.js"), `const model = "gpt-4o";\n`, "utf8");
  const outputFile = path.join(workspace, "outputs.txt");
  const summaryFile = path.join(workspace, "summary.md");
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ schemaVersion: 1, lifecycle: { status: "ACTIVE" }, action: "KEEP" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const result = await runAction({
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    INPUT_PATHS: ".",
    "INPUT_MINIMUM-MODELS": "1",
    "INPUT_API-BASE-URL": `http://127.0.0.1:${server.address().port}`,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /zero models|below minimum-models/);
  assert.match(await fs.readFile(outputFile, "utf8"), /keep-count.*\n1\n/s);
});

test("minimum-models rejects negative and non-integer configuration", async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "usagetap-action-invalid-minimum-"));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "app.js"), "const answer = 42;\n", "utf8");

  for (const value of ["-1", "1.5", "9007199254740992"]) {
    const result = await runAction({
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      INPUT_PATHS: ".",
      "INPUT_MINIMUM-MODELS": value,
    });
    assert.equal(result.code, 1, `value ${value} should fail`);
    assert.match(result.stdout, /minimum-models must be a non-negative safe integer \(0 or greater\)/);
  }
});

test("summary explains normalized cloud-platform coverage without sending platform IDs", async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "usagetap-action-platforms-"));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "models.js"), [
    `const bedrock = "anthropic.claude-3-5-sonnet-20241022-v2:0";`,
    `const vertex = "publishers/google/models/gemini-2.5-flash";`,
  ].join("\n"), "utf8");
  const outputFile = path.join(workspace, "outputs.txt");
  const summaryFile = path.join(workspace, "summary.md");
  const requested = [];
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ schemaVersion: 1, lifecycle: { status: "ACTIVE" }, action: "KEEP" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const result = await runAction({
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    INPUT_PATHS: ".",
    "INPUT_API-BASE-URL": `http://127.0.0.1:${server.address().port}`,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(requested.every((url) => !url.includes("publishers") && !url.includes("anthropic.claude")));
  const summary = await fs.readFile(summaryFile, "utf8");
  assert.match(summary, /Bedrock region availability/);
  assert.match(summary, /Vertex AI region availability/);
});
