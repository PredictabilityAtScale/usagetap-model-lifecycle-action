# UsageTap Model Lifecycle Check

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

For production, pin this action and `actions/checkout` to verified full commit SHAs. Moving major tags such as `@v1` are convenient, but a full SHA is the immutable option.

See [`examples/model-lifecycle.yml`](examples/model-lifecycle.yml) for a fuller copyable workflow.

## What the scanner recognizes

- Provider-qualified keys such as `openai/gpt-4-turbo`, `anthropic/claude-3-5-sonnet-20241022`, and `google/gemini-2.5-pro`, including unfamiliar model-family names that should be audited as unknown
- Quoted OpenAI-family, Claude-family, and Gemini-family model IDs in JS/TS, Python, JSON, YAML, TOML, environment files, and other common configuration/code formats
- Unquoted model assignments commonly used in environment, YAML, and TOML files, such as `OPENAI_MODEL=gpt-4o` and `model: claude-sonnet-4-6`
- AWS Bedrock Anthropic IDs such as `anthropic.claude-...-v2:0`, normalized to the underlying Anthropic key
- Vertex publisher paths such as `publishers/google/models/gemini-...`
- Explicit keys supplied through `models.include` or the `models` input

The scanner skips common dependency/build directories, binary files, Markdown, lockfiles, and files larger than 1 MiB by default. `exclude` supports `*`, `?`, and `**` globstars using repository-relative `/`-separated paths.

## Important limitation

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

Keep explicit declarations under review: the action audits the provider/model key you supply but cannot prove that an arbitrary deployment alias still points to that model.

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
| `api-base-url` | `https://api.usagetap.com` | Override for testing or self-hosted routing |

## Outputs

The action exposes:

- Decision counts: `models-found`, `replace-count`, `review-count`, `keep-count`, `unknown-count`, `degraded-count`, `error-count`, `waived-count`, and `unused-waiver-count`
- Scan counts: `files-scanned` and `files-skipped`
- Machine-readable decisions: `results-json`

A Markdown decision table is written to the job summary, including a link to the provider lifecycle evidence when the API supplies one. `results-json` contains lifecycle status, action, shutdown date, official replacement, computed recommendation, lifecycle source label/URL/checked date, recommendation source, degradation state, decision ID, validity time, and matching waiver metadata.

## Privacy and network access

With the default `api-base-url`, each unique normalized model key is sent in an HTTPS request to `api.usagetap.com`. Like other HTTP services, the endpoint can receive ordinary connection metadata such as IP address, timestamp, request path, and User-Agent. Do not place secrets or personal data in explicit model identifiers.

Usage of the hosted endpoint is governed by the [UsageTap Privacy Policy](https://usagetap.com/privacy) and [Terms of Service](https://usagetap.com/terms). If you override `api-base-url`, the operator of that endpoint controls its data practices.

## Local tests

```bash
npm test
```

The action uses GitHub's Node 24 runtime and Node built-ins only, so there is no dependency bundle to audit or update. Tests include scanner formats, adversarial input, path exclusions, API schema validation and retries, policy handling, annotations, summaries, and outputs.

To exercise the checked-out action against the live public endpoint, push a branch and manually run the **Test action** workflow. Its `live-action-smoke` job uses `uses: ./`, audits the example model, and verifies that discovery produced at least one result without failing on the model's lifecycle decision.

## Support and security

- Use [GitHub Issues](https://github.com/PredictabilityAtScale/usagetap-model-lifecycle-action/issues) for reproducible bugs and feature requests.
- Follow [SECURITY.md](SECURITY.md) for private vulnerability reporting.
- Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The action source code and documentation are licensed under the [MIT License](LICENSE). UsageTap names and logos are trademarks of Predictability at Scale Inc; the MIT License does not grant permission to imply endorsement.

## Before publishing

1. Confirm the GitHub test matrix passes on Ubuntu, Windows, and macOS.
2. Add integration fixtures for every provider/model format you officially support.
3. Enable GitHub private vulnerability reporting and confirm the linked privacy policy, terms, support channel, and security-reporting channel are current.
4. Tag an immutable release such as `v1.0.0`, then move a `v1` major tag to that commit.
5. Publish the action in GitHub Marketplace after validating `action.yml` and the README.
