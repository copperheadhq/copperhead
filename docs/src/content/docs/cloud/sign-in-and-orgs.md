---
title: Sign in and organizations
description: How sign-in works, what an organization is, roles, the org switcher, and your account.
sidebar:
  order: 2
---

## Sign in

Go to [app.copperhead.sh/login](https://app.copperhead.sh/login).

- **Continue with GitHub** signs you in with your GitHub account. Sign-in asks GitHub for your public profile and email address only; it never asks for repository access. Repository access is a separate step, described in [Connect a repository](/cloud/connect-a-repository/).
- **Email link** sends a one-time link to your address.

Both methods resolve to one user: if you sign in with GitHub and later with the same email, you land in the same account with the same organizations.

The first time you sign in, a short onboarding screen asks for your display name and a name for your organization. That is your personal organization; it is created for you and you are its owner.

Sign out from the account menu.

## Organizations

Everything in the console belongs to an **organization**: projects, runs, members, settings, and the audit log. Every user has a personal organization. Team organizations, with invitations and seats, arrive with billing.

Organizations are never part of the URL. `/projects` is always the active organization's projects; `/runs` its runs. The active organization is shown in the sidebar switcher, and selecting another one you belong to switches the whole console at the same URL.

If you follow a link to a run or project in another organization you belong to, the console switches to that organization for you. A link to something in an organization you do not belong to shows "Not found", exactly as a link that never existed would.

## Roles

| Capability | owner | admin | member |
| --- | :---: | :---: | :---: |
| Read projects and runs | yes | yes | yes |
| Trigger and cancel runs | yes | yes | yes |
| Connect and disconnect repositories | yes | yes | yes |
| Rename the organization | yes | yes | no |
| Remove an App installation binding | yes | yes | no |
| Read the audit log | yes | yes | no |
| Invite and remove members, change roles, billing | with team organizations | | |

Every organization always has at least one owner.

## Settings

- **General** shows the organization's display name (owners and admins can change it) and its id, in monospace, for support.
- **Members** lists members and roles; inviting is disabled until team organizations arrive, and the control says so.
- **Billing** shows the current plan; managing it is disabled until billing arrives.

## Your account

`/account` shows your profile, the identities linked to your user (GitHub, email), and the danger zone.

Deleting your account deletes the organizations where you are the only member (your personal organization, with its projects and run history) and refuses while you are the sole owner of an organization that still has other members: hand ownership over first. Audit history is kept without your identity.
