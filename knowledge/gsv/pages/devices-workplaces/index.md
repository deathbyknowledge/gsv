# Devices & Workplaces

[Back to GSV Manual](../../index.md)

A workplace is where work executes. GSV can do work in the cloud computer itself, on a connected local device, in the active browser, or through an integration adapter.

Choosing the right workplace matters. A file, command, credential, private network, hardware device, browser tab, or external account may exist in one place but not another.

## Main Targets

- Cloud GSV target: the default cloud computer environment.
- Local device target: a connected machine such as a laptop, server, or workstation.
- Browser target: the active web shell and browser page.
- Adapter target: a connected external platform surface, when supported by that adapter.

## Common Workflows

- Run ordinary cloud-side work on the GSV target.
- Use a local device when the task needs local files, OS packages, private network access, hardware, or installed tools.
- Use the browser target for DOM inspection, browser-local files, previews, and web shell automation.
- Use adapter targets only for actions that belong to an external integration and are supported there.
- Copy files across targets when the input and output must move between places.

## Pages In This Section

- [Targets, Execution & Cross-Target Copy](targets-copy.md)

## For Agents

Do not assume a command runs on the user's laptop. Ask or inspect the target. When reporting results, say where the command or file operation ran if the location matters.
