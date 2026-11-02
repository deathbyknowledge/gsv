---
name: connect-device
description: Connect the owner's own computer (Mac, Linux or Windows) or Chrome browser to Ship with a pairing invitation, give them the exact commands or extension steps, and confirm the connection.
---

# Connect a Device

Run `targets` through `Shell` on target `gsv`. Use `targets --help` for syntax.
The owner can also connect one themselves: in **Work**, **connect** beside
Connections opens the same invitation with copy buttons.

## Before Pairing

- Check `targets list --json` first. The device may already be connected, or
  offline and due to reconnect on its own. To pair an existing target again,
  pass `--id TARGET --replace`.
- When the work needs a computer or browser but not the owner's own, a cloud
  instance may do: see `instance catalog`.
- Ask for the device's name, as it should appear (for example "work laptop"),
  and its platform: `mac`, `linux`, `windows` or `browser`.

## Create the Invitation

`targets pair --name NAME --platform PLATFORM` returns JSON with an invitation
that lasts ten minutes. Share it only with the owner, in this conversation.

For a computer, the result has `installCommand` and `pairCommand`. Tell the
owner to open PowerShell on Windows, or Terminal otherwise, then give each
command in its own fenced code block, `powershell` on Windows and `sh`
otherwise, exactly as returned: never inline, shortened or reworded, so it
copies cleanly. The first installs the `gsv` app; the second connects the
computer.

For a browser, the result has `extensionUrl`, `code` and `instructions`. Give
the download link, the steps from `instructions` in plain words, and the code
in its own fenced block.

## Confirm

Ask the owner to say when they are done, then check `targets list --online`
for the new target and report what you see, not what should happen. If the
invitation expired or was lost, `targets pair list` shows the open ones; cancel
the stale one with `targets pair cancel ID` and create another.
