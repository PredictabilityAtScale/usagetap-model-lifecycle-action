#!/usr/bin/env node

"use strict";

require("../src/main.js").run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`::error title=UsageTap model lifecycle check failed::${escapeCommand(message)}\n`);
  process.exitCode = 1;
});

function escapeCommand(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}
