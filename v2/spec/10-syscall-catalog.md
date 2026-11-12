# 10 · Syscall catalog

The complete list of 2.0 operations, the rules their names follow, and how each
one maps to a permission check `[D 11-11]`.

## Naming rules

`[D 11-11]`

1. Primitives keep Unix names: `fs`, `shell`, `tty`, `screen`, `net`, `web`,
   `ai`, `codemode`. The target picks the resource kind.
2. Everything else is kind first: `space`, `account`, `owner`, `machine`,
   `proc`, `responsibility`, `source`, `channel`, `connection`.
3. `proc` is the one short kind name, because `process` is a JavaScript global.
4. At most three parts. A type appears only when a kind holds things with
   different arguments (`channel.mail`, `channel.contact`, `channel.messenger`,
   `connection.mcp`, `connection.oauth`, `connection.browser`).
5. Records use list, get, create, update, remove. Other verbs only where those
   mislead. `delete` only on `fs`.
6. Shared operations sit at the kind level (`connection.list` and `.remove`,
   `machine.list` covering cloud machines, `source.*` covering schedules and
   hooks, `channel.delivery.*` for every kind of send).
7. `grant.*` and `operator.*` sit outside the kinds. Settings are typed keys
   (`owner.settings`, `proc.settings`), not one call per setting.

Shell and CLI commands keep their words; CodeMode uses catalog names
`[D 11-11]`. The gate never reads names to decide anything: rules match kind,
verb and resource `[D 11-11]`.

## The authorization map

A pure function per operation turns its arguments into the checks it needs,
the DO that enforces them and the DO that serves the call, without changing the
arguments `[D 11-10]`.

```ts
type AuthzPlan = {
  checks: { kind: Kind; verb: Verb; resource: ResourceRef }[];  // one per resource (M1)
  enforcer: OwnerId;                                            // whose DO issues the ticket
  serve: { do: "owner" | "process" | "volume" | "target" | "space" | "worker"; id: string };
};
type AuthzMap = { [op in CatalogName]: (args: Args<op>, actor: Actor, mounts: MountTable) => AuthzPlan };
// shell.exec on gsv returns no checks for itself: the shell Worker's only binding is the gate,
// and each call inside it is checked. On a machine it is one machine.use check. [D 11-11]
```

The table's "Checks" column below is that function's output per 1.0 origin.
`files.read | machine.read` means the target picks: a path in a Volume or a file
on a machine. `—` means no check of its own (each inner call is checked).
Inference, network and cloud hours are quotas, never checks `[D 11-11]`.

## Counts

From 1.0's 202 syscalls: 27 keep their name, 74 are renamed, 42 merge, 2 split
(settings by whose settings), 23 become file operations, 2 become the socket
watch frame, and 32 leave (sign-in edge, adapter protocol, internal DO methods,
streams, Ship-only and dropped). 21 operations are new. `public.profile.get`
from the 11-11 page is dropped, since the `public` kind went: another owner's
profile is `fs.read` on a file shared with Public `[D 11-11]`.

## Operations

145 operations.

### `fs` (14)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `fs.batch` | files.write | `repo.apply` | Several writes in one transaction, a base revision per file. |
| `fs.changes` | files.read | `conversation.history` | The folder's change feed from a cursor. |
| `fs.copy` | files.read + files.write | `fs.copy` | Between any two of a folder and a machine; resumes from an offset (decided 11 Nov). |
| `fs.delete` | files.write · files.write \| machine.write | `fs.delete`, `profile.avatar.remove`, `repo.delete` | delete stays on fs, the Unix primitive; records elsewhere are removed. |
| `fs.edit` | files.write \| machine.write | `fs.edit` |  |
| `fs.list` | files.read · process.read | `conversation.inbox`, `conversation.list`, `mail.list`, `mail.sent`, `proc.history.segments`, `repo.list` | On the mail folder. On the sent subfolder. Conversation folders, with the reader's own view state. A repository is a folder. |
| `fs.mkdir` | files.write | `repo.create` |  |
| `fs.move` | files.write \| machine.write | new | Within a Volume it is a row update, not a copy and delete. |
| `fs.read` | files.read · files.read \| machine.read · process.read | `fs.read`, `fs.transfer.send`, `fs.transfer.stat`, `mail.read`, `proc.history.segment.read`, `profile.avatar.read`, `profile.get`, `repo.read` | A stat is a read without the bytes. Over 64 KiB, the bytes come back as a ticket URL. The message file keeps its headers and a text rendering. The profile is a file of the owner's (M11). Archives are files in the agent account's home (decided 11 Nov). |
| `fs.search` | files.read · files.read \| machine.read | `conversation.search`, `fs.search`, `mail.search`, `repo.search` | The mail folder is indexed. The folder index. |
| `fs.upload.finish` | files.write \| machine.write | new | Commits the file. |
| `fs.upload.start` | files.write \| machine.write | new | Returns the upload id, the 32 MiB part size and a ticket. |
| `fs.upload.status` | files.write \| machine.write | new | Which parts landed, to resume. |
| `fs.write` | files.write · files.write \| machine.write | `conversation.send`, `fs.transfer.receive`, `fs.write`, `profile.avatar.set`, `profile.update` | Large writes go through fs.upload.*. A message is a file. To someone outside the space it is channel.contact.send (M6). |

