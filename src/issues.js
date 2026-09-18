"use strict";

const ISSUE_POLICIES = new Set(["off", "replace", "review-and-replace"]);
const SAFE_MODEL_KEY_RE = /^[a-z0-9][a-z0-9._:/-]{0,255}$/i;

function normalizeIssuePolicy(value) {
  const policy = String(value || "off").trim().toLowerCase();
  if (!ISSUE_POLICIES.has(policy)) {
    throw new Error("issue-policy must be off, replace, or review-and-replace.");
  }
  return policy;
}

function shouldTrack(policy, finding) {
  if (!finding || finding.error || finding.degraded) return false;
  if (policy === "replace") return finding.action === "REPLACE";
  return policy === "review-and-replace" && (finding.action === "REVIEW" || finding.action === "REPLACE");
}

function markerFor(modelKey) {
  if (!SAFE_MODEL_KEY_RE.test(String(modelKey))) {
    throw new Error("Cannot create a migration issue for an unsafe model key.");
  }
  return `<!-- usagetap-model-lifecycle:${modelKey} -->`;
}

function decisionMarker(decisionId) {
  const encoded = Buffer.from(String(decisionId || ""), "utf8").toString("base64url");
  return `<!-- usagetap-decision-id:${encoded} -->`;
}

function markdownText(value, fallback = "—") {
  const text = String(value ?? "").trim() || fallback;
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("\\", "\\\\")
    .replace(/([`*_[\]<>|])/g, "\\$1")
    .replace(/[\r\n]+/g, " ");
}

function markdownLink(label, url) {
  if (!url) return "—";
  const safeUrl = encodeURI(String(url)).replaceAll("(", "%28").replaceAll(")", "%29");
  return `[${markdownText(label || "Provider evidence")}](${safeUrl})`;
}

function sourceLocations(locations) {
  if (!locations?.length) return "Explicit declaration (no scanner location)";
  return locations.map((location) => {
    const suffix = location.line ? `:${location.line}` : "";
    const platform = location.platform ? ` (${location.platform})` : "";
    return `${markdownText(location.file || "explicit input")}${suffix}${platform}`;
  }).join(", ");
}

function issueBody(finding) {
  const evidence = markdownLink(finding.lifecycleSourceLabel, finding.lifecycleSourceUrl);
  const checked = markdownText(finding.lifecycleCheckedAt);
  const providerReplacement = markdownText(finding.providerReplacementModelKey);
  const recommendation = finding.recommendedModelKey
    ? `${markdownText(finding.recommendedModelKey)} (${markdownText(finding.recommendationSource || "source unspecified")})`
    : "—";
  const waiver = finding.waived
    ? `Waived through ${markdownText(finding.waiverExpires)}: ${markdownText(finding.waiverReason)}`
    : "Not waived";

  return [
    markerFor(finding.modelKey),
    decisionMarker(finding.decisionId),
    "## UsageTap model lifecycle finding",
    "",
    `- Model key: ${markdownText(finding.modelKey)}`,
    `- Source locations: ${sourceLocations(finding.locations)}`,
    `- Lifecycle state: ${markdownText(finding.status)}`,
    `- Shutdown date: ${markdownText(finding.shutdownAt)}`,
    `- Provider evidence: ${evidence}`,
    `- Evidence checked: ${checked}`,
    `- Provider-designated replacement: ${providerReplacement}`,
    `- Computed/cross-provider recommendation: ${recommendation}`,
    `- UsageTap recommendation: ${markdownText(finding.action)}`,
    `- Waiver state: ${waiver}`,
    "",
    "### Migration review",
    "",
    "Verify the provider evidence, test the provider-designated replacement with representative requests, and evaluate computed or cross-provider recommendations separately. Use a reasoned, expiring waiver only when migration cannot finish before the enforcement date.",
    "",
    "This issue is intentionally left open if a later scan stops finding the model; path or scanner changes can also make a model disappear.",
  ].join("\n");
}

function issueTitle(finding) {
  return `[UsageTap] ${markdownText(finding.action)}: ${markdownText(finding.modelKey)}`;
}

function nextPage(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

function githubError(status, body) {
  const detail = body && typeof body === "object" ? body.message : String(body || "request failed");
  if (status === 401 || status === 403) {
    return new Error(`GitHub issue request was denied (${status}). Provide github-token and grant the workflow issues: write. ${detail}`);
  }
  return new Error(`GitHub issue request failed with HTTP ${status}: ${detail}`);
}

async function createGithubClient(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Issue creation requires Node.js fetch support.");
  const apiBaseUrl = String(options.apiBaseUrl || "https://api.github.com").replace(/\/$/, "");
  const repository = String(options.repository || "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("issue-policy requires GITHUB_REPOSITORY in owner/repository form.");
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "User-Agent": "usagetap-model-lifecycle-action/1.1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function request(method, url, body) {
    const response = await fetchImpl(url.startsWith("http") ? url : `${apiBaseUrl}${url}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = text.slice(0, 500); }
      }
    }
    if (!response.ok) throw githubError(response.status, payload);
    return { data: payload, headers: response.headers };
  }

  return { apiBaseUrl, repository, request };
}

