# Distribution plan

## Recommended home

Create one dedicated public repository:

`github.com/PredictabilityAtScale/usagetap-model-lifecycle-action`

Keep the root `action.yml`, implementation, tests, license, and documentation in that repository. A separate repository gives the action an independent release history and is the structure GitHub expects for Marketplace publication.

The action is usable as soon as the repository is public; Marketplace is a discovery channel, not a technical requirement.

```yaml
- uses: PredictabilityAtScale/usagetap-model-lifecycle-action@v1
```

Security-sensitive teams can pin the immutable commit SHA instead:

```yaml
- uses: PredictabilityAtScale/usagetap-model-lifecycle-action@FULL_COMMIT_SHA # v1.0.0
```

## Release model

Publish both an immutable semantic-version tag and a convenient major tag:

- `v1.0.0` points permanently to the release commit.
- `v1` moves to the latest backward-compatible v1 release.
- Breaking input/output or behavior changes ship as `v2.0.0` and `v2`.

For every release:

1. Run the repository test matrix.
2. Test the action in a separate fixture repository against the production UsageTap endpoint.
3. Confirm `action.yml`, annotations, job summary, outputs, retries, and failure policies.
4. Create the immutable version tag and GitHub Release.
5. Move the major tag only after the release is verified.
6. Include the exact commit SHA in the release notes for users who pin dependencies.

## GitHub Marketplace

After the first GitHub Release, select **Publish this Action to the GitHub Marketplace**. GitHub requires a public repository, one root `action.yml` or `action.yaml`, and a unique action name. The organization owner must accept the Marketplace Developer Agreement and publication requires two-factor authentication.

Suggested categories:

- Primary: Continuous integration
- Secondary: Utilities

Suggested listing copy:

> Find OpenAI, Anthropic, and Google model keys in your repository. Fail CI before a deprecated or retired model reaches production, with source-backed replacements from UsageTap.

## Other distribution surfaces

- Add a one-click workflow snippet to the UsageTap lifecycle page and API docs.
- Publish a reusable workflow example for organizations that want centralized policy.
- Keep the core scanner separable so it can later become an npm CLI for GitLab, CircleCI, Buildkite, and local pre-commit checks.
- Add release notes and retirement-event examples to the repository Discussions or changelog.

Do not ship auto-editing in v1. The first release should detect, explain, annotate, and fail according to policy; migration pull requests can be a later, explicitly opted-in action.
