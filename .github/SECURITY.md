# Security Policy

## Supported versions

copperhead is pre-1.0 and moves fast. Only the latest published release on npm receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.7.x   | Yes       |
| < 0.7   | No        |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through [GitHub's private vulnerability reporting](https://github.com/copperheadhq/copperhead/security/advisories/new). That opens a draft advisory only the maintainers and you can see.

If you cannot use GitHub advisories, email <animeshchouhan@outlook.com> with `[copperhead security]` in the subject.

Please include:

- The version or commit you tested.
- What an attacker gains (read a file outside the repo, exfiltrate a key, run a command, and so on).
- Reproduction steps, ideally a minimal KiCad project or prompt that triggers it.
- Any logs, with credentials removed.

## What to expect

- **Acknowledgement** within 3 business days.
- **Initial assessment** (confirmed / not a vulnerability / need more information) within 10 business days.
- **Fix and disclosure**: we aim to ship a patched release within 90 days of confirmation, and we publish an advisory when the fix is out. Tell us if you have a disclosure deadline and we will work to it.
- **Credit** in the advisory unless you prefer to stay anonymous.

We do not run a paid bug bounty.

## Scope

In scope: this repository's source, its published npm package, and its GitHub Actions workflows.

Out of scope: vulnerabilities in KiCad or `kicad-cli`, in the model providers (OpenAI, Anthropic, Codex CLI, Claude Code), or in third-party dependencies. Report those upstream. If a dependency issue is reachable through copperhead in a way the upstream advisory does not cover, we do want to hear about it.

## Things that are by design, not vulnerabilities

copperhead is an agent that edits files and runs subprocesses, so some behavior that looks alarming is intended:

- **It edits files in the repository you point it at.** File tools are sandboxed to the repo root. A path escaping that root is a vulnerability; edits inside it are the product.
- **It runs `kicad-cli` as a subprocess.** Arbitrary command execution beyond that is a vulnerability.
- **It sends the contents of files it reads to the configured model provider.** Do not run it on a repository holding secrets you are unwilling to share with that provider.
- **`copperhead check` never calls an LLM and never touches the network.** If you observe it doing either, that is a vulnerability, and a serious one.

Also treated as vulnerabilities: an API key appearing unredacted in a transcript under `.copperhead/runs/`, in a run summary, or in terminal output; and a mutation being reported as complete without ERC (and DRC, when the board changed) having passed.

## Handling secrets

Model API keys belong in environment variables or `.env`, which is gitignored. Transcripts and summaries redact key-shaped strings when they are written. If you find a path that writes a key to disk or to stdout in the clear, report it privately using the process above.
