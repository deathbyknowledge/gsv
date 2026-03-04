# Thread-Centric Multi-Tenant Specification

## Status

- Draft
- Date: `2026-03-03`
- Scope: Replace overloaded session-key routing with explicit thread identity, routing, membership, and tenancy boundaries.

## Summary

This specification defines a thread-centric architecture where:

- `threadId` is the logical conversation identity (opaque).
- `stateId` is the runtime state-machine identity (Session DO name).
- Router resolves `(spaceId, agentId, threadId, stateId)` from inbound context.
- Authorization is enforced by membership and capabilities, not by key format.

`sessionKey` is legacy input compatibility only.

`stateId` is retained to preserve no-fork upgrades. In a greenfield deployment
with no backward compatibility requirement, all threads can use
`stateId = thread:{threadId}` directly.

## Problem

The previous model overloaded one string (`sessionKey`) to represent:

- routing address,
- Session DO identity,
- human-facing handle,
- and implicit tenant boundary.

This created ambiguity and leakage risk in multi-human/multi-channel scenarios, especially group surfaces.

## Goals

- Separate identity, routing, tenancy, and user-facing references.
- Support personal and shared contexts safely.
- Make group behavior explicit by policy.
- Guarantee no session-fork for existing deployments during migration.

## Non-Goals

- Enterprise IAM/OAuth.
- Cross-instance tenancy federation.
- Full policy DSL beyond role + capability + allow/deny.

## Terminology

- **Principal**: authenticated actor identity (`channel sender`, `client token identity`).
- **Surface**: where messages appear (`channel`, `accountId`, `peerKind`, `peerId`).
- **Space**: tenant boundary for state and policy (personal or shared).
- **Agent**: runtime/persona inside a space.
- **Thread**: logical conversation state and history.
- **threadId**: opaque logical thread identifier.
- **stateId**: concrete Session DO identity used for execution.
- **ThreadRef**: user/API reference that resolves to a thread.

## Core Decisions

1. `threadId` is the logical identity for threads; it is opaque.
2. `stateId` is the execution identity for Session DO routing.
3. New threads use `stateId = thread:{threadId}`.
4. Legacy imported threads use `stateId = legacySession:{canonicalLegacySessionKey}`.
5. Router resolves `(spaceId, agentId, threadId, stateId)`.
6. Group surfaces default to `group-shared` mode.
7. Conversation binding selects target space; membership authorizes access.
8. Authorization is capability-based and enforced at dispatch boundaries.

## Architecture

## 1) Identity Separation

The system MUST keep these independent:

- `principalId` (who)
- `surfaceId` (where)
- `spaceId` (tenant boundary)
- `agentId` (assistant runtime)
- `threadId` (logical thread)
- `stateId` (runtime state machine)

No single string may implicitly represent all axes.

## 2) Thread and State Identity

- `threadId` MUST be opaque (`ULID` or `UUIDv7` recommended).
- `threadId` MUST NOT embed peer IDs, phone numbers, or profile names.
- Session DO addressing MUST use `stateId`, not semantic routing strings.
- `threadMeta[threadId]` MUST include `stateId`.
- If backward compatibility is not required, implementations MAY omit
  `legacySession:*` usage and use `thread:{threadId}` for all state IDs.

## 3) Thread References

APIs accept `threadRef`.

Supported forms:

- `id:{threadId}`

Legacy `sessionKey` remains accepted as compatibility input and resolves through legacy mapping.
- `alias:*` and `addr:*` references are explicitly deferred and out of scope for this phase.

## RegistryStore (Authoritative Runtime State)

All routing/binding registries MUST be accessed through a `RegistryStore` abstraction.

Required logical collections:

