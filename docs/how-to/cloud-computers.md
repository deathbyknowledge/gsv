# Use a cloud computer

A cloud computer gives Ship and Crew an on-demand Linux environment for documents,
spreadsheets, charts, media processing and other software. Computer fluency is part
of Ship's personal intelligence: the user asks for an outcome, and Ship chooses
the tools and environment to accomplish it.

Connected user devices and cloud instances use the same target and tool
interfaces. Choose a user device when the work needs resources or access there;
choose a cloud computer when it suits the task. Its availability is controlled
by the operator, independently of whether the user's devices are online.

The initial image includes Node.js, npm, Python, Git and build tools. Install
additional software as needed and work in `/workspace`. Save useful files in
the owner's home on `gsv`, using a GSV repository for reusable source when
appropriate. Copy results back before stopping the computer: stop or expiry
destroys its files and running commands. There is no automatic restore.

## Start and use one

Check existing targets and the catalog on `gsv` before reporting that a computer
or a required tool is unavailable. Reuse a suitable ready computer, or start one
with a fresh request ID saved with the work:

```sh
targets list
instance catalog
instance start computer --request-id REQUEST_ID --name "Spending analysis" --wait
```

Keep that request ID until the outcome is known. Retrying it with the same
arguments returns the same instance, including after it stops. A fresh request
ID starts a separate computer. Browser profile and `--new` options do not apply.

Use the returned `targetId` with ordinary tools. For example, a Shell call with
`target` set to that ID can run `cd /workspace && python3 --version`.
Read, Write, Edit and filesystem transfers use that target too.
GSV management commands belong on `gsv`; Python, Node.js and installed software
run on the computer target.

In Chat, choose the ready computer from the place selector to use it for the
next message or command. Fleet opens its ordinary inspector for commands and
files. The live browser viewer is only for browser instances.

For a recoverable command, use `shell.exec` with `start: true` and a fresh,
persisted `sessionId`. Poll that session through `shell.exec`, or stop it with
`shell.cancel`. A disconnected request does not restart or erase a detached
session. If the computer itself dies, recover on a new one from saved source;
the runtime never silently reruns work.

```sh
instance list
instance get <targetId>
instance stop <targetId>
```

## Permissions and limits

Default permissions allow agent shell, filesystem and network work on cloud
computers. **Settings → permissions → Cloud computers** changes that policy.
Personal computers retain their separate approval rules, and existing custom
policies are preserved.

Computer concurrency and monthly seconds are separate from browser limits.
A start reserves its lifetime. Time is charged from readiness until stop or
expiry; unused reservation is released after physical termination is confirmed.
Computers belong to their initiating human account and installation.

## Try computers locally

With a running, accessible Docker-compatible engine, opt into real local
containers with:

```sh
GSV_DEV_COMPUTERS=1 GSV_DEV_STATE_DIR=/tmp/gsv-computer-trial npm run dev
```

Use a new state directory for fresh onboarding. Open
`http://localhost:8976/admin`, create a Space and follow its setup link. Ask Ship
to start a cloud computer, analyze a small CSV, copy the result back to `gsv` and
stop the computer. Model calls still need a configured inference provider.

This selects `workers/instances/wrangler.computer.dev.jsonc`, which builds the
normal computer image and runs it locally through Wrangler. Each Space allows
one computer at a time, up to 30 minutes per computer and two hours per month.
Stop computers before ending the dev session; their files are temporary.
The default `npm run dev` keeps computers disabled and does not require Docker.

## Operator configuration

The instance Worker exports `ComputerInstance` alongside `InstanceCoordinator`.
The reference `workers/instances/wrangler.jsonc` declares the `COMPUTERS` namespace
and a Cloudflare Container using `computer/Dockerfile`. Its `durable_object`
scheduling policy selects a digest-pinned image at startup; image updates do not
replace running computers. The initial size is `standard-1`.
The service supplies a complete `gsvd` startup command that overrides the image's
`CMD`, with `ENTRYPOINT` kept empty.

Include both namespaces in the operator composition's lifecycle inventory:
`InstanceCoordinator` as `instance-installation`, and `ComputerInstance` as
`instance-computer`. Bind the existing trusted directory and
`InstancesGatewayEntrypoint` notification service. Computer ports have no public
HTTP route and receive no Kernel or operator credentials.

Without an entitlement service, configure `COMPUTER_LIMITS` with `enabled`,
`concurrentInstances`, `periodSeconds` and `maxInstanceSeconds`. With one, use
`computer.enabled`, `computer.concurrent_instances`, `computer.period_seconds`
and `computer.max_instance_seconds`. Missing values disable creation without
preventing existing computers from being stopped. Browser limits remain separate.

Build the image from the repository root. The Dockerfile copies host sources;
the final image contains the daemon and development tools, without enrollment
configuration or an auto-updater. Container log collection is disabled. Existing
service boundaries retain instance metadata, usage and diagnostic references.
