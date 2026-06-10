# Targets, Execution & Cross-Target Copy

[Devices & Workplaces](index.md)

## Cloud GSV Target

The cloud GSV target is the normal default. Use it for cloud files, cloud-side package work, system settings, knowledge operations, and ordinary GSV shell tasks.

## Local Devices

Local devices extend GSV to places the cloud cannot reach by itself. Use a local device when the work depends on:

- Files stored on that device.
- Local command-line tools.
- A private network or VPN.
- Hardware such as cameras, microphones, GPUs, or connected equipment.
- Credentials that should remain local.

Local devices can go offline. If a task depends on one, check that it is connected before starting.

## Browser Target

The browser target is the active GSV web shell in the user's browser. Use it for:

- Inspecting or automating the current desktop.
- Testing previews.
- Reading browser-local state.
- Running browser-side JavaScript.
- Checking layout or interaction behavior.

Browser-target work is not the same as cloud shell work.

## Adapter Targets

Some integrations expose command-like surfaces. These are adapter targets. They are only available when the external account is connected, linked to a GSV identity, and the adapter supports the action.

## Cross-Target Copy

Cross-target copy moves files between workplaces. Be explicit about source and destination. A path that is valid on one target may not exist on another.

Good copy requests name both sides:

- From a local device path to `/home/...` in GSV.
- From `/home/...` in GSV to a local downloads folder.
- From a generated cloud file into a browser preview workflow.

## For Agents

When copying or executing across targets, preserve user data boundaries. Do not move secrets or private files between targets unless the user asked for that transfer or the workflow clearly requires it.
