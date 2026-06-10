# Auth, Sessions & Raw Config Recovery

[Settings](index.md)

## Auth And Sessions

Authentication controls who can enter GSV. Sessions keep a browser, device, or service connected after sign-in.

Use normal settings and console flows for:

- Setup and first login.
- Signing in and out.
- Reviewing connected sessions.
- Revoking suspicious sessions.
- Adjusting session behavior.
- Connecting trusted devices or services.

If a user loses access, prefer documented recovery flows over direct configuration edits.

## Raw Config

Raw config is the low-level settings view. It is useful when:

- A normal settings screen cannot load.
- A bad value needs to be removed.
- An advanced key is not yet exposed in the curated UI.
- A support or operator procedure gives an exact key to inspect.

Raw config is not the normal way to browse settings. Some settings live in dedicated stores and will not appear as ordinary config keys.

## Recovery Principles

- Change the smallest setting that solves the problem.
- Record the old value before changing it, unless it is a secret.
- Prefer removing an explicit override when you want to return to a default.
- Avoid pasting secrets into chat, Wiki, or ordinary files.
- Test sign-in or the affected feature after a recovery change.

## For Agents

Never guess raw config keys when a user-facing setting exists. If raw recovery is necessary, say why, name the key, and keep the change narrow.
