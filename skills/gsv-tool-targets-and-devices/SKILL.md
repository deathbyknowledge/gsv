---
name: gsv-tool-targets-and-devices
description: Choose between the native gsv target and connected devices for filesystem, shell, or CodeMode work, including routing, capabilities, approval, and local device setup.
---

# GSV Tool Targets and Devices

## When to Use

Use this skill before filesystem, shell, or CodeMode work when target selection, device routing, permissions, or approval behavior affects the task.

## Target Rules

Agents see one public tool set:

- `Read` -> `fs.read`
- `Write` -> `fs.write`
- `Edit` -> `fs.edit`
- `Delete` -> `fs.delete`
- `Search` -> `fs.search`
- `Shell` -> `shell.exec`
- `CodeMode` -> `codemode.exec`

Use `target: "gsv"` for the Gateway-native control target. Use a connected device id only when the relevant file, command, credential, private network, OS package, or hardware dependency lives on that machine.

Only `fs.*` and `shell.exec` are hardware-routed. Other syscall domains such as `proc.*`, `pkg.*`, `repo.*`, `sys.*`, `adapter.*`, `signal.*`, and `notification.*` are Kernel/control-plane interfaces.

`CodeMode` itself is process-local. Code running inside CodeMode can call `fs.*` and `shell(...)`, and those nested calls use the same target and session routing rules.

## Device Checklist

1. Inspect available targets from the prompt or with `Read` on `/sys/devices`.
2. Confirm the device is online and implements the needed syscall pattern such as `fs.*` or `shell.exec`.
3. Use device targets for local source trees, private networks, local credentials, OS-level tools, or hardware access.
4. Use native `gsv` for GSV filesystem paths, package commands, process operations, and cloud control-plane work.
5. Treat a device shell as the user's real machine, not a sandbox.

## Connecting a Device

The preferred setup path is the Desktop `Devices` app. It can issue a device token and show the bootstrap command.

Manual shape:

```bash
gsv config --local set gateway.username "<user>"
gsv config --local set node.id "<device-id>"
gsv config --local set node.token "<device-token>"
gsv device install --id <device-id> --workspace ~/projects
gsv device status
```

Use `gsv device run` for a foreground driver and `gsv device install` for a managed local service.

## Approval and Safety

Interactive profiles may pause for human approval. Shell execution, deletes, destructive commands, hidden paths, remote device targets, privileged commands, and network commands can be tagged as risky by policy.

If approval is denied or a route fails, treat the failure as part of the task state. Choose a narrower command, safer target, or ask the user for explicit approval rather than repeating the same action.
