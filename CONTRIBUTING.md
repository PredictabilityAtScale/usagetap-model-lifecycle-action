# Contributing

Thank you for helping improve model discovery and lifecycle auditing.

## Before opening a pull request

1. Open an issue first for behavior changes that alter which model keys are detected or how policy decisions fail CI.
2. Keep discovery separate from migration decisions. Scanner changes should identify model keys; UsageTap API decisions determine lifecycle action.
3. Add focused tests for every new provider format, normalization rule, policy branch, or API response shape.
4. Include adversarial cases for regex or parser changes because pull-request content is untrusted input.
5. Run `npm test` and confirm `git diff --check` passes.

Do not include credentials, private repository content, production API responses containing customer information, or third-party code you do not have the right to contribute.

## Licensing

By submitting a contribution, you agree that it is licensed under the MIT License applicable to this repository. You represent that you have the right to submit the contribution under those terms.

## Security reports

Do not open a public pull request or issue for an undisclosed vulnerability. Follow [SECURITY.md](SECURITY.md).