### `shell` (3)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `shell.attach` | machine.use | new | A ticketed WebSocket to a long session's output. |
| `shell.cancel` | — \| machine.use | `shell.cancel` |  |
| `shell.exec` | — \| machine.use | `shell.exec` |  |

### `tty` (5)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `tty.attach` | machine.use | new | The ticketed WebSocket xterm.js uses. |
| `tty.close` | machine.use | new |  |
| `tty.keys` | machine.use | new | Agents send keys. |
| `tty.open` | machine.use | new | A real PTY on a machine or cloud computer. Agents ask once per session. |
| `tty.screen` | machine.use | new | Agents read the screen as text, with waitFor. |

### `screen` (5)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `screen.capture` | machine.use | new |  |
| `screen.input` | machine.control | `sys.browser.input` |  |
| `screen.start` | machine.use | new | Computer use; one ask per session, indicator and stop button. |
| `screen.stop` | machine.use | new |  |
| `screen.watch` | machine.control | `sys.browser.watch` | The extension and cloud browsers are screen sessions (decided 11 Nov). People only. |

### `net` (1)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `net.fetch` | quota:net \| machine.use | `net.fetch` |  |

### `web` (1)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `web.search` | quota:net \| machine.use | `web.search` |  |

### `ai` (6)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `ai.image.generate` | quota:infer | `ai.image.generate` |  |
| `ai.image.read` | quota:infer | `ai.image.read` |  |
| `ai.model.list` | owner.read | `ai.models` |  |
| `ai.speech.create` | quota:infer | `ai.speech.create` |  |
| `ai.text.generate` | quota:infer | `ai.text.generate` |  |
| `ai.transcription.create` | quota:infer | `ai.transcription.create` |  |

### `codemode` (1)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `codemode.exec` | — | `codemode.exec`, `codemode.run` | Run from a shell or the CLI, it runs as whoever runs it. |

### `grant` (3)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `grant.create` | files.share | `profile.publish`, `repo.visibility.set` | Sharing the profile file with Public (D3). Public is a grant to the Public grantee or a link. |
| `grant.list` | *.share | new | Who has what on a resource. |
| `grant.remove` | files.share | `profile.unpublish` |  |

### `operator` (3)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `operator.cloud.list` | — | `sys.instance.catalog` | What the operator offers. |
| `operator.feedback.send` | — | `sys.feedback` |  |
| `operator.messenger.get` | — | `adapter.pair.info` | The shared bot's public setup details. |

### `space` (6)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `space.owner.link` | space.admin | `account.owner.link` | Links the space to its owner in Accounts. |
| `space.settings.get` | owner.read \| space.read | `sys.config.get` | Split by whose settings they are. |
| `space.settings.set` | owner.write \| space.admin | `sys.config.set` | Agents may change their person's settings (founder, 9 Nov). |
| `space.team.create` | space.admin | new | Adding a member is a grant on the team. |
| `space.team.list` | space.read | new |  |
| `space.team.remove` | space.admin | new |  |

