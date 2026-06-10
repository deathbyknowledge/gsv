# Accounts & Access

[Back to GSV Manual](../../index.md)

Accounts and access decide who can see, change, run, or connect things in GSV. Humans and agents are both accounts, but they are used differently.

## Account Types

- Human accounts are for people who log in and operate GSV.
- Personal agent accounts are the default assistants attached to humans.
- Custom agent accounts are named assistants with their own behavior and access.
- Package agent accounts come from packages and are usually scoped to package work.
- Service identities are used by trusted system connections such as adapters or devices.

## Permissions And Groups

Permissions decide what an account may do. Groups help grant access to sets of accounts. A capability may allow a kind of operation, but the specific operation can still have ownership or safety checks.

Examples of access boundaries:

- A user should not see another user's private home files unless sharing allows it.
- A package should not get broad system access unless it has been reviewed and approved.
- An external identity link should route messages to the right GSV user without granting unrelated access.
- An agent should run with the identity and permissions intended for its task.

## Pages In This Section

- [Credentials, Sessions & Sharing Boundaries](credentials-sharing.md)

## For Agents

Before changing access, issuing tokens, linking external identities, or using credentials, identify the account involved and whether the user has authority over it.
