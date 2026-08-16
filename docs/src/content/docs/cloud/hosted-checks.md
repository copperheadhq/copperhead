---
title: Hosted check runs
description: Run copperhead check from the browser, watch it stream, cancel it, and read verdicts, limits, and what a run records.
sidebar:
  order: 4
---

`copperhead check` runs ERC, DRC, documentation drift, and spec validation against a repository. It uses no language model and makes no network calls, which is a contract: it is the same deterministic check you run in CI, and it is what the console runs hosted today. See [Verify and sync](/workflows/verify-and-sync/) for what the check itself does.

## Start a run

1. On **Projects** or the **Overview**, find the connected project and choose **Run check**.
2. The console pins the run to the current head of the repository's default branch, queues it, and opens the run page.
3. A worker starts, clones the repository at that commit, runs the CLI, and streams the output back.

**Run check** is disabled, with the reason, on a project that is not connected to a repository. If a run cannot be started, the page you came from says why: the branch could not be found, GitHub could not be reached, the project is not connected, or the organization has reached its run limit.

## Watch a run

The run page (`/runs/<id>`) shows:

- the status pill: **Queued** (waiting for a worker), **Running**, then **Passed**, **Failed**, or **Cancelled**
- when it started, how long it ran, the exact commit it ran against, and the run id
- the live transcript: the CLI's own output as it happens, plus short notes from the worker (claimed, cloning, starting, finished)
- once finished, a one-line verdict and, under **Result**, the CLI's machine-readable result

Each run executes in a fresh container started for that run alone, so there is a short cold start; while queued the page says "Starting a worker. The first lines usually take under a minute." The stream reconnects on its own if the connection drops, and the page refreshes itself with the final state when the run finishes.

## Run history and the overview

- **Runs** lists every run in the organization, newest first: kind, project, commit, when it started, how long it took, and status, 25 per page. Each row opens the run.
- **Overview** summarises the organization: projects and how many are connected, runs in the last 30 days and how many are queued or running, the pass rate over finished runs, and what is active now; then each project with its latest run and a **Run check** control, and the eight most recent runs with a one-line verdict.

## Cancel a run

Open the run and choose **Cancel run**. A queued run is cancelled at once and no worker ever picks it up. A running run is asked to stop; the worker sees the request within a few seconds, stops the CLI, and records **Cancelled**. Once a run has finished, cancel does nothing.

## Verdicts

| Status | Meaning |
| --- | --- |
| Passed | ERC, DRC, and drift all clean: the CLI exited 0. |
| Failed, "The check reported findings." | The CLI ran and reported problems (exit 1). Read the transcript and the result. |
| Failed, "Could not run: ..." | The CLI did not reach a verdict: the repository could not be cloned, the run timed out, KiCad could not load a file. The reason is shown. |
| Failed, "The worker stopped responding and the run was reaped." | The worker died mid-run and the platform closed the run out. Run it again. |
| Cancelled | You or another member cancelled it. |

## Limits

Per organization, until billing arrives:

- at most two runs queued or running at once
- at most twenty runs in any rolling 24 hours
- a check run may take up to 10 minutes before it is stopped

## What a run records

- kind, project, branch name and the exact commit sha, who started it and when, when it started and finished, and status
- the transcript lines shown on the run page
- a summary: the exit path and, for a finished run, the CLI's `--json` result

Nothing else. The clone is discarded when the run ends, and no artifact of the repository is kept. Fabrication exports (gerbers, STEP, DXF) as downloadable run outputs are the next thing to arrive.

## KiCad version

The worker runs KiCad 9's `kicad-cli`. A board saved in a newer KiCad may fail to load and show as "Could not run"; the transcript names the file.
