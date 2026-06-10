# Apps & Desktop

[Back to GSV Manual](../../index.md)

The GSV desktop is the browser-hosted work surface for the cloud computer. It opens apps in windows, keeps sessions connected, shows previews, and gives package apps a safe way to communicate with the host.

## What The Desktop Owns

- Login and setup.
- The desktop frame, launcher, and app windows.
- Opening, moving, focusing, and closing app windows.
- App previews and browser-hosted views.
- The bridge that lets package apps request host actions.
- Browser targets for automation that must happen inside the active web shell.

## What Apps Own

Apps own their product work:

- Chat owns conversations and agent work.
- Files owns browsing and editing the filesystem.
- Shell owns command sessions.
- Wiki owns durable knowledge.
- GSV console owns system operation and configuration.
- Package apps own their own app-specific views and behavior.

The desktop should feel like the place where work happens, not a dashboard about work.

## Pages In This Section

- [Builtin Apps, Previews & Host Bridge](builtin-apps-previews.md)

## For Agents

When a task is visual, window-based, or browser-local, use the desktop and browser target. When a task is about files, packages, settings, or devices, prefer the app that owns that work instead of relying on hidden commands.
