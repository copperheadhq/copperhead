---
title: Cloud console overview
description: What copperhead cloud is, what it does today, and what it deliberately never stores.
sidebar:
  order: 1
---

[copperhead cloud](https://app.copperhead.sh) is the hosted front door for copperhead. The CLI is the agent and works on your machine with no account at all; the cloud is the account, the tenant, and the place a run is watched. It holds no design truth of its own.

Today the console does four things:

- **Sign in** with GitHub or an email link, into an organization that is provisioned for you.
- **Connect a repository** through the copperhead GitHub App, as a project.
- **Run `copperhead check` hosted**, against a pinned commit of the repository, from the browser.
- **Watch the run** stream live, cancel it, and read its verdict and history.

Hosted agent runs (`do`, `create`), fabrication exports, and team organizations with billing are on the way; the console tells you plainly when a control is not available yet and what unlocks it.

## The three rules the console lives by

**Design truth stays in your repository.** copperhead cloud stores identity, tenancy, pointers, and run metadata: who ran what, on which commit, and what the CLI said. It never stores your KiCad files or becomes a second copy of your design.

**Repository access is an installation, not your sign-in.** Signing in asks GitHub only for your public profile and email. Reading a repository requires the copperhead GitHub App to be installed on it, which is a separate consent. The console mints a short-lived token for that installation, uses it, and drops it; the worker that clones your repository for a run does the same.

**The tenant boundary is enforced in the database.** Every read in the console is filtered by row-level security in Postgres, so an application bug is not enough to show one organization another organization's rows. A link to something you cannot see shows "Not found", indistinguishable from a link that never existed.

## What a run is, in one paragraph

A hosted run is one execution of the copperhead CLI, in a fresh container, against one commit of a connected repository. `check` runs ERC, DRC, documentation drift, and spec validation; it uses no language model and makes no network calls, so nothing about a hosted check depends on a model key. The worker streams the CLI's own transcript back to the run page as it happens, records the verdict and the CLI's machine-readable result, and discards the clone.

## Where to go next

- [Sign in and organizations](/cloud/sign-in-and-orgs/)
- [Connect a repository](/cloud/connect-a-repository/)
- [Hosted check runs](/cloud/hosted-checks/)
- [Troubleshooting](/cloud/troubleshooting/)
