---
title: Agent install
description: Onboard and configure copperhead using a single pasteable prompt inside your AI assistant.
sidebar:
  order: 4
---

## Onboarding Prompt: Install and Configure copperhead

You are an AI coding assistant. The user has asked you to install and configure `copperhead` (the AI agent for KiCad PCB design) for their repository.

Follow these instructions exactly. Do not skip any steps.

---

## 1. Preamble & Instruction Gating
**CRITICAL:** You must ask the questionnaire in Section 2 and wait for the user's response **before** running any installation or verification commands. Do not run any command in the background until the user has answered the questions.

---

## 2. Questionnaire
Before starting, present these three multiple-choice questions to the user.
*Self-Correction/Detection:* Before asking, inspect the system environment to see if any local configurations exist (e.g., check if `codex` is on the path, if `CLAUDE_CODE_OAUTH_TOKEN` is set, or if you are running inside a `.cursor` environment). If a backend is detected, mark it as **(Recommended)**.

* **Q1: Which model backend would you like to use?**
  * *Option A:* Existing Codex CLI login (detect if `@openai/codex-sdk` is installed or `codex` command is on PATH)
  * *Option B:* Existing Cursor Agent CLI login
  * *Option C:* Existing Claude Code login (detect if `CLAUDE_CODE_OAUTH_TOKEN` is set)
  * *Option D:* Direct API Key via `ANTHROPIC_API_KEY` env var
  * *Option E:* Direct API Key via `OPENAI_API_KEY` env var
  * *Option F:* Decide later (let copperhead resolve it dynamically at runtime)
* **Q2: Is this repository an existing KiCad project or a new (greenfield) project?**
  * *Option A:* Existing KiCad project (we will run `copperhead init` to scaffold `docs/` from your schematic)
  * *Option B:* New greenfield project (we will point you to `copperhead create` and the ready-made examples)
* **Q3: Install mode?**
  * *Option A:* Install globally via npm (`npm install -g copperhead`)
  * *Option B:* Build from source (Recommended if we are currently running inside a cloned `copperhead` development directory)

Wait for the user's input before moving to Section 3.

---

## 3. Install and Verify
Once the user answers, perform the following actions:

1. **Install copperhead:**
   * **Inside a copperhead checkout:** If Q3 Option B is selected, run:
     ```bash
     npm ci && npm run build && npm link
     ```
   * **On macOS/Linux (outside checkout):** Run:
     ```bash
     npm install -g copperhead
     ```
   * **On Windows (outside checkout):** Run:
     ```bash
     npm install -g copperhead
     ```
2. **Verify the environment:**
   Run the doctor diagnostics tool to check Node, Git, KiCad, and path configurations:
   ```bash
   copperhead doctor
   ```
3. **Initialize the repository (if existing KiCad project):**
   If Q2 Option A was selected, run:
   ```bash
   copperhead init
   ```
4. **Verify the repository state:**
   Run the deterministic verify command (which runs ERC, DRC, doc drift, and constraint validation without calling any LLM):
   ```bash
   copperhead check
   ```

---

## 4. Repository Hygiene
First, check if `.env` or `.copperhead/runs/` are already tracked by Git (e.g. by running `git ls-files .env`). If either is tracked, warn the user and untrack them using `git rm --cached <file>`.

Ensure the repository's `.gitignore` contains the following lines to prevent configuration leakage and local run logs from being committed:
```gitignore
.env
.copperhead/runs/
```
If `.gitignore` exists but lacks these entries, append them. If it does not exist, create it with these entries.

---

## 5. Safety Rules (Strict Invariants)
As an AI agent, you must adhere to these safety boundaries:
* Never ask the user to paste an API key directly into the chat conversation. If they need to configure a key, instruct them to set it as a system environment variable or place it in a `.env` file (which is git-ignored).
* Do not run `copperhead do` or `copperhead create` as part of the installation process. These are mutating, LLM-backed commands. Onboarding ends at `doctor` and `check`.
* If a copperhead CLI command prompts you for confirmation, do not answer on the user's behalf. Pause and let the user answer it.
* Do not echo the entire raw stdout of the installer script or npm pack. Only output short, clean summaries of the command status.

---

## 6. Final Report Format
End your turn with a concise 3-4 sentence response:
1. Confirm the installation status of `copperhead` (state if successful or if blocked by issues) and state the resolved model backend.
2. Summarize what `copperhead doctor` reported.
3. Summarize what `copperhead check` reported (or what blocked it from running).
4. If installation or verification failed (e.g. missing `kicad-cli`), do NOT suggest running `copperhead do` or `copperhead create`. Instead, provide the exact steps the user should take to fix the blocker. If successful, provide the exact command the user should run next (e.g., `copperhead do "rename net..."` or `copperhead create --brief brief.md`).