async function findOpenIssue(client, modelKey) {
  const marker = markerFor(modelKey);
  let url = `${client.apiBaseUrl}/repos/${client.repository}/issues?state=open&per_page=100&page=1`;
  const visited = new Set();
  while (url) {
    if (visited.has(url)) throw new Error("GitHub issue pagination returned a repeated next page URL.");
    visited.add(url);
    const response = await client.request("GET", url);
    const issues = Array.isArray(response.data) ? response.data : [];
    const match = issues.find((issue) => !issue.pull_request && typeof issue.body === "string" && issue.body.includes(marker));
    if (match) return match;
    url = nextPage(response.headers?.get?.("link"));
  }
  return null;
}

async function availableLabel(client, label) {
  if (!label) return null;
  try {
    await client.request("GET", `/repos/${client.repository}/labels/${encodeURIComponent(label)}`);
    return label;
  } catch (error) {
    if (/HTTP 404/.test(error.message)) return null;
    throw error;
  }
}

async function syncMigrationIssues(findings, options = {}) {
  const policy = normalizeIssuePolicy(options.policy);
  if (policy === "off") return [];
  if (!options.token) {
    throw new Error("github-token is required when issue-policy enables migration issues; grant the workflow issues: write.");
  }
  const selected = findings.filter((finding) => shouldTrack(policy, finding));
  if (!selected.length) return [];
  const client = await createGithubClient(options);
  const label = await availableLabel(client, String(options.label || "").trim());
  const assignees = options.assignees || [];
  const changes = [];

  for (const finding of selected) {
    const existing = await findOpenIssue(client, finding.modelKey);
    const body = issueBody(finding);
    const payload = {
      title: issueTitle(finding),
      body,
      ...(label ? { labels: [label] } : {}),
      ...(assignees.length ? { assignees } : {}),
    };
    if (!existing) {
      const created = await client.request("POST", `/repos/${client.repository}/issues`, payload);
      changes.push({ modelKey: finding.modelKey, action: "created", issueNumber: created.data?.number });
      continue;
    }
    if (existing.body.includes(decisionMarker(finding.decisionId))) {
      changes.push({ modelKey: finding.modelKey, action: "unchanged", issueNumber: existing.number });
      continue;
    }
    await client.request("PATCH", `/repos/${client.repository}/issues/${existing.number}`, payload);
    changes.push({ modelKey: finding.modelKey, action: "updated", issueNumber: existing.number });
  }
  return changes;
}

module.exports = {
  decisionMarker,
  issueBody,
  markerFor,
  normalizeIssuePolicy,
  shouldTrack,
  syncMigrationIssues,
};