- `principalProfiles`: `principalId -> { homeSpaceId, homeAgentId?, status }`
- `spaceMembers`: `(spaceId, principalId) -> { role }`
- `conversationBindings`: `surfaceId -> { spaceId, agentId?, groupMode }`
- `threadRoutes`: `routeHash -> { threadId, routeTuple }`
- `threadMeta`: `threadId -> { stateId, spaceId, agentId, createdAt, lastActiveAt, legacy }`
- `pendingBindings`
- `invites`

Source-of-truth rules:

- Runtime registry is authoritative after initialization.
- Config maps are seed inputs only unless explicit managed mode is enabled.
- If config and runtime differ, runtime wins.

Consistency requirement:

- Route resolution/create operations MUST be strongly consistent and serialized per registry instance.

Implementation plan:

- Phase 0: `RegistryStore` backed by Gateway DO storage.
- Later: move backing implementation to dedicated Registry DO without changing router interface.

Why Phase 0 uses Gateway DO storage:

- single-writer consistency for route resolution/create without cross-DO races
- minimal operational complexity while semantics stabilize
- no public API change when later swapped to a dedicated Registry DO

## Concrete Config Schema (Seed + Defaults)

```json
{
  "auth": {
    "tokens": {
      "owner-cli": {
        "type": "client",
        "secret": "REDACTED",
        "principalId": "client:token:owner-cli",
        "role": "owner",
        "scopes": ["*"]
      },
      "node-main": {
        "type": "node",
        "secret": "REDACTED",
        "principalId": "node:token:node-main",
        "scopes": ["node.connect", "node.tools.execute"]
      }
    }
  },
  "spaces": {
    "defaultSpaceId": "owner",
    "entries": {
      "owner": {
        "displayName": "Owner",
        "defaultAgentId": "main",
        "policy": {
          "allowCapabilities": ["*"],
          "denyCapabilities": []
        }
      },
      "household": {
        "displayName": "Household",
        "defaultAgentId": "main",
        "policy": {
          "allowCapabilities": [
            "workspace.read",
            "workspace.write",
            "delivery.reply",
            "sessions.read"
          ],
          "denyCapabilities": [
            "config.write",
            "node.exec"
          ]
        }
      }
    }
  },
  "roles": {
    "owner": {
      "allowCapabilities": ["*"],
      "denyCapabilities": []
    },
    "member": {
      "allowCapabilities": [
        "workspace.read",
        "workspace.write",
        "delivery.reply",
        "sessions.read",
        "sessions.write"
      ],
      "denyCapabilities": ["config.write"]
    },
    "guest": {
      "allowCapabilities": ["delivery.reply", "threads.read"],
      "denyCapabilities": [
        "config.write",
        "node.exec",
        "workspace.read",
        "workspace.write",
        "workspace.delete",
        "cron.manage",
        "transfer.execute",
        "message.send"
      ]
    }
  },
  "routing": {
    "dmDefaultMode": "per-user",
    "groupDefaultMode": "group-shared",
    "requireConversationBinding": {
      "discord": {
        "channel": true,
        "thread": true,
        "group": true
      },
      "whatsapp": {
        "group": true
      }
    }
  },
  "channels": {
    "whatsapp": {
      "dmPolicy": "pairing",
      "principalBindingPolicy": "invite"
    },
    "discord": {
      "dmPolicy": "open",
      "principalBindingPolicy": "manual"
    },
    "test": {
      "dmPolicy": "open",
      "principalBindingPolicy": "auto-bind-default"
    }
  },
  "seeds": {
    "principalProfiles": {
      "channel:whatsapp:default:+15551234567": {
        "homeSpaceId": "owner",
        "homeAgentId": "main"
      }
    },
    "spaceMembers": {
      "owner": {
        "channel:whatsapp:default:+15551234567": { "role": "owner" }
      }
    },
    "conversationBindings": {
      "channel:discord:main:channel:1234567890": {
        "spaceId": "household",
        "agentId": "main",
        "groupMode": "group-shared"
      }
    }
  }
}
```

Normative notes:

