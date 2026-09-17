"use strict";

const { annotation, appendSummary, setOutput } = require("./github.js");
const { normalizeCandidate, scanRepository, splitList } = require("./scanner.js");
const { lookupModels } = require("./usagetap.js");

function input(name, fallback = "") {
  const key = `INPUT_${name.replaceAll("-", "_").toUpperCase()}`;
  return process.env[key] === undefined ? fallback : process.env[key].trim();
}

function parsePositiveInteger(name, fallback) {
  const value = Number.parseInt(input(name, String(fallback)), 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function normalizeFailOn(value) {
  const items = new Set(splitList(value.toLowerCase()));
  const allowed = new Set(["replace", "review", "never"]);
  for (const item of items) if (!allowed.has(item)) throw new Error(`Unsupported fail-on value: ${item}`);
  if (items.has("never")) return new Set();
  return items;
}

function markdownCell(value) {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function decisionMessage(modelKey, decision) {
  const parts = [`${modelKey}: ${decision.lifecycle.status} → ${decision.action}`];
  if (decision.providerReplacementModelKey) parts.push(`official replacement ${decision.providerReplacementModelKey}`);
  if (decision.recommendedModelKey && decision.recommendedModelKey !== decision.providerReplacementModelKey) {
    parts.push(`recommendation ${decision.recommendedModelKey} (${decision.recommendationSource || "unspecified source"})`);
  }
  if (decision.lifecycle.shutdownAt) parts.push(`shutdown ${decision.lifecycle.shutdownAt}`);
  if (decision.degraded) parts.push("response is degraded");
  return parts.join("; ");
}

async function run() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const failOn = normalizeFailOn(input("fail-on", "replace"));
  const unknownPolicy = input("unknown-policy", "warn").toLowerCase();
  const apiErrorPolicy = input("api-error-policy", "error").toLowerCase();
  if (!new Set(["warn", "error", "ignore"]).has(unknownPolicy)) throw new Error("unknown-policy must be warn, error, or ignore.");
  if (!new Set(["warn", "error"]).has(apiErrorPolicy)) throw new Error("api-error-policy must be error or warn.");

  const scan = await scanRepository({
    root: workspace,
    paths: splitList(input("paths", ".")),
    exclude: splitList(input("exclude")),
    maxFileBytes: parsePositiveInteger("max-file-bytes", 1024 * 1024),
  });

  for (const explicit of splitList(input("models"))) {
    const modelKey = normalizeCandidate(explicit);
    if (!modelKey) throw new Error(`Explicit model is not recognized; use provider/model: ${explicit}`);
    if (!scan.byModel.has(modelKey)) scan.byModel.set(modelKey, [{ modelKey, file: "action input", line: 1, raw: explicit }]);
  }

  const modelKeys = [...scan.byModel.keys()].sort();
  const maxModels = parsePositiveInteger("max-models", 100);
  if (modelKeys.length > maxModels) throw new Error(`Found ${modelKeys.length} model keys, above max-models=${maxModels}. Narrow paths/exclude or raise the limit.`);

  process.stdout.write(`UsageTap: scanned ${scan.filesScanned} files and found ${modelKeys.length} unique model key(s).\n`);
  const lookups = await lookupModels(modelKeys, {
    baseUrl: input("api-base-url", "https://api.usagetap.com"),
  });

  const counts = { KEEP: 0, REPLACE: 0, REVIEW: 0, ERROR: 0 };
  const compactResults = [];
  let shouldFail = false;

  for (const modelKey of modelKeys) {
    const locations = scan.byModel.get(modelKey);
    const result = lookups.get(modelKey);
    if (!result.ok) {
      counts.ERROR += 1;
      const level = apiErrorPolicy === "error" ? "error" : "warning";
      if (level === "error") shouldFail = true;
      for (const location of locations) annotation(level, result.error, location, "UsageTap API check failed");
      compactResults.push({ modelKey, error: result.error });
      continue;
    }

    const decision = result.data;
    counts[decision.action] = (counts[decision.action] || 0) + 1;
    const isUnknown = decision.lifecycle.status === "UNKNOWN";
    let level = "notice";
    if (decision.degraded) {
      level = apiErrorPolicy === "error" ? "error" : "warning";
    } else if (isUnknown) {
      level = unknownPolicy === "error" ? "error" : unknownPolicy === "warn" ? "warning" : "notice";
    } else if (failOn.has(decision.action.toLowerCase())) {
      level = "error";
    } else if (decision.action !== "KEEP") {
      level = "warning";
    }
    if (level === "error") shouldFail = true;

    const message = decisionMessage(modelKey, decision);
    if (!(isUnknown && unknownPolicy === "ignore") && decision.action !== "KEEP") {
      for (const location of locations) annotation(level, message, location);
    }
    compactResults.push({
      modelKey,
      status: decision.lifecycle.status,
      action: decision.action,
      shutdownAt: decision.lifecycle.shutdownAt || null,
      providerReplacementModelKey: decision.providerReplacementModelKey || null,
      recommendedModelKey: decision.recommendedModelKey || null,
      recommendationSource: decision.recommendationSource || null,
      degraded: Boolean(decision.degraded),
      decisionId: decision.decisionId || null,
      validUntil: decision.validUntil || null,
    });
  }

  const rows = compactResults.map((result) => {
    if (result.error) return `| \`${markdownCell(result.modelKey)}\` | ERROR | — | ${markdownCell(result.error)} |`;
    const replacement = result.providerReplacementModelKey || result.recommendedModelKey || "—";
    const detail = result.shutdownAt ? `Shutdown ${result.shutdownAt}` : result.recommendationSource || "—";
    return `| \`${markdownCell(result.modelKey)}\` | ${result.status} / ${result.action} | \`${markdownCell(replacement)}\` | ${markdownCell(detail)} |`;
  });
  appendSummary([
    "## UsageTap model lifecycle check",
    "",
    `Scanned **${scan.filesScanned}** files and checked **${modelKeys.length}** unique model keys.`,
    "",
    "| Model key | Decision | Replacement | Detail |",
    "|---|---|---|---|",
    ...(rows.length ? rows : ["| — | No model keys found | — | — |"]),
    "",
    "UsageTap never changes repository configuration. Review replacements against your workload before applying them.",
  ].join("\n"));

  setOutput("models-found", String(modelKeys.length));
  setOutput("replace-count", String(counts.REPLACE));
  setOutput("review-count", String(counts.REVIEW));
  setOutput("keep-count", String(counts.KEEP));
  setOutput("results-json", JSON.stringify(compactResults));

  if (shouldFail) {
    process.stdout.write(`UsageTap: failing because ${counts.REPLACE} replacement(s), ${counts.REVIEW} review(s), or ${counts.ERROR} API error(s) matched policy.\n`);
    process.exitCode = 1;
  }
}

module.exports = { decisionMessage, normalizeFailOn, run };
