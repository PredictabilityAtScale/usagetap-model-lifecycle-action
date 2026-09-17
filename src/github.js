"use strict";

const fs = require("node:fs");

function escapeCommand(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value) {
  return escapeCommand(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function annotation(level, message, location = {}, title = "UsageTap model lifecycle") {
  const properties = [];
  if (location.file) properties.push(`file=${escapeProperty(location.file)}`);
  if (location.line) properties.push(`line=${location.line}`);
  if (title) properties.push(`title=${escapeProperty(title)}`);
  process.stdout.write(`::${level}${properties.length ? ` ${properties.join(",")}` : ""}::${escapeCommand(message)}\n`);
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const delimiter = `usagetap_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

function appendSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, "utf8");
  }
}

module.exports = { annotation, appendSummary, escapeCommand, setOutput };
