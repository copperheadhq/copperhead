# Contributing to copperhead

Thanks for your interest in contributing. This document covers the practical setup and the one piece of paperwork we require.

By taking part you agree to our [Code of Conduct](.github/CODE_OF_CONDUCT.md). Found a security problem? Do not open an issue: follow the [security policy](.github/SECURITY.md) instead.

## Development setup

Requirements: Node.js >= 20 and, for the KiCad integration paths, a local `kicad-cli` on your PATH. The Nix development shell supplies Node.js, git, OpenSpec, and KiCad on Linux. On macOS, install KiCad separately:

```bash
nix develop              # optional: enter the pinned tool environment
npm install
npm run dev -- --help    # run the CLI from source via tsx
npm run typecheck        # tsc, no emit
npm test                 # vitest, offline suite
npm run build            # compile to dist/
nix flake check          # build and evaluate the Nix package
```

The offline test suite runs without any credentials. Integration tests that call an LLM are skipped automatically unless an API key environment variable is present, so `npm test` is safe to run anywhere.

## Manual testing

For exercising the CLI by hand against a real repository, see [manual-tests/README.md](manual-tests/README.md). It provides two sandbox variants: `create` (full pipeline from a product brief) and `edit` (`init`, `check`, and the `do` loop on an existing KiCad project).

Any change to CLI behavior, the agent loop, providers, or the KiCad layer must be exercised by hand in this sandbox before you open a PR, and the commands you ran plus their outcome go in the PR's manual-test log (see below).

## Making changes

- This repo uses spec-driven development with OpenSpec. Behavior changes should stay consistent with `openspec/specs/SPEC.md`; if your change alters spec-level behavior, update the spec alongside the code.
- Keep pull requests focused: one logical change per PR.
- Add or update tests for anything you change. The offline suite must stay green.

## Opening a pull request

Opening a PR fills the description with [our template](.github/pull_request_template.md). Keep its sections and fill them in:

- **What / Why**: what the change does and the gap it closes.
- **Design / Spec**: for non-trivial or spec-level changes, how it works and which acceptance criteria or OpenSpec artifacts move with it.
- **Testing**: the automated status table (typecheck, build, `npm test`, live-LLM if keyed) with real results, plus the required manual-test log. Report actual outcomes, never assumed ones. Write "n/a" with a reason only for changes that cannot be exercised at runtime, such as docs-only or CI-config-only PRs.
- **Invariant checklist**: tick the invariants your change is responsible for and mark the rest n/a. A reviewer verifies each.

A `PR lint` check runs on every PR and fails if a required section or the invariant checklist is missing or empty, so do not delete them. The lint verifies presence, not truth; a reviewer still confirms the manual log is real and the ticked invariants hold. Keep prose em-dash-free (use colons, commas, or parentheses).

## Contributor License Agreement

Before we can merge your first pull request, you must sign our [Contributor License Agreement](.github/cla/CLA.md) (CLA). This is automated: when you open a PR, the CLA bot checks whether you have signed and, if not, posts instructions. Signing is a one-time comment on the PR; it covers all your future contributions.

Why a CLA and not just the Apache-2.0 inbound license: the CLA lets Chouhan Industries relicense the combined work in the future (for example, offering commercial licenses) while the project itself stays Apache-2.0. Your contributions remain yours; you grant us a broad license to them, as described in the agreement.

## License

copperhead is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contributions will be licensed under its terms, in addition to the grants in the CLA.
