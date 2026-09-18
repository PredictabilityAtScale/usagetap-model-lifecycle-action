"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  decisionMarker,
  issueBody,
  markerFor,
  syncMigrationIssues,
} = require("../src/issues.js");

function response(status, payload, link = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "link" ? link : null },
    text: async () => payload === undefined ? "" : JSON.stringify(payload),
  };
}

function finding(overrides = {}) {
  return {
    modelKey: "openai/gpt-4-turbo",
    status: "DEPRECATED",
    action: "REPLACE",
    shutdownAt: "2026-10-23",
    providerReplacementModelKey: "openai/gpt-5",
    recommendedModelKey: "anthropic/claude-sonnet-4-6",
    recommendationSource: "computed",
    lifecycleSourceLabel: "Provider lifecycle",
    lifecycleSourceUrl: "https://example.test/lifecycle",
    lifecycleCheckedAt: "2026-09-18",
    decisionId: "decision-1",
    degraded: false,
    waived: false,
    locations: [{ file: "src/app.js", line: 4 }],
    ...overrides,
  };
}

test("creates one marked migration issue and applies an available label", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/labels/")) return response(200, { name: "model-lifecycle" });
    if (options.method === "GET") return response(200, []);
    return response(201, { number: 17 });
  };
  const changes = await syncMigrationIssues([finding()], {
    policy: "replace",
    token: "secret-token",
    label: "model-lifecycle",
    assignees: ["platform-team"],
    repository: "owner/repo",
    apiBaseUrl: "https://github.test",
    fetchImpl,
  });

  assert.deepEqual(changes, [{ modelKey: "openai/gpt-4-turbo", action: "created", issueNumber: 17 }]);
  const create = calls.find((call) => call.options.method === "POST");
  const payload = JSON.parse(create.options.body);
  assert.match(payload.body, /usagetap-model-lifecycle:openai\/gpt-4-turbo/);
  assert.match(payload.body, /Provider-designated replacement: openai\/gpt-5/);
  assert.deepEqual(payload.labels, ["model-lifecycle"]);
  assert.deepEqual(payload.assignees, ["platform-team"]);
  assert.ok(calls.every((call) => !call.options.body?.includes("secret-token")));
});

test("paginates open issues and updates only when the decision ID changes", async () => {
  const calls = [];
  const existing = {
    number: 9,
    body: `${markerFor("openai/gpt-4-turbo")}\n${decisionMarker("old-decision")}`,
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/labels/")) return response(404, { message: "Not Found" });
    if (new URL(url).searchParams.get("page") === "1") {
      return response(200, [], '<https://github.test/repos/owner/repo/issues?state=open&per_page=100&page=2>; rel="next"');
    }
    if (options.method === "GET") return response(200, [existing]);
    return response(200, { number: 9 });
  };

  const changes = await syncMigrationIssues([finding()], {
    policy: "replace", token: "token", label: "missing", repository: "owner/repo",
    apiBaseUrl: "https://github.test", fetchImpl,
  });
  assert.deepEqual(changes, [{ modelKey: "openai/gpt-4-turbo", action: "updated", issueNumber: 9 }]);
  const update = calls.find((call) => call.options.method === "PATCH");
  assert.ok(update.url.endsWith("/issues/9"));
  assert.equal(JSON.parse(update.options.body).labels, undefined);

  calls.length = 0;
  existing.body = `${markerFor("openai/gpt-4-turbo")}\n${decisionMarker("decision-1")}`;
  const unchanged = await syncMigrationIssues([finding()], {
    policy: "replace", token: "token", label: "", repository: "owner/repo",
    apiBaseUrl: "https://github.test", fetchImpl,
  });
  assert.deepEqual(unchanged, [{ modelKey: "openai/gpt-4-turbo", action: "unchanged", issueNumber: 9 }]);
  assert.equal(calls.some((call) => call.options.method === "PATCH" || call.options.method === "POST"), false);
});

test("reports missing token and missing issues permission actionably", async () => {
  await assert.rejects(
    () => syncMigrationIssues([finding()], { policy: "replace", repository: "owner/repo" }),
    /github-token.*issues: write/,
  );
  await assert.rejects(
    () => syncMigrationIssues([finding()], {
      policy: "replace",
      token: "read-only",
      label: "model-lifecycle",
      repository: "owner/repo",
      fetchImpl: async () => response(403, { message: "Resource not accessible by integration" }),
    }),
    /denied \(403\).*issues: write/,
  );
});

test("escapes hostile provider text in issue Markdown", () => {
  const body = issueBody(finding({
    lifecycleSourceLabel: "<script>*danger*</script>",
    waiverReason: "close ](javascript:alert(1))",
    waived: true,
    waiverExpires: "2026-12-31",
    locations: [{ file: "src/<hostile>[x].js", line: 1 }],
  }));
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /\\<script\\>/);
  assert.match(body, /src\/\\<hostile\\>\\\[x\\\]\.js/);
  assert.match(body, /close \\\]\(javascript:alert\(1\)\)/);
  assert.throws(
    () => issueBody(finding({ modelKey: "openai/gpt-4 --> <script>" })),
    /unsafe model key/,
  );
});

test("suppresses API errors and degraded decisions", async () => {
  let called = false;
  const changes = await syncMigrationIssues([
    { modelKey: "openai/a", error: "offline" },
    finding({ modelKey: "openai/b", degraded: true }),
  ], {
    policy: "review-and-replace",
    token: "token",
    repository: "owner/repo",
    fetchImpl: async () => { called = true; throw new Error("should not call"); },
  });
  assert.deepEqual(changes, []);
  assert.equal(called, false);
});
