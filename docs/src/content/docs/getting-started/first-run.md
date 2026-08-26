---
title: Your first run
description: A guided first hour with copperhead on a board you already have, including what it looks like when something goes wrong.
sidebar:
  order: 3
---

The [Quickstart](/getting-started/quickstart/) lists the commands. This page walks the path, in order, and spends most of its length on the parts where people get stuck.

Budget about twenty minutes. If your baseline is clean and verification passes, you end with one small, ERC-verified, committed change. If it does not, you end with a rolled-back tree and a written reason, which is the other half of what you are here to see. Either way you will have enough of a feel for the loop to decide whether you trust it with something bigger.

## Which path are you on?

copperhead has two, and confusing them is the fastest way to waste an hour. Everyone does the same Install below; after that the two diverge.

| | **You have a KiCad board already** | **You are starting from nothing** |
| --- | --- | --- |
| Command | `copperhead do "<request>"` | `copperhead create --brief brief.md` |
| Input | a change request in plain English | a product brief, in markdown |
| Takes | minutes | hours: eight stages |
| Follow | Steps 1 to 5 below, in order | Install, Step 1, Step 2, then [Starting from nothing](#starting-from-nothing) |

The interactive shell (`copperhead` with no arguments) is the conversational form of `do`, so it belongs to the left column. Open it on a repo with no schematic and every command reports `null`, because there is no design to read yet. Build the board with `create` first, then the shell becomes useful.

:::note[Shell syntax on this page]
Commands are written for bash (macOS, Linux, Git Bash). Windows `cmd` differs in three ways that bite: `export` is `set`, `cp` is `copy`, and `&&` skips the rest of the line when the first command fails. Every block that needs one carries its `cmd` version underneath, so you never have to translate.
:::

## Install

:::tip[Skip all of this if you use an AI coding assistant]
Working inside Claude Code, Cursor, or Codex? Paste this and it does the whole install for you, then reports what it found:

```text
Install copperhead for this repo using https://raw.githubusercontent.com/chouhanindustries/copperhead/main/agent-install-prompt.md
```

Then jump to [Which path are you on?](#which-path-are-you-on) above.
:::

Doing it by hand: four things. copperhead checks three of them for you in Step 1, so install first and let it grade your work.

### 1. Node.js 20 or newer

```bash
node --version
```

Nothing, or a number below 20? Install it from [nodejs.org](https://nodejs.org/).

### 2. KiCad 8 or newer

Install the desktop app; copperhead drives the `kicad-cli` tool that ships inside it.

The [download page](https://www.kicad.org/download/) makes you choose a platform and then a mirror, which is a lot of decisions for a file that is the same from every one of them. Any mirror works: take whichever is nearest you. These start the download for the current stable release directly:

| Platform | Direct download |
| --- | --- |
| Windows x64 | [kicad-10.0.5-x86_64.exe](https://github.com/KiCad/kicad-source-mirror/releases/download/10.0.5/kicad-10.0.5-x86_64.exe) (Asia: [Tsinghua](https://mirror.tuna.tsinghua.edu.cn/kicad/windows/stable/kicad-10.0.5-x86_64.exe), Europe: [CERN](https://kicad-downloads.s3.cern.ch/windows/stable/kicad-10.0.5-x86_64.exe)) |
| macOS | [kicad.org/download/macos](https://www.kicad.org/download/macos/) |
| Linux | [kicad.org/download](https://www.kicad.org/download/) (use your distribution's package) |

It is roughly a 1 GB download and the installer takes a few minutes, so start it before you read on. Any KiCad 8 or newer works; the links above are simply the current release at the time of writing.

:::caution[KiCad does not put itself on your PATH]
This is the single most common setup failure, and the error you get (`kicad-cli not found on PATH`) does not say that KiCad is installed fine and merely invisible. It usually is.

**Windows**: the installer does not touch PATH at all. Paste this into PowerShell. It finds the install itself, so you do not need to know your KiCad version, and the guard keeps a second run from appending a duplicate:

```powershell
$bin = (Get-ChildItem "C:\Program Files\KiCad" -Filter kicad-cli.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1).Directory.FullName
if (-not $bin) { "kicad-cli.exe not found: is KiCad installed?" }
elseif ($env:Path -like "*KiCad*") { "already on PATH" }
else {
  [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$bin", "User")
  "added $bin"
}
```

It prints what it did. Setting the path by hand instead? The directory is `C:\Program Files\KiCad\<VERSION>\bin`, where `<VERSION>` is the release you installed (`8.0`, `9.0`, `10.0`, ...), not the full version number.

One caveat: that call rewrites your user `Path` as a plain string, so any `%USERPROFILE%`-style entries already in it stop expanding. If yours contains those, use the GUI instead (search "Edit environment variables for your account"), which preserves them.

**macOS**: the binary lives inside the app bundle. Append it to your shell profile rather than exporting it into one session, or the next step throws the fix away:

```bash
echo 'export PATH="/Applications/KiCad/KiCad.app/Contents/MacOS:$PATH"' >> ~/.zshrc
```

Then **open a new terminal.** A PATH change never reaches a window that was already open, so re-running `doctor` in the same one will fail again and send you chasing a problem you have already fixed.

Installed somewhere other than `C:\Program Files`? Widen the search and use the directory it reports:

```powershell
Get-ChildItem C:\ -Filter kicad-cli.exe -Recurse -ErrorAction SilentlyContinue | Select FullName
```
:::

### 3. git

```bash
git --version
```

### 4. copperhead

```bash
npm install -g copperhead
copperhead --version
```

## Before you start

You need a KiCad project in a git repository. Not a copy on the desktop: an actual repo, because copperhead snapshots with git before it edits and rolls back to that snapshot when verification fails. No repo, no safety net, and the preflight will refuse to run.

**Commit everything before `do` or the interactive shell.** Those two refuse to start on a tree with uncommitted changes, because the snapshot-and-rollback contract cannot tell your unsaved work from its own. (`create` deliberately allows a dirty tree so its stages can build on each other, and `init`, `check`, `doctor`, and `sync` never inspect it.) A fresh `git init` alone is not enough either: the first commit has to exist.

```bash
cd my-board
git init
printf '.env\n.copperhead/runs/\n' >> .gitignore
git add -A
git status                       # read this list before committing
git commit -m "baseline before copperhead"
```

The same thing in Windows `cmd`:

```text
cd my-board
git init
(echo .env& echo .copperhead/runs/) >> .gitignore
git add -A
git status
git commit -m "baseline before copperhead"
```

Read that `git status` output rather than skipping past it. `git add -A` stages everything it finds, and a baseline commit is a bad place to discover you have captured a `.env`, a vendor archive, or someone's local scratch files.

Working on something you cannot commit yet? `do` and the interactive shell take `--allow-dirty`, which snapshots through `git stash create` instead. No other command accepts the flag.

Work on a branch for the first run. Nothing here is destructive, but a branch makes "throw it all away" a one-liner:

```bash
git switch -c copperhead-trial
```

## Step 1: Ask what is missing

Run this before anything else. It calls no model and touches no network; it just tells you whether the machine is ready.

```bash
copperhead doctor
```

On a machine that is not ready yet:

```text
  [ok]   node      v24.16.0 (>= 20)
  [ok]   kicad-cli 8.0.9
  [ok]   git       2.54.0.windows.1
  [FAIL] provider  no model configured
         hint: pass --model, set COPPERHEAD_MODEL, or export an API key; see
               https://docs.copperhead.sh/reference/configuration/
  [info] project   no .copperhead/config.json (run `copperhead init` to
                   scaffold)
not ready: fix the [FAIL] items above
```

`[info]` lines are notes, not problems: the missing `config.json` on that last line is exactly what Step 3 creates. Only `[FAIL]` blocks you. Exit code is 0 when ready, 1 when not, so this is safe to put in a setup script.

If `kicad-cli` fails here, go back to the PATH note in Install, and remember that the fix only takes effect in a new terminal.

## Step 2: Choose one model backend

You need to name exactly one. What copperhead refuses is not two credentials existing, it is having to guess between them: with `COPPERHEAD_MODEL` (or `--model`) set, extra credentials in your environment are simply ignored.

If you already use Codex CLI, Claude Code, or Cursor, reuse that login and skip API keys entirely:

```bash
export COPPERHEAD_MODEL=codex          # or: claude-code, cursor
```

Windows `cmd`:

```text
set "COPPERHEAD_MODEL=codex"
```

Each of those needs its own CLI authenticated first:

| Backend | Authenticate with | Check it |
| --- | --- | --- |
| `codex` | the Codex CLI's own ChatGPT login | `codex login status` |
| `cursor` | `agent login` | `agent status` |
| `claude-code` | see the token step below | `copperhead doctor` |

For Claude Code you also need its token. Generate one:

```bash
claude setup-token
```

Then set it, together with the model:

```bash
export CLAUDE_CODE_OAUTH_TOKEN="<the token it printed>"
export COPPERHEAD_MODEL=claude-code
```

On Windows `cmd`, the same two:

```text
set "CLAUDE_CODE_OAUTH_TOKEN=<the token it printed>"
set "COPPERHEAD_MODEL=claude-code"
```

Otherwise supply a single API key:

```bash
export ANTHROPIC_API_KEY=...           # or OPENAI_API_KEY
```

Windows `cmd`:

```text
set "ANTHROPIC_API_KEY=..."
```

:::caution[Two ways a perfectly good token still fails]
**A line break became a space.** Long tokens wrap when copied out of a terminal, and the wrap can paste back as a space in the middle. The result is a 401 that reads as though the credential were revoked:

```text
run failed: provider error: Failed to authenticate. API Error: 401 OAuth access token is invalid.
```

Check the length rather than eyeballing it: a real token is roughly 100 characters or more, with no spaces anywhere.

```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN.Length
```

From Windows `cmd`, where that syntax does not exist:

```text
powershell -c "$env:CLAUDE_CODE_OAUTH_TOKEN.Length"
```

From bash:

```bash
echo ${#CLAUDE_CODE_OAUTH_TOKEN}
```

The quotes in `set "VAR=value"` and `export VAR="value"` keep the shell from splitting the assignment at that space, so the whole broken value is stored rather than a truncated one. They cannot repair the token itself. A token with a space inside it is corrupt either way: copy it again, or generate a fresh one.

**It only lived in one window.** `set` and `export` last for that terminal session only. Open a new window and the credential is gone, and `doctor` reports no model configured again. Use `setx` on Windows, or your shell profile on macOS and Linux, to make it stick. `setx` writes the value for *future* processes only, so close the terminal and open a new one before re-running `doctor`, exactly as with the PATH fix.
:::

:::danger[Two keys in your environment is a hard stop]
If you have both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` exported (common on a developer machine), copperhead refuses to guess:

```text
  [FAIL] provider  ambiguous: multiple credentials, no model selected
         hint: 2 credentials found (OPENAI_API_KEY, ANTHROPIC_API_KEY) and no
               model was selected; pass --model, set COPPERHEAD_MODEL, or set
               "model" in .copperhead/config.json.
```

This is deliberate. Silently picking one could send your design to a provider you did not intend, and bill you for it. Name the model and the error goes away:

```bash
export COPPERHEAD_MODEL=claude
```
:::

Re-run `copperhead doctor` until it says `ready`:

```text
  [ok]   node      v24.16.0 (>= 20)
  [ok]   kicad-cli 8.0.9
  [ok]   git       2.54.0.windows.1
  [ok]   provider  gpt-5 -> openai: OPENAI_API_KEY set
  [info] project   no .copperhead/config.json (run `copperhead init` to
                   scaffold)
ready
```

Your key is read from the environment only. It is never written into `.copperhead/config.json`, and it is redacted from run transcripts as they are written.

## Step 3: Adopt the board

```bash
copperhead init
```

This reads your schematic and scaffolds `docs/`: `SPEC.md`, `SUBSYSTEMS.md`, `BOM.md`, `PINOUT.md`, `LAYOUT.md`: plus `.copperhead/config.json` pointing at your schematic and board. It also installs a `pre-commit` hook that runs `copperhead check`, and it will not clobber a hook you already have.

`init` is idempotent. Re-run it freely: it reports `unchanged` for files it already wrote, and it **refuses** to overwrite a generated doc you have since hand-edited, exiting non-zero and naming the files it skipped. Pass `--force` only when you genuinely want them regenerated.

Read what it produced before continuing. The scaffolded docs are the agent's memory: every later run reads them first, so a wrong value here becomes a wrong assumption in every change after it. This is the highest-leverage ten minutes in the whole process.

## Step 4: Establish a baseline

```bash
copperhead check          # alias: copperhead verify
```

This runs ERC, DRC, doc-drift detection, constraint checks, and spec validation. It makes no LLM calls and opens no network connections, by contract: which is why it is safe in CI and in that pre-commit hook.

:::caution[A green check on an un-adopted repo means nothing]
If `init` has not run, or `config.json` does not point at your files, `check` skips everything and still exits 0:

```text
ERC skipped (no schematic configured; run copperhead init)
DRC skipped (no board configured)
```

That is a pass over an empty set, not a clean board. Read the lines, not the exit code: if you see `skipped`, fix the config before you trust anything downstream.
:::

Expect real findings on a real board. Fix them, or note them, before the agent starts making changes: otherwise you cannot tell its mistakes from your pre-existing ones.

## Step 5: One small change

Pick something narrow and easy to eyeball. A rename is ideal for a first run: unambiguous, and wrong is obvious.

See the proposal without writing anything:

```bash
copperhead do "rename net KEY_DAH to KEY_DASH" --dry-run
```

Then run it for real, pausing for your approval once the plan validates:

```bash
copperhead do "rename net KEY_DAH to KEY_DASH" --interactive
```

What happens, in order:

1. **Propose.** The agent writes an OpenSpec change proposal: why, what changes, the task list. Until this validates, its edit tools do not exist. Not discouraged: absent from the tool list it is given.
2. **Edit.** Anchored exact-match replacements in the `.kicad_sch` and in every doc that mentions the net.
3. **Verify.** ERC runs, and DRC too if the board changed. Failures come back to the agent as its own error report to repair.
4. **Commit.** One commit, with the verification result in the message, plus a line in `docs/CHANGELOG.md` and any real decision appended to `docs/DECISIONS.md`.

If verification cannot be made to pass, the run rolls back to the pre-run snapshot. On the normal path your tree is left exactly as it was. If the rollback itself fails, which git can do when it is in an odd state, the run says so explicitly and warns that the tree may be partial: read that line rather than assuming a clean revert, and check `git status` before rerunning.

## What a run costs

Worth calibrating before you reach for the big commands:

| Command | Typical shape |
|---|---|
| `check`, `doctor`, `export bom` | Seconds. No model, no network, no cost. |
| `do "<small change>"` | A handful of turns, a few minutes. |
| `create --brief brief.md` | Eight stages. Hours, not minutes. |

`create` is a full pipeline: spec, architecture, part selection, schematic, layout, outputs, firmware, dev plan. Individual stages can legitimately run over an hour. It is not hung; it prints a heartbeat every 30 seconds while a turn is in flight. Try it first on a small brief from [examples/simple](https://github.com/chouhanindustries/copperhead/tree/main/examples/simple).

### Starting from nothing

Steps 3 to 5 above adopt a board you already have. With no board, do Install, Step 1, and Step 2, then come straight here: an empty repo, a brief, and one command.

```bash
mkdir my-board
cd my-board
git init
cp ../copperhead/examples/simple/coin-cell-led-beacon.md brief.md
git add -A
git commit -m "brief"
copperhead create --brief brief.md
```

The same thing in Windows `cmd`:

```text
mkdir my-board
cd my-board
git init
copy ..\copperhead\examples\simple\coin-cell-led-beacon.md brief.md
git add -A
git commit -m "brief"
copperhead create --brief brief.md
```

:::caution[Run those one line at a time on `cmd`]
Do not join them with `&&`. If `mkdir my-board` fails because the directory already exists, `&&` skips the `cd` without stopping, and everything after it runs one level up: `git init` then turns that parent directory into a repository, which is a genuinely annoying thing to undo when the parent is somewhere like `Downloads`.

If it happens, nothing is lost. Delete the stray repository (`rmdir /s /q .git` in the parent, `rm -rf .git` on bash), check you are in the right directory with `cd`, and start the block again.
:::

Start from an example brief rather than your own. You are testing whether the pipeline runs on your machine, and a known-good input keeps a bad first result from being ambiguous. Each stage commits on its own, so an interrupted run resumes from the last finished one: re-running the same command picks up where it stopped.

When it finishes you have a schematic, and the interactive shell becomes useful: `copperhead` on its own, then `/status`, `/parts`, or a change request in plain English.

## When it goes wrong

| What you see | What it means | Fix |
|---|---|---|
| `kicad-cli not found on PATH` | KiCad is almost certainly installed, just invisible | Add its `bin` directory to `PATH`, then **open a new terminal** |
| `kicad-cli` still missing after the PATH fix | The change never reached this window | Close the terminal and open a new one |
| `ambiguous: 2 credentials found` | Two API keys exported, no model named | `export COPPERHEAD_MODEL=claude` |
| `no model configured` | No key and no saved login found | Export one key, or set `COPPERHEAD_MODEL` to a saved-login backend |
| `no model configured`, but you set one | `set` / `export` only covered the old window | Re-set it here, or persist it with `setx` / your shell profile |
| `401 OAuth access token is invalid` | Usually a space pasted into the token, not a revoked one | Check its length, re-set it quoted and unbroken |
| `Connection closed mid-response` | Transient network drop | Nothing: the pipeline diagnoses and retries the stage itself |
| Preflight refuses on a dirty tree | Uncommitted changes would be caught in the snapshot | Commit or stash first, or pass `--allow-dirty` (on `do` and the shell only) |
| `ERC skipped (no schematic configured)` | `init` has not run, or config points nowhere | `copperhead init` |
| `run failed: ... working tree restored` | Verification never passed; changes were rolled back | See the preserved-work note below |
| `session/usage limit reached` | Saved-login quota, not a bug | Wait for the stated reset, re-run the same command |

Two things worth knowing about that last column.

**Failed work is normally not destroyed.** A failed run tries to preserve everything it touched as a named git stash entry before rolling back, and prints the stash id and the recovery command when it succeeds. Both steps are best-effort: if no preservation line appears, or the run reports a failed rollback, inspect `git status` and `git stash list` yourself rather than assuming either happened.

```bash
git stash apply     # get the failed run's work back
git stash drop      # or discard it
```

**A rate-limited saved-login run resumes cheaply.** Every completed turn is cached on disk, so re-running the same command after the reset replays that work at roughly zero tokens and picks up where it stopped.

## What it will refuse to do

For a first run, the refusals matter more than the features. copperhead is built to fail closed:

- **No edit without a validated proposal.** The edit tools are structurally withheld, not merely discouraged.
- **No "done" without ERC.** And DRC too, whenever the board changed.
- **No edit that breaks a KiCad file.** Every text edit to a schematic or board is probed for loadability, and reverted if it would make the file unopenable.
- **No hand-edits to an engine-drafted sheet.** Sheets drafted from an intent file are regenerated wholesale; direct geometry edits are refused rather than silently lost on the next re-draft.
- **No silent resolution of a requirement violation.** `sync` will fix docs that drifted from the as-built schematic, but a violated budget or constraint is reported for you to decide, never auto-resolved.
- **No LLM in `check`.** That command imports no provider at all, so it cannot make a network call.

## Next

- [Guardrails](/concepts/guardrails/): the two invariants, in depth
- [The agent loop](/concepts/agent-loop/): what one run actually does, turn by turn
- [Docs as memory](/concepts/docs-as-memory/): what lives in `docs/` and why it matters
- [Design from a brief](/workflows/create-from-brief/): when you are starting from nothing
- [CLI reference](/reference/cli/): every command and flag
