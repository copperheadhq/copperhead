---
title: Troubleshooting
description: The messages you may see in the cloud console and what to do about each.
sidebar:
  order: 5
---

## Sign-in and access

**I signed in with email and then with GitHub; are those two accounts?**
No. Both resolve to the same user as long as the email address matches. Your organizations and projects are the same in both.

**"Not found" on a link a colleague sent me.**
The console does not distinguish a wrong id from a run or project in an organization you are not a member of. Ask them to check the organization; team invitations arrive with billing.

## Connecting repositories

**The App installation was declined.**
The App was installed on a GitHub organization. Only installations on your own account bind today; organization installations arrive with team organizations. Reinstall on your personal account, or wait for team organizations.

**A repository is missing from the list.**
The installation does not cover it. On GitHub, open *Settings, Applications, copperhead, Configure* and add the repository, then reload the connect page: the list is read live.

**A repository is shown as already connected.**
One repository connects to an organization at most once. Find it under Projects.

## Runs

**"Run check" is disabled.**
The project has no repository connected, or its installation was removed. Reconnect it from Projects.

**"The default branch could not be found on the repository."**
The branch was renamed or deleted, or the installation no longer covers the repository. Fix the default branch on GitHub or reconnect the project.

**"GitHub could not be reached to resolve the branch."**
A transient GitHub or network problem. Try again in a moment.

**"This org already has two runs queued or running."** or **"...twenty runs in 24 hours."**
Per-organization limits until billing arrives. Wait for a run to finish, or cancel one from its run page.

**The run stays Queued for several minutes.**
Workers start on demand and the first one after a quiet period takes longer while its image is fetched. If a run stays queued far beyond that, cancel it and start again; if it repeats, tell us with the run id.

**Failed, "Could not run: ..."**
The reason is on the run page. "run timed out" means the check exceeded 10 minutes. A KiCad file the worker cannot open usually means the board was saved with a newer KiCad than the worker's KiCad 9.

**Failed, "The worker stopped responding and the run was reaped."**
The worker died mid-run and the run was closed out. Start it again.

**The transcript stopped updating.**
The stream reconnects on its own and resumes where it left off; a page reload shows everything recorded so far. When the run finishes the page refreshes itself.

## Reporting a problem

Include the run id (shown on the run page in monospace) or the organization id (Settings, General). Neither is secret, and both let us find exactly what happened.