### `account` (12)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `account.create` | account.manage | `account.create` | An agent account under the owner. |
| `account.link.confirm` | account.manage | `adapter.pair.confirm` | A signed-in person's tap completes it (M3). |
| `account.link.inspect` | account.manage | `adapter.pair.inspect` | Pairing is people only (M3). |
| `account.link.list` | account.manage | `sys.link.list` | Messenger identities linked to the person. |
| `account.link.remove` | account.manage | `adapter.pair.disconnect` |  |
| `account.list` | account.read | `account.list` |  |
| `account.signin.create` | account.manage | new | Needs a fresh check with an existing method. |
| `account.signin.list` | account.manage | new | Passkeys, Google or Apple, email code. People only. |
| `account.signin.remove` | account.manage | new | The last method can't be removed. |
| `account.token.create` | account.manage | `sys.token.create` | A person's own tokens (M4). People only. |
| `account.token.list` | account.manage | `sys.token.list` |  |
| `account.token.remove` | account.manage | `sys.token.revoke` |  |

### `owner` (8)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `owner.approval.decide` | owner.approve | `proc.hil` | The approval belongs to the owner whose rule asked (M5). People only. |
| `owner.event.list` | owner.read | new | The Activity read: people see all; agents see what was delivered to them. |
| `owner.ledger.list` | owner.read | `sys.ledger.list` |  |
| `owner.settings.get` | owner.read · owner.read \| space.read | `notify.rule.list`, `r12y.source.list`, `sys.config.get` | Key notify.rules, typed in the catalog. Split by whose settings they are. Key responsibility.sources. |
| `owner.settings.set` | owner.write · owner.write \| space.admin | `notify.rule.reset`, `notify.rule.set`, `r12y.source.update`, `sys.config.set` | Setting a key to null restores its default. Agents may change their person's settings (founder, 9 Nov). |
| `owner.usage.get` | owner.read | new | Allowances, levels and rates with what is used and when each resets; the Usage screen and `gsv usage` read it. |
| `owner.view.get` | owner.read | `conversation.view.get` | Read cursor and archived flag are the reader's own state. |
| `owner.view.update` | owner.write | `conversation.view.update` |  |

### `machine` (14)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `machine.cloud.start` | machine.manage | `sys.instance.start` |  |
| `machine.cloud.stop` | machine.manage | `sys.instance.stop` |  |
| `machine.get` | machine.read | `sys.instance.get`, `sys.target.get` |  |
| `machine.handoff.cancel` | machine.use | `sys.browser.handoff.cancel` |  |
| `machine.handoff.create` | machine.use | `sys.browser.handoff.request` | An agent asks its person to take the browser. |
| `machine.handoff.finish` | machine.control | `sys.browser.handoff.finish` | People only. |
| `machine.handoff.get` | machine.read | `sys.browser.handoff.get` |  |
| `machine.handoff.open` | machine.control | `sys.browser.handoff.open` | People only. |
| `machine.invite.create` | machine.manage | `sys.pair.create` | Was machine.invite in the Target DO notes; three parts like its list and remove. |
| `machine.invite.list` | machine.manage | `sys.pair.list` |  |
| `machine.invite.remove` | machine.manage | `sys.pair.cancel` |  |
| `machine.list` | machine.read | `sys.instance.list`, `sys.target.list` | Enrolled and cloud machines in one list. |
| `machine.remove` | machine.manage | `sys.target.delete` |  |
| `machine.update` | machine.manage | `sys.target.update` |  |

### `proc` (13)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `proc.abort` | process.control | `proc.abort` |  |
| `proc.compact` | process.control | `proc.history.compact` |  |
| `proc.fork` | account.use + process.read | `proc.fork` |  |
| `proc.history` | process.read | `proc.history` |  |
| `proc.kill` | process.control | `proc.kill` |  |
| `proc.list` | process.read | `proc.list` |  |
| `proc.reset` | process.control | `proc.reset` |  |
| `proc.send` | process.send | `proc.ipc.call`, `proc.ipc.send`, `proc.send` | A message between processes is an ordinary send. With a reply id; the answer comes back through the caller's owner log. |
| `proc.settings.get` | process.read | `proc.ai.config.get`, `proc.history.policy.get` | Per-process settings: model and history policy. |
| `proc.settings.set` | process.control | `proc.ai.config.set`, `proc.history.policy.set` |  |
| `proc.spawn` | account.use | `proc.spawn` |  |
| `proc.trace` | process.read | `proc.trace` |  |
| `proc.watch` | process.read | `proc.observe` | Returns the ticket and URL of the run's SSE stream. |

### `responsibility` (5)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `responsibility.changes` | responsibility.read | `r12y.changes` | Changes from a cursor, like fs.changes. |
| `responsibility.create` | responsibility.write | `r12y.create` |  |
| `responsibility.get` | responsibility.read | `r12y.get` |  |
| `responsibility.list` | responsibility.read | `r12y.list` |  |
| `responsibility.update` | responsibility.write | `r12y.update` |  |

