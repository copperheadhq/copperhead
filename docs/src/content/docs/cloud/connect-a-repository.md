---
title: Connect a repository
description: Install the copperhead GitHub App, connect a repository as a project, and understand what the console reads from it.
sidebar:
  order: 3
---

A **project** is one connected repository. Connecting is a two-step consent: install the copperhead GitHub App on the repositories you choose, then pick one of them in the console.

## Install the App and connect

1. Open **Projects** and choose **Connect a repository**.
2. You are sent to GitHub to install the **copperhead** GitHub App. Choose the repositories it may see: all of them, or a selection. This is where repository access is granted; sign-in never asked for it.
3. Back in the console, the repositories the installation can see are listed live from GitHub. Choose one and connect it.

The console records the repository name and id, the installation it came through, the default branch, and the repository's visibility. All of that is read from GitHub server-side; nothing you type in the console can change it.

## What the App can do

The App holds these repository permissions: contents (read and write), pull requests (read and write), checks (read and write), and metadata (read). Today the console uses them to list repositories, resolve a branch to a commit, and clone at that commit for a run. Writing back (a branch and pull request from an agent run) arrives with hosted agent runs, and it will always be a branch, never a push to your default branch.

## Personal accounts only, for now

The App must be installed on **your own GitHub account**, the one you signed in with. Installing it on a GitHub organization is not supported yet: organization installations arrive together with team organizations in the console, so that an organization's repositories connect to a team, not to whoever clicked first. If you install on an organization today, the console will decline to bind that installation and tell you why.

## Open hardware

A public repository is marked **open hardware** on its project. The flag is derived from the repository's visibility on GitHub, refreshed each time the projects page loads. Flipping a repository from public to private is picked up on the next load. This is the flag pricing will read, and it cannot be set from the console.

## Disconnect

Disconnecting a project (owner or admin) removes only the pointer in copperhead cloud. The repository and the App installation stay exactly as they are; nothing is written to GitHub. Removing the App installation itself is done from the installation's card in the console (owner or admin) or on GitHub under *Settings, Applications*. An installation still referenced by a project asks you to disconnect the project first.

## What is read, and when

Repository state is read live at page load; there is no webhook yet, so a rename or visibility change lands on the next visit. A run reads the repository exactly once: it resolves the branch to a commit sha when you trigger it, and clones that commit when a worker picks it up. The clone is discarded when the run ends.