- Seed maps initialize runtime registry once.
- Runtime registry is canonical after first write.
- `roles.guest` is least-privileged; conversational behavior is constrained by routing and dispatch guards.

## Routing Model

## 1) Router Input

Router MUST receive:

- `principalId`
- `surfaceId`
- metadata (`channel`, `accountId`, `peerKind`, `peerId`, `senderId`)
- optional hints (`/me`, `/group`, explicit `threadRef`)

Peer/surface normalization:

- `peerKind` is a closed enum: `dm | group | channel | thread`.
- `channel`, `accountId`, `peerKind`, and `peerId` MUST be trimmed and lowercased before surface construction.
- `surfaceId` format is:
  `channel:{channel}:{accountId}:{peerKind}:{peerId}`.

## 2) Router Output

Router MUST output:

- `spaceId`
- `agentId`
- `threadId`
- `stateId`
- `deliveryTarget` (`same-surface` in this phase)

## 3) Resolution Precedence

1. Explicit trusted `threadRef`.
2. Explicit mode override (`/group`, `/me`).
3. `conversationBindings[surfaceId]`.
4. `principalProfiles[principalId].homeSpaceId`.
5. Onboarding flow for unbound principals.

## 4) Membership Enforcement

Conversation binding does not grant access by itself.

After selecting `selectedSpaceId`, router MUST enforce:

- if principal role is not owner and principal is not a member of `selectedSpaceId`, block routing.

Block reason:

- `not-a-member-of-space`

## 5) Group Threading Modes

Supported modes:

- `group-shared`
- `per-user-in-group`
- `hybrid`

Defaults:

- DM peers: `per-user`
- Group/channel/thread peers: `group-shared`

Mode semantics:

- `group-shared`: all members share one thread for the routed surface.
- `per-user-in-group`: each principal gets a separate thread for the routed surface.
- `hybrid`: default `group-shared`; explicit `/me` switches that turn to per-user behavior.

Delivery behavior in this phase:

- Router MUST return `deliveryTarget = same-surface` for inbound-triggered replies.
- Cross-surface DM redirect behavior is deferred and out of scope for this phase.

## 6) Route Key Construction

Router MUST build `routeTupleV1` with this exact schema:

- `v` (integer literal `1`)
- `spaceId` (normalized lowercase)
- `agentId` (normalized lowercase)
- `surfaceId` (normalized string from Router Input rules)
- `threadMode` (one of supported modes plus `per-user` for DM)
- `actorId` (optional; present only for per-user modes)

Canonical serialization rules:

- keys MUST be serialized in lexicographic order.
- no insignificant whitespace.
- UTF-8 encoding for hash input bytes.
- optional fields MUST be omitted when not present (not `null`).

Storage keying:

- serialize canonical tuple JSON
- compute `routeHash = sha256(utf8(canonicalJson))`
- use `routeHash` as primary key in `threadRoutes`
- store redacted `routeTuple` for observability/debug

If no route exists:

- create `threadId`
- create `stateId = thread:{threadId}`
- persist `threadMeta`
- persist `threadRoutes[routeHash]`

If route exists:

- router SHOULD update `threadMeta.lastActiveAt` on successful resolve (best-effort).

## 7) Router Algorithm (Normative Pseudocode)