### `source` (8)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `source.create` | source.manage | `event.source.add`, `sched.add` | Agents ask by default when it would start work. |
| `source.emit` | source.use | `event.emit` |  |
| `source.event.list` | source.read | `event.list` | Reads the source events in the owner log. |
| `source.list` | source.read | `event.source.list`, `sched.list` | Hooks, app sources and schedules in one list. A schedule is a timed source (M8). |
| `source.remove` | source.manage | `event.source.remove`, `sched.remove` |  |
| `source.rotate` | source.manage | `event.source.rotate` | A new secret for a hook. |
| `source.run` | source.use | `sched.run` | Run due schedules, or one now. |
| `source.update` | source.manage | `event.source.update`, `sched.update` |  |

### `channel` (27)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `channel.block.list` | channel.read | `contact.block.list` |  |
| `channel.block.set` | channel.share | `contact.block.set` | Blocks cover contacts and strangers. People only. |
| `channel.contact.list` | channel.read | `contact.list` |  |
| `channel.contact.remove` | channel.share | `contact.revoke` |  |
| `channel.contact.send` | channel.send | `contact.send` |  |
| `channel.contact.update` | channel.manage | `contact.alias.set`, `contact.preferences.update` | An alias is a field on the contact. |
| `channel.delivery.get` | channel.read | `contact.delivery.get`, `mail.status` | One delivery record for mail, contact and messenger sends. |
| `channel.delivery.list` | channel.read | `contact.delivery.list` |  |
| `channel.delivery.retry` | channel.send | `approach.retry`, `contact.delivery.retry` | Retrying a request is retrying its delivery. |
| `channel.invite.accept` | channel.share | `contact.invite.accept` |  |
| `channel.invite.create` | channel.share | `contact.invite.create` |  |
| `channel.invite.list` | channel.read | `contact.invite.list` |  |
| `channel.invite.remove` | channel.share | `contact.invite.cancel` |  |
| `channel.mail.send` | channel.send | `mail.send` |  |
| `channel.messenger.connect` | channel.manage | `adapter.connect` | The owner's own bot or business number. |
| `channel.messenger.disconnect` | channel.manage | `adapter.disconnect` |  |
| `channel.messenger.get` | channel.read | `adapter.status` |  |
| `channel.messenger.list` | channel.read | `adapter.list` |  |
| `channel.messenger.send` | channel.send | `adapter.send` |  |
| `channel.request.create` | channel.send | `approach.create` | A message request to someone who is not a contact yet: approach becomes request. |
| `channel.request.decide` | channel.share | `approach.decide` | People only. |
| `channel.request.get` | channel.read | `approach.get` |  |
| `channel.request.list` | channel.read | `approach.list` |  |
| `channel.request.report` | channel.share | `approach.report` | People only. |
| `channel.task.create` | channel.send | `contact.request.create` |  |
| `channel.task.list` | channel.read | `contact.request.list` | A task offered to or by a contact: request becomes task, so it can't be confused with a message request. |
| `channel.task.update` | channel.send | `contact.request.update` |  |

### `connection` (10)

| Operation | Checks | From 1.0 | Note |
| --- | --- | --- | --- |
| `connection.browser.create` | connection.manage | `sys.browser.profile.create` | A saved browser sign-in, like an OAuth account. |
| `connection.browser.save` | connection.manage | `sys.browser.profile.save` |  |
| `connection.call` | connection.use | `sys.mcp.call` | Agents ask by default. |
| `connection.get` | connection.read | `sys.browser.profile.get` |  |
| `connection.list` | connection.read | `sys.browser.profile.list`, `sys.mcp.list`, `sys.oauth.list` | MCP servers, OAuth accounts and browser profiles in one list. |
| `connection.mcp.create` | connection.manage | `sys.mcp.add` |  |
| `connection.mcp.refresh` | connection.manage | `sys.mcp.refresh` |  |
| `connection.oauth.poll` | connection.manage | `sys.oauth.device.poll` |  |
| `connection.oauth.start` | connection.manage | `sys.oauth.device.start`, `sys.oauth.start` | With flow: device. |
| `connection.remove` | connection.manage | `sys.browser.profile.delete`, `sys.mcp.remove`, `sys.oauth.forget` |  |

