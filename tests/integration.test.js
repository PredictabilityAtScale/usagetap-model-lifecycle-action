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
      lifecycle: { status: "DEPRECATED", shutdownAt: "2026-10-23" },
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
    INPUT_API_BASE_URL: `http://127.0.0.1:${address.port}`,
    INPUT_PATHS: ".",
    INPUT_FAIL_ON: "replace",
  });

  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /::error file=app\.js,line=1/);
  assert.match(await fs.readFile(outputFile, "utf8"), /replace-count.*\n1\n/s);
  assert.match(await fs.readFile(summaryFile, "utf8"), /openai\/gpt-4-turbo/);
});
