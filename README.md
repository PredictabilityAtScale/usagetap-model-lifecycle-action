# UsageTap Model Lifecycle Check

A dependency-free GitHub Action example that finds model keys in a repository, checks each unique key against UsageTap's public Model Alternatives API, and annotates the files that need attention.

## Why this shape

Regex is useful for discovery, but it should not make migration decisions. This action normalizes recognizable model IDs and sends only those IDs to UsageTap. UsageTap returns the lifecycle decision and keeps provider aliases, official replacements, and computed recommendations distinct.

The default policy is intentionally conservative:

- `REPLACE` fails the job.
- `REVIEW` and unknown keys warn.
- API failures and degraded responses fail closed.
- No source code, prompts, credentials, or configuration values are sent—only normalized model keys.
- The action never modifies repository files or silently changes a model.

## Example workflow

```yaml
name: Model lifecycle

on:
  pull_request:
  schedule:
    - cron: "17 9 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check-models:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: PredictabilityAtScale/usagetap-model-lifecycle-action@v1
        with:
          paths: |
            src
            config
          fail-on: replace
          unknown-policy: warn
```

Run it on pull requests **and** on a schedule. A provider can deprecate a model even when the repository has not changed.

## What the scanner recognizes

- Provider-qualified keys such as `openai/gpt-4-turbo`, `anthropic/claude-3-5-sonnet-20241022`, and `google/gemini-2.5-pro`
- Quoted OpenAI-family, Claude-family, and Gemini-family model IDs in JS/TS, Python, JSON, YAML, TOML, environment files, and other common configuration/code formats
- AWS Bedrock Anthropic IDs such as `anthropic.claude-...-v2:0`, normalized to the underlying Anthropic key
- Vertex publisher paths such as `publishers/google/models/gemini-...`
- Explicit keys supplied with the `models` input

The scanner skips common dependency/build directories, binary files, Markdown, lockfiles, and files larger than 1 MiB by default.

## Important limitation

No regex can recover a model from a value that is computed at runtime or hidden behind an arbitrary deployment alias. Azure OpenAI deployment names are the common example. Supply those models explicitly:

```yaml
with:
  models: |
    openai/gpt-5.6-sol
    anthropic/claude-sonnet-4-6
```

A future production version can support a checked-in mapping file for deployment aliases.

## Inputs

| Input | Default | Purpose |
|---|---:|---|
| `paths` | `.` | Comma/newline separated files or directories under the repository root |
| `exclude` | empty | Extra path globs to skip |
| `models` | empty | Explicit provider-qualified keys to check |
| `fail-on` | `replace` | `replace`, `review`, both, or `never` |
| `unknown-policy` | `warn` | `warn`, `error`, or `ignore` |
| `api-error-policy` | `error` | `error` or `warn` |
| `max-file-bytes` | `1048576` | Per-file scan limit |
| `max-models` | `100` | Maximum unique keys per run |
| `api-base-url` | `https://api.usagetap.com` | Override for testing or self-hosted routing |

## Outputs

`models-found`, `replace-count`, `review-count`, `keep-count`, and `results-json` are available to later workflow steps. A Markdown decision table is written to the job summary.

## Local tests

```bash
npm test
```

The action uses GitHub's Node 24 runtime and Node built-ins only, so there is no dependency bundle to audit or update.

## Before publishing

1. Confirm the GitHub test matrix passes on Ubuntu, Windows, and macOS.
2. Add integration fixtures for every provider/model format you officially support.
3. Tag an immutable release such as `v1.0.0`, then move a `v1` major tag to that commit.
4. Publish the action in GitHub Marketplace after validating `action.yml` and the README.
