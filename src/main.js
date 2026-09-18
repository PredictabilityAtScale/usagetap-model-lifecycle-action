"use strict";

const { annotation, appendSummary, setOutput } = require("./github.js");
const { loadModelFiles } = require("./model-files.js");
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
  const allowed = new Set(["replace", "review", "both", "never"]);
  for (const item of items) if (!allowed.has(item)) throw new Error(`Unsupported fail-on value: ${item}`);
  if (items.has("never") && items.size > 1) throw new Error("fail-on never cannot be combined with other values.");
  if (items.has("never")) return new Set();
  if (items.has("both")) return new Set(["replace", "review"]);
  return items;
}

function markdownCell(value) {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("`", "\\`")
    .replace(/[\r\n]+/g, " ");
}

const LEVEL_RANK = { notice: 0, warning: 1, error: 2 };

function moreSevere(current, candidate) {
  return LEVEL_RANK[candidate] > LEVEL_RANK[current] ? candidate : current;
}

function decisionMessage(modelKey, decision, waiver) {
  const parts = [`${modelKey}: ${decision.lifecycle.status} → ${decision.action}`];
  if (decision.providerReplacementModelKey) parts.push(`official replacement ${decision.providerReplacementModelKey}`);
  if (decision.recommendedModelKey && decision.recommendedModelKey !== decision.providerReplacementModelKey) {
    parts.push(`recommendation ${decision.recommendedModelKey} (${decision.recommendationSource || "unspecified source"})`);
  }
  if (decision.lifecycle.shutdownAt) parts.push(`shutdown ${decision.lifecycle.shutdownAt}`);
  if (decision.lifecycle.source?.url) {
    parts.push(`evidence ${decision.lifecycle.source.label || decision.lifecycle.source.url}: ${decision.lifecycle.source.url}`);
  }
  if (decision.degraded) parts.push("response is degraded");
  if (waiver) parts.push(`WAIVED through ${waiver.expires}: ${waiver.reason}`);
  return parts.join("; ");
}

function waiverResult(waiver) {
  return waiver ? {
    waived: true,
    waiverExpires: waiver.expires,
    waiverReason: waiver.reason,
    waiverFile: waiver.file,
    waiverLine: waiver.line,
  } : { waived: false };
}

