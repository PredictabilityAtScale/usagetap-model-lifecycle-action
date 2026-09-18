"use strict";

const fs = require("node:fs");
const path = require("node:path");

const output = path.resolve(__dirname, "../dist/index.js");
const contents = `#!/usr/bin/env node

"use strict";

require("../src/main.js").run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(\`::error title=UsageTap model lifecycle check failed::\${escapeCommand(message)}\\n\`);
  process.exitCode = 1;
});

function escapeCommand(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\\r", "%0D")
    .replaceAll("\\n", "%0A");
}
`;

if (process.argv.includes("--check")) {
  const packaged = fs.readFileSync(output, "utf8").replaceAll("\r\n", "\n");
  if (packaged !== contents) {
    process.stderr.write("dist/index.js is stale; run npm run build.\n");
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(output, contents, "utf8");
  process.stdout.write("Rebuilt dist/index.js.\n");
}
