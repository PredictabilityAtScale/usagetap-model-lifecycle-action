"use strict";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function modelPath(modelKey) {
  return modelKey.split("/").map(encodeURIComponent).join("/");
}

const ACTIONS = new Set(["KEEP", "REVIEW", "REPLACE"]);
const STATUS_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const MODEL_KEY_RE = /^[a-z0-9][a-z0-9._:/-]{0,255}$/i;

function optionalString(payload, name, maxLength = 256) {
  const value = payload[name];
  return value === undefined || value === null || (typeof value === "string" && value.length <= maxLength);
}

function validLifecycleSource(source) {
  if (source === undefined || source === null) return true;
  if (typeof source !== "object" || Array.isArray(source)) return false;
  if (!optionalString(source, "label") || !optionalString(source, "checkedAt", 64) || !optionalString(source, "url", 2048)) return false;
  if (!source.url) return true;
  try {
    const url = new URL(source.url);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validateDecision(payload, modelKey) {
  const validObject = payload && typeof payload === "object" && !Array.isArray(payload);
  const lifecycle = validObject ? payload.lifecycle : null;
  const validLifecycle = lifecycle && typeof lifecycle === "object" && !Array.isArray(lifecycle);
  const valid = validObject
    && payload.schemaVersion === 1
    && validLifecycle
    && typeof lifecycle.status === "string"
    && STATUS_RE.test(lifecycle.status)
    && ACTIONS.has(payload.action)
    && (lifecycle.status !== "UNKNOWN" || payload.action === "REVIEW")
    && (payload.degraded === undefined || typeof payload.degraded === "boolean")
    && optionalString(lifecycle, "shutdownAt", 64)
    && validLifecycleSource(lifecycle.source)
    && optionalString(payload, "recommendationSource", 64)
    && optionalString(payload, "decisionId")
    && optionalString(payload, "validUntil", 64)
    && optionalString(payload, "providerReplacementModelKey")
    && optionalString(payload, "recommendedModelKey")
    && (!payload.providerReplacementModelKey || MODEL_KEY_RE.test(payload.providerReplacementModelKey))
    && (!payload.recommendedModelKey || MODEL_KEY_RE.test(payload.recommendedModelKey));
  if (!valid) throw new Error(`Unexpected response schema for ${modelKey}`);
  return payload;
}

function retryDelay(response, attempt, options) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.min(Math.max(0, timestamp - Date.now()), 10000);
  }
  const base = options.retryBaseDelayMs ?? 250;
  const random = options.randomImpl || Math.random;
  return Math.min(base * (2 ** attempt) + Math.floor(random() * base), 10000);
}

function nonRetryable(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

async function lookupModel(modelKey, options = {}) {
  const baseUrl = String(options.baseUrl || "https://api.usagetap.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("This action requires Node.js fetch support.");

  const url = new URL(`${baseUrl}/v1/model-alternatives/${modelPath(modelKey)}`);
  url.searchParams.set("purpose", "retirement");
  url.searchParams.set("response", "light");
  const retries = options.retries ?? 2;
  const sleepImpl = options.sleepImpl || sleep;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
    let responseForRetry;
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "usagetap-model-lifecycle-action/0.1" },
        signal: controller.signal,
      });
      if (response.ok) {
        try {
          return validateDecision(await response.json(), modelKey);
        } catch (error) {
          throw nonRetryable(error.message);
        }
      }
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === retries) {
        const body = await response.text();
        const error = new Error(`UsageTap returned HTTP ${response.status} for ${modelKey}: ${body.slice(0, 200)}`);
        if (![429, 500, 502, 503, 504].includes(response.status)) error.retryable = false;
        throw error;
      }
      responseForRetry = response;
      try {
        await response.body?.cancel?.();
      } catch {
        // A response body that is already closed does not prevent the retry.
      }
    } catch (error) {
      if (error?.retryable === false || attempt === retries) {
        const detail = error?.name === "AbortError"
          ? "request timed out"
          : error instanceof Error ? error.message : String(error);
        throw new Error(`Could not check ${modelKey}: ${detail}`);
      }
    } finally {
      clearTimeout(timer);
    }
    await sleepImpl(retryDelay(responseForRetry, attempt, options));
  }
  throw new Error(`Could not check ${modelKey}`);
}

async function lookupModels(modelKeys, options = {}) {
  const concurrency = Math.max(1, Math.min(options.concurrency || 6, 12));
  const results = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < modelKeys.length) {
      const index = cursor;
      cursor += 1;
      const modelKey = modelKeys[index];
      try {
        results.set(modelKey, { ok: true, data: await lookupModel(modelKey, options) });
      } catch (error) {
        results.set(modelKey, { ok: false, error: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, modelKeys.length) }, worker));
  return results;
}

module.exports = { lookupModel, lookupModels, validateDecision };
