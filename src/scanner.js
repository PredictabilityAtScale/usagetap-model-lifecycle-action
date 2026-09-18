"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_IGNORED_DIRS = new Set([
  ".git", ".hg", ".svn", ".next", ".nuxt", ".venv", "venv",
  "node_modules", "vendor", "dist", "build", "coverage", "target", "out",
]);

const SCANNABLE_EXTENSIONS = new Set([
  ".cjs", ".conf", ".cs", ".env", ".go", ".graphql", ".hcl", ".html",
  ".ini", ".java", ".js", ".json", ".json5", ".jsx", ".kt", ".mjs",
  ".php", ".properties", ".py", ".rb", ".rs", ".sh", ".swift", ".toml",
  ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml",
]);

// Keep model patterns bounded and free of nested, ambiguous repetition. The
// scanner runs on untrusted pull-request content, so regex performance is a
// security property rather than only an optimization.
const MODEL_BODY = "[a-z0-9][a-z0-9._:-]{0,119}";
const KNOWN_MODEL = [
  `gpt-${MODEL_BODY}`,
  `chatgpt-${MODEL_BODY}`,
  `o[1345](?:-${MODEL_BODY})?`,
  `text-embedding-${MODEL_BODY}`,
  `(?:text|code)-davinci-\\d+`,
  `(?:babbage|davinci)-\\d+`,
  `dall-e-${MODEL_BODY}`,
  `whisper-${MODEL_BODY}`,
  `tts-${MODEL_BODY}`,
  `claude-${MODEL_BODY}`,
  `gemini-${MODEL_BODY}`,
].join("|");

const KNOWN_MODEL_RE = new RegExp(`^(?:${KNOWN_MODEL})$`, "i");
const QUOTED_MODEL_RE = new RegExp("([\\\"'`])(" + KNOWN_MODEL + ")\\1", "gi");
const QUALIFIED_MODEL_RE = /(?<!publishers\/)\b(openai|anthropic|google|gemini)[/:]([a-z0-9][a-z0-9._:/-]{0,191})(?![a-z0-9._:/-])/gi;
const BEDROCK_ANTHROPIC_RE = /\banthropic\.(claude-[a-z0-9][a-z0-9._:-]{0,159})(?![a-z0-9._:-])/gi;
const VERTEX_MODEL_RE = /\bpublishers\/(google|anthropic)\/models\/(gemini-[a-z0-9][a-z0-9._:-]{0,159}|claude-[a-z0-9][a-z0-9._:-]{0,159})(?![a-z0-9._:-])/gi;
const ASSIGNED_MODEL_RE = new RegExp(
  `(?:^|[\\r\\n])([ \\t]*(?:-[ \\t]+)?(?:(?:[a-z][a-z0-9_]*_)?model(?:[-_](?:id|name|key))?)[ \\t]*[:=][ \\t]*)((?:(?:openai|anthropic|google|gemini)[/:])?(?:${KNOWN_MODEL}))(?=[ \\t]*(?:#.*)?(?:\\r?$))`,
  "gim",
);
const QUALIFIED_BODY_RE = /^[a-z0-9][a-z0-9._:/-]{0,191}$/i;

function providerForModel(model) {
  const value = model.toLowerCase();
  if (value.startsWith("claude-")) return "anthropic";
  if (value.startsWith("gemini-")) return "google";
  return "openai";
}

function stripCloudSuffix(model) {
  return model.replace(/-v\d+:\d+$/i, "");
}

function normalizeCandidate(value, providerHint) {
  let candidate = String(value).trim().replace(/^models\//i, "");
  const qualified = candidate.match(/^(openai|anthropic|google|gemini)[/:](.+)$/i);
  if (qualified) {
    const provider = qualified[1].toLowerCase() === "gemini" ? "google" : qualified[1].toLowerCase();
    const model = stripCloudSuffix(qualified[2].toLowerCase());
    if (!QUALIFIED_BODY_RE.test(model)) return null;
    return `${provider}/${model}`;
  }

  candidate = stripCloudSuffix(candidate.toLowerCase());
  const provider = providerHint === "gemini" ? "google" : (providerHint || providerForModel(candidate));
  if (!/^(openai|anthropic|google)$/.test(provider)) return null;
  if (!KNOWN_MODEL_RE.test(candidate)) return null;
  return `${provider}/${candidate}`;
}

function newlineOffsets(text) {
  const offsets = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) offsets.push(index);
  }
  return offsets;
}

