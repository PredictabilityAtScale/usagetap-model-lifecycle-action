<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/branding/ut_dark_logo_256x256.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/branding/ut_light_logo_256x256.png">
    <img alt="UsageTap" src="assets/branding/ut_light_logo_256x256.png" width="160">
  </picture>
</p>

# UsageTap Model Lifecycle Check

[![Test action](https://github.com/PredictabilityAtScale/usagetap-model-lifecycle-action/actions/workflows/ci.yml/badge.svg)](https://github.com/PredictabilityAtScale/usagetap-model-lifecycle-action/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/PredictabilityAtScale/usagetap-model-lifecycle-action?display_name=tag&sort=semver)](https://github.com/PredictabilityAtScale/usagetap-model-lifecycle-action/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A dependency-free GitHub Action that finds AI model keys in a repository, audits each unique key against UsageTap's public Model Alternatives API, and annotates files that need attention. It is designed to answer two CI questions: **which models does this repository use, and which of them require lifecycle review or replacement?**

## Why this shape

Regex is useful for discovery, but it should not make migration decisions. This action normalizes recognizable model IDs and sends only those IDs to UsageTap. UsageTap returns the lifecycle decision and keeps provider aliases, official replacements, and computed recommendations distinct.

The default policy is intentionally conservative:

- `REPLACE` fails the job.
- `REVIEW` and unknown keys warn.
- API failures and degraded responses fail closed.
- No source code, prompts, credentials, or configuration values are sent—only normalized model keys.
- The action never modifies repository files or silently changes a model.

The public lookup does not require an API key. The action sends the configured endpoint only normalized model keys such as `openai/gpt-4-turbo`; it does not send source files, prompts, credentials, or surrounding configuration. See [Privacy and network access](#privacy-and-network-access).

## Advisory workflow

```yaml
name: Model lifecycle (advisory)

on:
  pull_request:
  push:
    branches: [main]
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
          paths: .
          fail-on: never
          unknown-policy: warn
          api-error-policy: warn
```

`fail-on: never` only disables lifecycle-decision failures. It does not make API failures or degraded responses advisory; `api-error-policy: warn` is also required for a fully advisory check.

## Enforced workflow

```yaml
name: Model lifecycle (enforced)

on:
  pull_request:
  push:
    branches: [main]
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
          paths: .
          fail-on: replace
          unknown-policy: warn
          api-error-policy: error
          minimum-models: 1
```

Repository events catch model-key changes in code. The weekly schedule catches a provider deprecation or retirement that can break an otherwise untouched application. Pushes run the merged result on this repository's default `main` branch; change the branch name if your default differs.

For production, pin this action and `actions/checkout` to verified full commit SHAs. Moving major tags such as `@v1` are convenient, but a full SHA is the immutable option.

See the copyable [enforced](examples/model-lifecycle.yml) and [advisory](examples/model-lifecycle-advisory.yml) workflows.

## Decision timing

- `KEEP`: the exact, source-backed lifecycle is `ACTIVE`.
- `REVIEW`: the exact key is unknown or the available evidence is insufficient.
- `REPLACE`: the exact key is `DEPRECATED` or `RETIRED`, regardless of the number of days until shutdown.

There is no configurable advance-warning window. `REVIEW` does not automatically become `REPLACE` at a date threshold. Enforcement is controlled by `fail-on` and by reasoned, expiring waivers.

## What the scanner recognizes

- Provider-qualified keys such as `openai/gpt-4-turbo`, `anthropic/claude-3-5-sonnet-20241022`, and `google/gemini-2.5-pro`, including unfamiliar model-family names that should be audited as unknown
- Quoted OpenAI-family, Claude-family, and Gemini-family model IDs in JS/TS, Python, JSON, YAML, TOML, environment files, and other common configuration/code formats
- Unquoted model assignments commonly used in environment, YAML, and TOML files, such as `OPENAI_MODEL=gpt-4o` and `model: claude-sonnet-4-6`
- AWS Bedrock Anthropic IDs such as `anthropic.claude-...-v2:0`, normalized to an Anthropic model key
- Vertex publisher paths such as `publishers/google/models/gemini-...`, normalized to a Google model key
- Explicit keys supplied through `models.include` or the `models` input

The scanner skips common dependency/build directories, binary files, Markdown, lockfiles, and files larger than 1 MiB by default. `exclude` supports `*`, `?`, and `**` globstars using repository-relative `/`-separated paths.

## Important limitation

Discovery and lifecycle authority are different. For normalized Bedrock and Vertex forms, the returned evidence covers the underlying provider lifecycle. It does not verify AWS Bedrock or Vertex AI region availability, platform aliases, or platform-specific retirement dates. When the scanner sees either platform form, the job summary states this limitation; the original platform identifier remains local scanner metadata and is not sent to UsageTap.

No regex can recover a model from a value that is computed at runtime or hidden behind an arbitrary deployment alias. Azure OpenAI deployment names are the common example. Declare those models in a root `models.include` file:

```text
# Models hidden behind runtime aliases
openai/gpt-5.6-sol # Azure production deployment
anthropic/claude-sonnet-4-6
```

The `models` action input provides the same capability for centrally managed workflows:

```yaml
with:
  models: |
    openai/gpt-5.6-sol
    anthropic/claude-sonnet-4-6
```

Azure and other arbitrary deployment aliases require explicit declarations. Keep those declarations under review: the action audits the provider/model key you supply but cannot prove which model an alias currently targets.

## Zero-model coverage

Every zero-model run emits a warning annotation and a prominent job-summary callout, even when `minimum-models` is `0`. Remediate zero coverage by broadening `paths`, removing an over-broad `exclude`, or declaring runtime/deployment aliases in `models.include` or `models`.

Set `minimum-models: 1` (or a higher expected floor) to fail when discovery and explicit declarations fall below that count. The action still writes `models-found: 0` and all other outputs before failing. The input accepts only non-negative safe integers; `0` disables the minimum, not the warning.

## Lifecycle waivers

Use a root `models.ignore` file for temporary exceptions:

```text
# provider/model | YYYY-MM-DD | reason
openai/gpt-4-turbo | 2026-12-31 | Legacy compatibility fixture; tracked in UT-431
```

Waivers are intentionally not silent ignores:

- Every matching model is still sent to the lifecycle API and included in annotations, the job summary, and `results-json`.
- A valid waiver exempts the model from `fail-on` and `unknown-policy`, but never from `api-error-policy` or a degraded response.
- The reason and expiry are shown in the audit. The expiry date remains valid through that UTC date; expired entries fail before network requests begin.
- Entries must be exact provider-qualified model keys. Regexes and wildcards are rejected to prevent broad accidental suppression.
- Unused entries produce warnings and appear in an **Unused waivers** summary section.

Both files are optional. Override their locations with `include-file` and `ignore-file`, or pass an empty value to disable one.

## Inputs

| Input | Default | Purpose |
|---|---:|---|
| `paths` | `.` | Comma/newline separated files or directories under the repository root |
| `exclude` | empty | Extra path globs to skip |
| `models` | empty | Explicit provider-qualified keys to check in addition to discovery and `models.include` |
| `include-file` | `models.include` | Repository-relative file containing model keys static discovery misses |
| `ignore-file` | `models.ignore` | Repository-relative file containing expiring, reasoned lifecycle waivers |
| `fail-on` | `replace` | `replace`, `review`, `replace,review` (or `both`), or `never` |
| `unknown-policy` | `warn` | `warn`, `error`, or `ignore` |
| `api-error-policy` | `error` | `error` or `warn` |
| `max-file-bytes` | `1048576` | Per-file scan limit |
| `max-models` | `100` | Maximum unique keys per run |
| `minimum-models` | `0` | Minimum unique keys required; `0` disables the minimum but not the zero-model warning |
| `issue-policy` | `off` | `off`, `replace`, or `review-and-replace` |
| `github-token` | empty | Token with `issues: write`, required only when issue creation is enabled |
| `issue-label` | `model-lifecycle` | Label applied to migration issues when it exists |
| `issue-assignees` | empty | Optional comma/newline separated GitHub owners |
| `api-base-url` | `https://api.usagetap.com` | Override for testing or self-hosted routing |

## Outputs

The action exposes:

- Decision counts: `models-found`, `replace-count`, `review-count`, `keep-count`, `unknown-count`, `degraded-count`, `error-count`, `waived-count`, and `unused-waiver-count`
- Scan counts: `files-scanned` and `files-skipped`
- Machine-readable decisions: `results-json`

A Markdown decision table is written to the job summary, including a link to the provider lifecycle evidence when the API supplies one. `results-json` contains lifecycle status, action, shutdown date, official replacement, computed recommendation, lifecycle source label/URL/checked date, recommendation source, degradation state, decision ID, validity time, and matching waiver metadata.

## Optional migration issues

Issue creation is off by default. To track `REPLACE` findings, opt in and grant only that workflow the required permission:

```yaml
permissions:
  contents: read
  issues: write

steps:
  - uses: actions/checkout@v7
  - uses: PredictabilityAtScale/usagetap-model-lifecycle-action@v1
    with:
      paths: .
      issue-policy: replace
      github-token: ${{ github.token }}
      issue-label: model-lifecycle
      issue-assignees: platform-team,ai-owners
```

`review-and-replace` tracks both `REVIEW` and `REPLACE`. Each issue contains the model key, source locations, lifecycle state and shutdown date, provider evidence and checked date, provider-designated replacement, computed/cross-provider recommendation, waiver state, and migration guidance.

The action deduplicates open issues with an exact hidden marker such as `<!-- usagetap-model-lifecycle:openai/gpt-4-turbo -->`. It creates one issue when none exists and updates the existing issue only when the UsageTap decision ID changes. API errors and degraded responses never create migration issues because they are service-health findings, not lifecycle facts. The action also never auto-closes an issue when a model disappears from a scan; path, configuration, or scanner changes can cause disappearance.

## Operating scheduled findings

Assign a team to own this workflow and route scheduled-run failures to that team through your normal GitHub Actions notification or incident-routing setup. A scheduled failure does not appear on a pull request, so it needs an explicit operational owner.

When a scheduled run finds a migration:

1. Open or update the tracked migration issue.
2. Verify the provider evidence.
3. Test the provider-designated replacement against representative requests.
4. Evaluate computed or cross-provider recommendations separately.
5. Use a reasoned, expiring waiver only when migration cannot complete before the enforcement date.

## Privacy and network access

With the default `api-base-url`, each unique normalized model key is sent in an HTTPS request to `api.usagetap.com`. Like other HTTP services, the endpoint can receive ordinary connection metadata such as IP address, timestamp, request path, and User-Agent. Do not place secrets or personal data in explicit model identifiers.

Usage of the hosted endpoint is governed by the [UsageTap Privacy Policy](https://usagetap.com/privacy) and [Terms of Service](https://usagetap.com/terms). If you override `api-base-url`, the operator of that endpoint controls its data practices.

## Local tests

```bash
npm test
```

The action uses GitHub's Node 24 runtime and Node built-ins only, so there is no dependency bundle to audit or update. Tests include scanner formats, adversarial input, path exclusions, API schema validation and retries, policy handling, annotations, summaries, and outputs.

To exercise the checked-out action against the live public endpoint after the corresponding UsageTap API release, push a branch and manually run the **Test action** workflow. Its `live-action-smoke` job uses `uses: ./` and asserts that the known source-backed transition includes both a provider evidence URL and checked date in `results-json`.

## Support and security

- Use [GitHub Issues](https://github.com/PredictabilityAtScale/usagetap-model-lifecycle-action/issues) for reproducible bugs and feature requests.
- Follow [SECURITY.md](SECURITY.md) for private vulnerability reporting.
- Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The action source code and documentation are licensed under the [MIT License](LICENSE). UsageTap names and logos are trademarks of Predictability at Scale Inc; the MIT License does not grant permission to imply endorsement.
