"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeCandidate } = require("./scanner.js");

const MAX_MODEL_FILE_BYTES = 256 * 1024;
const QUALIFIED_MODEL_RE = /^(?:openai|anthropic|google|gemini)[/:]/i;

function modelFileError(file, line, message) {
  return new Error(`${file}${line ? `:${line}` : ""}: ${message}`);
}

function normalizeDeclaredModel(value, file, line) {
  if (!QUALIFIED_MODEL_RE.test(value)) {
    throw modelFileError(file, line, "model keys must be provider-qualified, for example openai/gpt-4o");
  }
  const modelKey = normalizeCandidate(value);
  if (!modelKey) throw modelFileError(file, line, `invalid model key: ${value}`);
  return modelKey;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseIncludeFile(text, file) {
  const entries = [];
  const seen = new Set();
  for (const [index, rawLine] of String(text).replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const commentAt = trimmed.indexOf("#");
    const value = (commentAt === -1 ? trimmed : trimmed.slice(0, commentAt)).trim();
    const note = commentAt === -1 ? null : trimmed.slice(commentAt + 1).trim() || null;
    const modelKey = normalizeDeclaredModel(value, file, line);
    if (seen.has(modelKey)) throw modelFileError(file, line, `duplicate model key: ${modelKey}`);
    seen.add(modelKey);
    entries.push({ modelKey, file, line, raw: value, note });
  }
  return entries;
}

function parseIgnoreFile(text, file, options = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const waivers = new Map();
  for (const [index, rawLine] of String(text).replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const columns = trimmed.split("|").map((value) => value.trim());
    if (columns.length !== 3) {
      throw modelFileError(file, line, "expected: provider/model | YYYY-MM-DD | reason");
    }
    const [value, expires, reason] = columns;
    const modelKey = normalizeDeclaredModel(value, file, line);
    if (!validDate(expires)) throw modelFileError(file, line, `invalid expiry date: ${expires || "(empty)"}`);
    if (expires < today) throw modelFileError(file, line, `waiver for ${modelKey} expired on ${expires}`);
    if (!reason) throw modelFileError(file, line, "waivers require a reason");
    if (reason.length > 500) throw modelFileError(file, line, "waiver reason must be 500 characters or fewer");
    if (waivers.has(modelKey)) throw modelFileError(file, line, `duplicate waiver: ${modelKey}`);
    waivers.set(modelKey, { modelKey, expires, reason, file, line });
  }
  return waivers;
}

async function readOptionalModelFile(root, configuredPath) {
  if (!configuredPath) return null;
  const absolutePath = path.resolve(root, configuredPath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Model file escapes the repository root: ${configuredPath}`);
  }
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Model file must be a regular file: ${configuredPath}`);
  if (stat.size > MAX_MODEL_FILE_BYTES) throw new Error(`Model file is larger than ${MAX_MODEL_FILE_BYTES} bytes: ${configuredPath}`);
  return {
    file: path.relative(root, absolutePath).replaceAll("\\", "/"),
    text: await fs.readFile(absolutePath, "utf8"),
  };
}

async function loadModelFiles(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const [includeFile, ignoreFile] = await Promise.all([
    readOptionalModelFile(root, options.includeFile),
    readOptionalModelFile(root, options.ignoreFile),
  ]);
  return {
    includes: includeFile ? parseIncludeFile(includeFile.text, includeFile.file) : [],
    waivers: ignoreFile ? parseIgnoreFile(ignoreFile.text, ignoreFile.file, options) : new Map(),
  };
}

module.exports = { loadModelFiles, parseIgnoreFile, parseIncludeFile };