function lineNumberAt(offsets, index) {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] < index) low = middle + 1;
    else high = middle;
  }
  return low + 1;
}

function extractModelRefs(text, file) {
  const found = [];
  const seen = new Set();
  const offsets = newlineOffsets(text);
  const add = (modelKey, index, raw) => {
    if (!modelKey) return;
    const line = lineNumberAt(offsets, index);
    const identity = `${modelKey}:${line}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    found.push({ modelKey, file, line, raw });
  };

  for (const match of text.matchAll(QUALIFIED_MODEL_RE)) {
    add(normalizeCandidate(`${match[1]}/${match[2]}`), match.index, match[0]);
  }
  for (const match of text.matchAll(VERTEX_MODEL_RE)) {
    add(normalizeCandidate(match[2], match[1]), match.index, match[0]);
  }
  for (const match of text.matchAll(BEDROCK_ANTHROPIC_RE)) {
    add(normalizeCandidate(match[1], "anthropic"), match.index, match[0]);
  }
  for (const match of text.matchAll(ASSIGNED_MODEL_RE)) {
    const valueOffset = match[0].lastIndexOf(match[2]);
    add(normalizeCandidate(match[2]), match.index + valueOffset, match[2]);
  }
  for (const match of text.matchAll(QUOTED_MODEL_RE)) {
    add(normalizeCandidate(match[2]), match.index, match[0]);
  }
  return found;
}

function splitList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function globToRegExp(glob) {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*" && normalized[index + 2] === "/") {
      expression += "(?:.*/)?";
      index += 2;
    } else if (char === "/" && normalized[index + 1] === "*" && normalized[index + 2] === "*" && index + 3 === normalized.length) {
      expression += "(?:/.*)?";
      index += 2;
    } else if (char === "*" && normalized[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^(?:${expression})(?:/.*)?$`);
}

function isScannableFile(file) {
  const base = path.basename(file).toLowerCase();
  if (base === "dockerfile" || base === "makefile" || base.startsWith(".env")) return true;
  return SCANNABLE_EXTENSIONS.has(path.extname(base));
}

async function looksBinary(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function scanRepository(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const scanPaths = options.paths?.length ? options.paths : ["."];
  const maxFileBytes = options.maxFileBytes || 1024 * 1024;
  const excludeMatchers = (options.exclude || []).map(globToRegExp);
  const occurrences = [];
  const visited = new Set();
  let filesScanned = 0;
  let filesSkipped = 0;

  const isExcluded = (relativePath) => {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
    return excludeMatchers.some((matcher) => matcher.test(normalized));
  };

  async function visit(absolutePath) {
    const visitKey = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const relativePath = path.relative(root, absolutePath).replaceAll("\\", "/") || ".";
    if (relativePath !== "." && isExcluded(relativePath)) return;

    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (relativePath !== "." && DEFAULT_IGNORED_DIRS.has(path.basename(absolutePath).toLowerCase())) return;
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries) await visit(path.join(absolutePath, entry.name));
      return;
    }
    if (!stat.isFile() || !isScannableFile(absolutePath) || stat.size > maxFileBytes) {
      filesSkipped += 1;
      return;
    }
    if (await looksBinary(absolutePath)) {
      filesSkipped += 1;
      return;
    }
    const text = await fs.readFile(absolutePath, "utf8");
    occurrences.push(...extractModelRefs(text, relativePath));
    filesScanned += 1;
  }

  for (const requestedPath of scanPaths) {
    const absolutePath = path.resolve(root, requestedPath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Scan path escapes the repository root: ${requestedPath}`);
    }
    try {
      await visit(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`Scan path does not exist: ${requestedPath}`);
      throw error;
    }
  }

  const byModel = new Map();
  for (const occurrence of occurrences) {
    const current = byModel.get(occurrence.modelKey) || [];
    current.push(occurrence);
    byModel.set(occurrence.modelKey, current);
  }
  return { byModel, occurrences, filesScanned, filesSkipped };
}

module.exports = {
  extractModelRefs,
  normalizeCandidate,
  scanRepository,
  splitList,
};