```text
function resolveInboundRoute(inbound, context):
  principalId = normalizePrincipalId(inbound)
  surfaceId = normalizeSurfaceId(inbound.channel, inbound.accountId, inbound.peerKind, inbound.peerId)
  peerKind = inbound.peerKind

  if not isAllowedByChannelPolicy(inbound):
    return RouteResult(status="blocked", state="unpaired")

  principalProfile = registry.getPrincipalProfile(principalId)
  if principalProfile is null:
    return handleAllowedUnbound(inbound, surfaceId)

  explicitThreadRef = extractTrustedThreadRef(inbound, context)
  if explicitThreadRef is not null:
    thread = resolveThreadRef(explicitThreadRef, principalId)
    ensureCanReadThread(principalId, thread.spaceId)
    return RouteResult(
      status="ok",
      spaceId=thread.spaceId,
      agentId=thread.agentId,
      threadId=thread.threadId,
      stateId=thread.stateId,
      deliveryTarget=thread.deliveryTarget
    )

  modeHint = parseModeHint(inbound.messageText)  # none|group|me
  conv = registry.getConversationBinding(surfaceId)

  if modeHint == "group" and conv is not null:
    selectedSpaceId = conv.spaceId
    selectedAgentId = conv.agentId or defaultAgentForSpace(selectedSpaceId)
    selectedMode = conv.groupMode or routing.groupDefaultMode
  else if modeHint == "me":
    selectedSpaceId = principalProfile.homeSpaceId
    selectedAgentId = principalProfile.homeAgentId or defaultAgentForSpace(selectedSpaceId)
    selectedMode = "per-user"
  else if peerKind == "dm":
    selectedSpaceId = principalProfile.homeSpaceId
    selectedAgentId = principalProfile.homeAgentId or defaultAgentForSpace(selectedSpaceId)
    selectedMode = routing.dmDefaultMode
  else:
    if conv is null and requiresConversationBinding(inbound.channel, peerKind):
      return RouteResult(status="blocked", state="allowed_unbound", reason="conversation-not-bound")
    selectedSpaceId = conv.spaceId if conv else principalProfile.homeSpaceId
    selectedAgentId = (conv.agentId if conv else principalProfile.homeAgentId) or defaultAgentForSpace(selectedSpaceId)
    selectedMode = (conv.groupMode if conv else routing.groupDefaultMode)

  if not isOwner(principalId) and not registry.isMember(selectedSpaceId, principalId):
    return RouteResult(status="blocked", state="allowed_unbound", reason="not-a-member-of-space")

  actorId = principalId if selectedMode in ["per-user", "per-user-in-group"] else null
  routeTuple = canonicalRouteTupleV1(
    v=1,
    spaceId=selectedSpaceId,
    agentId=selectedAgentId,
    surfaceId=surfaceId,
    threadMode=selectedMode,
    actorId=actorId
  )
  routeHash = sha256(serializeCanonical(routeTuple))

  route = registry.getThreadRoute(routeHash)
  if route is null:
    threadId = newThreadId()
    stateId = "thread:" + threadId
    registry.putThreadMeta(threadId, {
      stateId: stateId,
      spaceId: selectedSpaceId,
      agentId: selectedAgentId,
      createdAt: nowMs(),
      lastActiveAt: nowMs(),
      legacy: false
    })
    registry.putThreadRoute(routeHash, { threadId: threadId, routeTuple: redact(routeTuple) })
  else:
    threadId = route.threadId
    stateId = registry.getThreadMeta(threadId).stateId
    registry.touchThreadMeta(threadId, nowMs())  # best-effort

  deliveryTarget = "same-surface"
  return RouteResult(status="ok", spaceId=selectedSpaceId, agentId=selectedAgentId, threadId=threadId, stateId=stateId, deliveryTarget=deliveryTarget)
```

## Onboarding and Binding Lifecycle

Principal lifecycle states:

1. `unpaired`
2. `allowed_unbound`
3. `bound`

Behavior:

- `unpaired`: no agent routing.
- `allowed_unbound`: registration flow only (invite claim, bind acceptance, minimal status/help responses).
- `bound`: normal routing.

Registration policies per channel:

- `manual`
- `invite`
- `auto-guest`
- `auto-bind-default`

Default onboarding policies:

- `whatsapp`: `invite`
- `discord`: `manual`
- `test`: `auto-bind-default`

## Roles and Authorization

## 1) Binding Shapes

Principal profile:

```json
{
  "principalId": "channel:whatsapp:default:+15551234567",
  "homeSpaceId": "owner",
  "homeAgentId": "main"
}
```

Space membership:

```json
{
  "spaceId": "household",
  "principalId": "channel:whatsapp:default:+15551234567",
  "role": "guest"
}
```

Owner semantics:

- `owner` is an instance-level administrative role.
- In this phase, owner is represented by membership role `owner` and is treated as global admin.
- Owner MAY bypass per-space membership checks for admin/routing operations.

## 2) Effective Policy

For each action:

- `effectivePolicy = rolePolicy ∩ spacePolicy ∩ tokenScopes`
- deny rules MUST override allow rules
- missing allow MUST be treated as deny

## 3) Capability Namespace

Canonical authorization unit is capability ID.

Examples:

- `workspace.read`, `workspace.write`, `workspace.delete`
- `config.read`, `config.write`
- `cron.manage`
- `delivery.reply`
- `message.send`
- `sessions.read`, `sessions.write`
- `threads.read`
- `node.logs.read`, `node.exec`
- `transfer.execute`

`delivery.reply` vs `message.send`:

- `delivery.reply`: system reply in current routed conversation.
- `message.send`: arbitrary/proactive/cross-surface messaging (privileged).

### Native Tool Mapping (minimum)

- `gsv__ReadFile -> workspace.read`
- `gsv__WriteFile -> workspace.write`
- `gsv__EditFile -> workspace.write`
- `gsv__DeleteFile -> workspace.delete`
- `gsv__ConfigGet -> config.read`
- `gsv__LogsGet -> node.logs.read`
- `gsv__Cron -> cron.manage`
- `gsv__Message -> message.send`
- `gsv__SessionsList -> sessions.read`
- `gsv__SessionSend -> sessions.write`
- `gsv__Transfer -> transfer.execute`

## 4) Node Capability Trust Model

- Node capability advertisements are untrusted claims.
- Trusted required capabilities come from gateway policy/config.
- Execution requires both: policy allows capability AND node reports capability.
- Node reports MUST NOT grant permissions by themselves.

## Guest Baseline

Guest defaults MUST be conversation-only:

- no native tool execution
- no node tool routing
- no config/cron/workspace/session-admin RPC methods

Guest memory/archive behavior:

- daily memory extraction MUST be disabled by default
- long-term memory writes MUST be disabled by default
- guest transcript archiving SHOULD be disabled by default (or explicitly short-retention)
- persistence failures in guest mode MUST NOT fail the turn

## Space Storage Layout

```text
gsv-storage/
├── spaces/{spaceId}/agents/{agentId}/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── USER.md
│   ├── MEMORY.md
│   ├── TOOLS.md
│   ├── HEARTBEAT.md
│   ├── BOOTSTRAP.md
│   ├── memory/{YYYY-MM-DD}.md
│   ├── threads/{threadId}/archives/{archiveId}.jsonl.gz
│   └── skills/{skillName}/SKILL.md
├── skills/{skillName}/SKILL.md
└── media/{threadId}/{uuid}.{ext}
```

## Key Safety Rules

- `spaceId` and `agentId` MUST match `[a-z0-9][a-z0-9_-]{0,63}`.
- `threadId` MUST be opaque and URL/path-safe.
- Raw external IDs (phone, peer IDs) MUST NOT be used directly in storage paths.
- Workspace operations MUST be rooted under `spaces/{spaceId}/agents/{agentId}` and reject traversal.

## API and Protocol Changes

Required changes:

- session responses include `threadId` and `stateId`
- chat/session requests accept `threadRef`
- `sessionKey` remains accepted as legacy input during transition
- add binding APIs:
  - principal profile get/put/list
  - space membership add/remove/list
  - conversation binding add/remove/list
  - pending bindings list/resolve
  - invite create/revoke/list

Owner/admin operations MUST support cross-space administration.

## Deployment Bootstrap

Deploy flow MUST initialize:

