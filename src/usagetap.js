"use strict";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function modelPath(modelKey) {
  return modelKey.split("/").map(encodeURIComponent).join("/");
}

async function lookupModel(modelKey, options = {}) {
  const baseUrl = String(options.baseUrl || "https://api.usagetap.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("This action requires Node.js fetch support.");

  const url = new URL(`${baseUrl}/v1/model-alternatives/${modelPath(modelKey)}`);
  url.searchParams.set("purpose", "retirement");
  url.searchParams.set("response", "light");
  const retries = options.retries ?? 2;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "usagetap-model-lifecycle-action/0.1" },
        signal: controller.signal,
      });
      if (response.ok) {
        const payload = await response.json();
        if (payload.schemaVersion !== 1 || !payload.lifecycle || !payload.action) {
          throw new Error(`Unexpected response schema for ${modelKey}`);
        }
        return payload;
      }
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === retries) {
        const body = await response.text();
        throw new Error(`UsageTap returned HTTP ${response.status} for ${modelKey}: ${body.slice(0, 200)}`);
      }
    } catch (error) {
      if (attempt === retries) {
        const detail = error?.name === "AbortError" ? "request timed out" : error.message;
        throw new Error(`Could not check ${modelKey}: ${detail}`);
      }
    } finally {
      clearTimeout(timer);
    }
    await sleep(250 * (2 ** attempt));
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

module.exports = { lookupModel, lookupModels };