async function run() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const failOn = normalizeFailOn(input("fail-on", "replace"));
  const unknownPolicy = input("unknown-policy", "warn").toLowerCase();
  const apiErrorPolicy = input("api-error-policy", "error").toLowerCase();
  if (!new Set(["warn", "error", "ignore"]).has(unknownPolicy)) throw new Error("unknown-policy must be warn, error, or ignore.");
  if (!new Set(["warn", "error"]).has(apiErrorPolicy)) throw new Error("api-error-policy must be error or warn.");

  const modelFiles = await loadModelFiles({
    root: workspace,
    includeFile: input("include-file", "models.include"),
    ignoreFile: input("ignore-file", "models.ignore"),
  });

  const scan = await scanRepository({
    root: workspace,
    paths: splitList(input("paths", ".")),
    exclude: splitList(input("exclude")),
    maxFileBytes: parsePositiveInteger("max-file-bytes", 1024 * 1024),
  });

  for (const declared of modelFiles.includes) {
    if (!scan.byModel.has(declared.modelKey)) scan.byModel.set(declared.modelKey, [declared]);
  }

  for (const explicit of splitList(input("models"))) {
    const modelKey = normalizeCandidate(explicit);
    if (!modelKey) throw new Error(`Explicit model is not recognized; use provider/model: ${explicit}`);
    if (!scan.byModel.has(modelKey)) scan.byModel.set(modelKey, [{ modelKey, raw: explicit }]);
  }

  const modelKeys = [...scan.byModel.keys()].sort();
  const matchedWaivers = new Set(modelKeys.filter((modelKey) => modelFiles.waivers.has(modelKey)));
  const unusedWaivers = [...modelFiles.waivers.values()]
    .filter((waiver) => !matchedWaivers.has(waiver.modelKey))
    .sort((left, right) => left.modelKey.localeCompare(right.modelKey));
  const maxModels = parsePositiveInteger("max-models", 100);
  if (modelKeys.length > maxModels) throw new Error(`Found ${modelKeys.length} model keys, above max-models=${maxModels}. Narrow paths/exclude or raise the limit.`);

  process.stdout.write(`UsageTap: scanned ${scan.filesScanned} files and found ${modelKeys.length} unique model key(s).\n`);
  const lookups = await lookupModels(modelKeys, {
    baseUrl: input("api-base-url", "https://api.usagetap.com"),
  });

  const counts = {
    KEEP: 0,
    REPLACE: 0,
    REVIEW: 0,
    UNKNOWN: 0,
    DEGRADED: 0,
    ERROR: 0,
    WAIVED: matchedWaivers.size,
    UNUSED_WAIVER: unusedWaivers.length,
  };
  const compactResults = [];
  let shouldFail = false;
  let errorLevelCount = 0;

  for (const modelKey of modelKeys) {
    const locations = scan.byModel.get(modelKey);
    const waiver = modelFiles.waivers.get(modelKey);
    const result = lookups.get(modelKey);
    if (!result.ok) {
      counts.ERROR += 1;
      const level = apiErrorPolicy === "error" ? "error" : "warning";
      if (level === "error") {
        shouldFail = true;
        errorLevelCount += 1;
      }
      for (const location of locations) annotation(level, result.error, location, "UsageTap API check failed");
      compactResults.push({ modelKey, error: result.error, ...waiverResult(waiver) });
      continue;
    }

    const decision = result.data;
    counts[decision.action] = (counts[decision.action] || 0) + 1;
    const isUnknown = decision.lifecycle.status === "UNKNOWN";
    if (isUnknown) counts.UNKNOWN += 1;
    if (decision.degraded) counts.DEGRADED += 1;
    let level = "notice";
    if (decision.degraded) {
      level = moreSevere(level, apiErrorPolicy === "error" ? "error" : "warning");
    } else if (waiver) {
      level = "warning";
    } else if (isUnknown) {
      const unknownLevel = unknownPolicy === "error" ? "error" : unknownPolicy === "warn" ? "warning" : "notice";
      level = moreSevere(level, unknownLevel);
    } else {
      if (failOn.has(decision.action.toLowerCase())) level = "error";
      else if (decision.action !== "KEEP") level = moreSevere(level, "warning");
    }
    if (level === "error") {
      shouldFail = true;
      errorLevelCount += 1;
    }

    const message = decisionMessage(modelKey, decision, waiver);
    const shouldAnnotate = Boolean(waiver)
      || decision.degraded
      || (isUnknown ? unknownPolicy !== "ignore" : decision.action !== "KEEP");
    if (shouldAnnotate) {
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
      lifecycleSourceLabel: decision.lifecycle.source?.label || null,
      lifecycleSourceUrl: decision.lifecycle.source?.url || null,
      lifecycleCheckedAt: decision.lifecycle.source?.checkedAt || null,
      degraded: Boolean(decision.degraded),
      decisionId: decision.decisionId || null,
      validUntil: decision.validUntil || null,
      ...waiverResult(waiver),
    });
  }

  for (const waiver of unusedWaivers) {
    annotation(
      "warning",
      `${waiver.modelKey}: waiver is unused; remove it or declare the model in models.include`,
      waiver,
      "Unused UsageTap model waiver",
    );
  }

  const rows = compactResults.map((result) => {
    if (result.error) return `| \`${markdownCell(result.modelKey)}\` | ERROR | — | ${markdownCell(result.error)} | — |`;
    const replacement = result.providerReplacementModelKey || result.recommendedModelKey || "—";
    const details = [];
    if (result.shutdownAt) details.push(`Shutdown ${result.shutdownAt}`);
    else if (result.recommendationSource) details.push(result.recommendationSource);
    if (result.waived) details.push(`WAIVED through ${result.waiverExpires}: ${result.waiverReason}`);
    const detail = details.length ? details.join("; ") : "—";
    const evidence = result.lifecycleSourceUrl
      ? `[${markdownCell(result.lifecycleSourceLabel || "Provider source")}](${encodeURI(result.lifecycleSourceUrl).replaceAll("(", "%28").replaceAll(")", "%29")})${result.lifecycleCheckedAt ? ` · checked ${markdownCell(result.lifecycleCheckedAt)}` : ""}`
      : "—";
    const decision = `${result.status} / ${result.action}${result.waived ? " / WAIVED" : ""}`;
    return `| \`${markdownCell(result.modelKey)}\` | ${decision} | \`${markdownCell(replacement)}\` | ${markdownCell(detail)} | ${evidence} |`;
  });
  const unusedWaiverRows = unusedWaivers.map((waiver) => (
    `| \`${markdownCell(waiver.modelKey)}\` | ${markdownCell(waiver.expires)} | ${markdownCell(waiver.reason)} |`
  ));
  appendSummary([
    "## UsageTap model lifecycle check",
    "",
    `Scanned **${scan.filesScanned}** files, skipped **${scan.filesSkipped}**, and checked **${modelKeys.length}** unique model keys.`,
    "",
    `Decisions: **${counts.KEEP} KEEP**, **${counts.REVIEW} REVIEW**, **${counts.REPLACE} REPLACE**, **${counts.UNKNOWN} unknown**, **${counts.DEGRADED} degraded**, **${counts.ERROR} API errors**, **${counts.WAIVED} waived**.`,
    "",
    "| Model key | Decision | Replacement | Detail | Evidence |",
    "|---|---|---|---|---|",
    ...(rows.length ? rows : ["| — | No model keys found | — | — | — |"]),
    ...(unusedWaiverRows.length ? [
      "",
      "### Unused waivers",
      "",
      "These entries do not match a discovered, declared, or explicitly configured model.",
      "",
      "| Model key | Expires | Reason |",
      "|---|---|---|",
      ...unusedWaiverRows,
    ] : []),
    "",
    "UsageTap never changes repository configuration. Review replacements against your workload before applying them.",
  ].join("\n"));

  setOutput("models-found", String(modelKeys.length));
  setOutput("replace-count", String(counts.REPLACE));
  setOutput("review-count", String(counts.REVIEW));
  setOutput("keep-count", String(counts.KEEP));
  setOutput("unknown-count", String(counts.UNKNOWN));
  setOutput("degraded-count", String(counts.DEGRADED));
  setOutput("error-count", String(counts.ERROR));
  setOutput("waived-count", String(counts.WAIVED));
  setOutput("unused-waiver-count", String(counts.UNUSED_WAIVER));
  setOutput("files-scanned", String(scan.filesScanned));
  setOutput("files-skipped", String(scan.filesSkipped));
  setOutput("results-json", JSON.stringify(compactResults));

  if (shouldFail) {
    process.stdout.write(`UsageTap: failing because ${errorLevelCount} model check(s) matched an error policy (${counts.REPLACE} replace, ${counts.REVIEW} review, ${counts.UNKNOWN} unknown, ${counts.DEGRADED} degraded, ${counts.ERROR} API error).\n`);
    process.exitCode = 1;
  }
}

module.exports = { decisionMessage, normalizeFailOn, run };