1. owner space (for example `owner`)
2. owner principal profile (`homeSpaceId=owner`)
3. owner membership in owner space (`role=owner`)
4. owner client token
5. default onboarding policies (`whatsapp=invite`, `discord=manual`, `test=auto-bind-default`)

Node credentials MUST be separate from user principals.

## Migration and Compatibility

## No-Fork Guarantee

Upgrading existing single-space deployments MUST NOT fork active sessions.

## Migration Strategy

1. Introduce `RegistryStore`, thread registry, and legacy resolvers.
2. For legacy references, resolve canonical legacy session key.
3. For inbound routes without explicit legacy input, compute the canonical legacy session key using the pre-thread routing algorithm before creating a native thread.
4. If a legacy mapping exists or can be imported, bind that thread first.
5. Only if no legacy mapping applies, create a new native thread.
6. Create/import `threadMeta` with:
   - stable opaque `threadId`
   - `stateId = legacySession:{canonicalLegacySessionKey}` (metadata form)
   - `legacy = true`
7. Legacy execution identity (`stateDoName`) MUST resolve to the exact pre-existing Session DO name (no rename).
8. Keep executing legacy threads via resolved legacy DO identity.
9. Create new threads with `stateId = thread:{threadId}`.
10. Optionally migrate legacy state to native thread state on reset/archive boundaries.

Compatibility requirements:

- existing CLI/UI flows continue working with legacy references
- each legacy reference resolves deterministically to one `threadId`
- upgrade routing MUST prefer legacy resolution before native thread creation when both are possible

Binding update semantics:

- changing a conversation binding (`spaceId`, `agentId`, or `groupMode`) intentionally changes route identity.
- changed bindings create new route hashes and therefore new threads by default.
- existing threads remain accessible via `threadRef` (`id:{threadId}`).

## Router Defaults by Surface

- WhatsApp DM:
  - select principal home space
  - mode `per-user`
- WhatsApp group:
  - select conversation-bound space
  - mode `group-shared`
- Discord DM:
  - select principal home space
  - mode `per-user`
- Discord guild channel/thread:
  - select conversation-bound space
  - mode `group-shared`
  - block if conversation binding is required but missing

## Observability

Log fields:

- `spaceId`, `threadId`, `stateId`, `principalId`, `surfaceId`, `routeHash`

Must log:

- routing decisions
- binding/membership hits and misses
- onboarding transitions
- authorization allow/deny with rule source
- invite claim outcomes

Metrics:

- `routing.bound`
- `routing.unbound`
- `routing.not_member`
- `authz.allowed`
- `authz.denied`
- `thread.created`
- `thread.resolved_legacy`
- `migration.legacy_thread_bound`

## Testing

## Unit

- route tuple canonicalization and hashing
- routing precedence and membership checks
- capability evaluation (`deny > allow`, default deny)
- threadRef parsing and resolution

## Integration

- no-fork upgrade for legacy active sessions (`stateId=legacySession:*`)
- group-shared vs per-user-in-group behavior
- guest cannot dispatch native/node tools
- invite onboarding from `allowed_unbound` to `bound`

## End-to-End

- WhatsApp DM personal flow
- WhatsApp group shared-space flow
- Discord guild conversation-bound flow
- owner cross-space admin operations

## Acceptance Criteria

- thread identity (`threadId`) is opaque and decoupled from routing strings
- runtime execution identity (`stateId`) supports legacy and native threads
- route hashing uses canonical `routeTupleV1` with explicit schema version
- router deterministically resolves `(spaceId, agentId, threadId, stateId)`
- conversation binding does not bypass membership checks
- principal home context is separate from per-space membership
- authorization is capability-based and enforced at dispatch boundaries
- `delivery.reply` and `message.send` are distinct capabilities
- guest default cannot execute tools and does not persist long-term memory by default
- legacy upgrades do not fork active sessions
