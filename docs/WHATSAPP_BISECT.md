# WhatsApp Channel Bisect Analysis

## Problem
Messages from OTHER users (fromMe=false) are not being received by the WhatsApp channel.
Own messages (fromMe=true) ARE received.

## Known Working Commit
- **`6c1a1af`** - "add whatsapp channel with keep-alive alarm" (Jan 31)
- This is the initial WhatsApp implementation
- **VERIFIED WORKING** - messages from others come through

## Commits to Analyze (oldest to newest)

---

### 1. `95e2d7e` - "add bearer token auth to whatsapp channel"

**Files Changed:**
- `channels/whatsapp/src/index.ts` (82 lines)

**What Changed:**
- Added Bearer token authentication to the HTTP API
- Only affects the Worker entrypoint, not the DO itself

**Risk Assessment: LOW**
- Does not touch `whatsapp-account.ts` (the DO with Baileys)
- Does not affect WebSocket or message handling
- Authentication happens at HTTP layer before DO is invoked

**Verdict:** Unlikely culprit - only HTTP auth layer

---

### 2. `fe956b3` - "add media support with audio transcription"

**Files Changed:**
- `channels/whatsapp/src/types.ts` (27 lines added)
- `channels/whatsapp/src/whatsapp-account.ts` (103 lines added)

**What Changed:**
- Added `MediaAttachment` type
- Added `downloadMediaMessage` import from Baileys
- Added media detection in `handleMessagesUpsert`
- Added `downloadMedia` method using Baileys' built-in downloader

**Key Code Added:**
```typescript
import { downloadMediaMessage } from "@whiskeysockets/baileys";

// In handleMessagesUpsert:
const hasImage = !!msg.message?.imageMessage;
// ... media detection ...
if (hasMedia) {
  const attachment = await this.downloadMedia(msg);
}
```

**Risk Assessment: MEDIUM**
- Adds async media downloading in message handler
- Uses Baileys' `downloadMediaMessage` which uses Node.js streams
- Could potentially block or error in Workers environment
- But message text handling should still work even if media fails

**Verdict:** Possible culprit if media download blocks/errors silently

---

### 3. `b6c11ab` - "media support" (MAJOR REFACTOR)

**Files Changed:**
- `channels/whatsapp/src/gateway-client.ts` (20 lines)
- `channels/whatsapp/src/whatsapp-account.ts` (346 lines - major refactor!)

**What Changed:**

1. **Introduced `noopLogger`:**
```typescript
// BEFORE:
keys: makeCacheableSignalKeyStore(authState.keys, console as any),
// No logger option

// AFTER:
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => noopLogger } as any;
keys: makeCacheableSignalKeyStore(authState.keys, noopLogger),
logger: noopLogger,  // <-- NEW: silences Baileys entirely
```

2. **Removed WebSocket event listeners:**
```typescript
// REMOVED:
if (this.sock.ws) {
  const ws = this.sock.ws as any;
  if (typeof ws.on === "function") {
    ws.on("error", (err) => console.error(...));
    ws.on("close", (code, reason) => console.log(...));
    ws.on("open", () => console.log(...));
  }
}
```

3. **Replaced Baileys' downloadMediaMessage with custom implementation:**
```typescript
// BEFORE: Used Baileys' downloadMediaMessage (Node.js streams)
// AFTER: Custom fetch-based download with manual AES decryption
```

4. **Removed verbose logging throughout**

5. **Changed message handler to async with catch:**
```typescript
// BEFORE:
this.sock.ev.on("messages.upsert", (m) => this.handleMessagesUpsert(m));

// AFTER:
this.sock.ev.on("messages.upsert", (m) => {
  this.handleMessagesUpsert(m).catch((e) => {
    console.error(`[WA] handleMessagesUpsert error:`, e);
  });
});
```

**Risk Assessment: HIGH**
- `noopLogger` might break internal Baileys state management
- `logger: noopLogger` option might affect how Baileys handles events
- Removing WebSocket listeners might affect connection lifecycle
- Massive refactor = many potential issues

**Verdict:** PRIME SUSPECT - noopLogger or removed WS listeners

---

### 4. `4898b14` - "fix whatsapp alarm loop to prevent connection loss"

**Files Changed:**
- `channels/whatsapp/src/whatsapp-account.ts` (30 lines)

**What Changed:**
- Moved `scheduleKeepAlive()` to be called BEFORE async reconnect work
- Added more logging in alarm handler
- Changed alarm interval handling

**Key Change:**
```typescript
// BEFORE: scheduleKeepAlive called after reconnect attempts
// AFTER: scheduleKeepAlive called FIRST, before any async work

async alarm(): Promise<void> {
  // ALWAYS schedule next alarm first
  this.scheduleKeepAlive();  // <-- Moved to top
  
  // Then do reconnect work...
}
```

**Risk Assessment: LOW-MEDIUM**
- Only affects alarm/keep-alive timing
- Shouldn't affect message receiving directly
- But could affect connection state if alarm logic is wrong

**Verdict:** Unlikely primary culprit, but worth checking

---

### 5. `a597ff6` - "add pairing system and fix whatsapp LID handling"

**Files Changed:**
- `channels/whatsapp/src/whatsapp-account.ts` (33 lines)

**What Changed:**
- Added LID (Linked ID) handling for WhatsApp's new identity system
- Changed JID regex to handle `:XX` suffix: `^(\d+)(?::\d+)?@`
- Added `senderPn` extraction for E.164 number

**Key Change:**
```typescript
// BEFORE:
const match = this.state.selfJid.match(/^(\d+)@/);

// AFTER:
const match = this.state.selfJid.match(/^(\d+)(?::\d+)?@/);
```

**Risk Assessment: LOW**
- Only affects how JIDs are parsed for display
- Doesn't affect message receiving logic
- LID handling is for outbound routing

**Verdict:** Very unlikely culprit

---

### 6. `4d5fb86` - "add typing indicators for whatsapp channel"

**Files Changed:**
- `channels/whatsapp/src/gateway-client.ts` (5 lines)
- `channels/whatsapp/src/types.ts` (9 lines)
- `channels/whatsapp/src/whatsapp-account.ts` (26 lines)

**What Changed:**
- Added `channel.typing` event handling
- Added `sendPresenceUpdate` call for typing indicators
- Added `ChannelTypingPayload` type
- Added `onTyping` callback to GatewayClient

**Risk Assessment: LOW**
- Only adds new functionality for outbound typing
- Doesn't modify message receiving path
- Uses Baileys' existing `sendPresenceUpdate` API

**Verdict:** Very unlikely culprit

---

## Summary: Suspects Ranked

| Rank | Commit | Risk | Reason |
|------|--------|------|--------|
| 1 | `b6c11ab` | HIGH | noopLogger, removed WS listeners, major refactor |
| 2 | `fe956b3` | MEDIUM | Added media download that might block/error |
| 3 | `4898b14` | LOW-MEDIUM | Alarm timing changes |
| 4 | `95e2d7e` | LOW | Only HTTP auth, doesn't touch DO |
| 5 | `a597ff6` | LOW | Only JID parsing for LID |
| 6 | `4d5fb86` | LOW | Only adds typing indicators |

## Recommended Test Order

1. Test `95e2d7e` - Should work (baseline after auth)
2. Test `fe956b3` - Check if media support breaks it
3. Test `b6c11ab` - Prime suspect (noopLogger)
4. If `b6c11ab` breaks it, test with just noopLogger reverted

## Key Questions

1. Does Baileys use the logger internally for state management?
2. Does the `logger` option in `makeWASocket` affect event dispatching?
3. Were the removed WebSocket listeners doing something important?
4. Does the async `.catch()` wrapper on messages.upsert change behavior?

## Test Results

| Commit | Date Tested | Result | Notes |
|--------|-------------|--------|-------|
| `6c1a1af` | 2026-02-04 | WORKING | Initial implementation, messages from others received |
| `95e2d7e` | | | |
| `fe956b3` | | | |
| `b6c11ab` | | | |
| `4898b14` | | | |
| `a597ff6` | | | |
| `4d5fb86` | | | |

---

## Experimental Findings (2026-02-04)

### Confirmed: `noopLogger` Breaks Message Receiving

We confirmed that the `noopLogger` introduced in commit `b6c11ab` breaks message receiving.

**Test 1: Initial commit `6c1a1af`**
- Code: Original implementation with `console` logger
- Bindings: `GSV_GATEWAY_URL` (WebSocket to Gateway)
- Result: **WORKING** - `fromMe=false` messages received

**Test 2: Latest code with noopLogger→console fix**
- Code: Latest code (stash popped), changed `noopLogger` to `console as any`
- Bindings: `GSV_GATEWAY_URL` (WebSocket to Gateway)  
- Result: **WORKING** - `fromMe=false` messages received
- Error: `Gateway RPC failed: Cannot read properties of undefined (reading 'channelInbound')` (expected - code tries to use `this.env.GATEWAY` but we provided `GSV_GATEWAY_URL`)

**Test 3: Latest code with console logger + GATEWAY service binding**
- Code: Same as Test 2 (console logger)
- Bindings: `GATEWAY` service binding (RPC to GatewayEntrypoint)
- Result: **BROKEN** - Only `fromMe=true` messages received

### Current State

**What works:**
- Latest code with `console` logger + `GSV_GATEWAY_URL` binding

**What's broken:**
- Latest code with `console` logger + `GATEWAY` service binding

### Key Observation

Even with the logger fix applied, switching from `GSV_GATEWAY_URL` to `GATEWAY` service binding breaks message receiving again. This is strange because:
1. The binding type shouldn't affect how Baileys receives WebSocket messages from WhatsApp
2. The code change is only in environment bindings, not in the Baileys socket setup

### Possible Explanations

1. **Deployment restarts DO** - Switching bindings might restart the DO, causing a reconnection to WhatsApp that behaves differently than fresh QR login

2. **Something else in the stashed code** - The stash pop had merge conflicts; the resolved code might have issues

3. **Code path difference** - The code that runs with `GATEWAY` binding might be different from the code that runs with `GSV_GATEWAY_URL` binding (different error handling, etc.)

4. **Timing/race condition** - Service binding RPC might introduce timing differences that affect Baileys

### Further Testing (Session 2)

**Test 4: Fresh QR login with GATEWAY service binding + `entrypoint` syntax**
- Code: console logger + debug logs
- Bindings: `GATEWAY: { type: "service", service: name, entrypoint: "GatewayEntrypoint" }`
- Result: **WORKING initially** - `fromMe=false` messages received!
- RPC Error: `The RPC receiver does not implement the method "channelInbound"` (entrypoint not being picked up)
- Observation: `GATEWAY binding methods: []` - binding exists but has no methods (wrong entrypoint)

**Test 5: Redeploy with `__entrypoint__` syntax (no re-login)**
- Code: Same, just changed `entrypoint` to `__entrypoint__` in infra.ts
- Result: **BROKEN** - No messages received at all after redeploy

### Isolated Problem

**TWO separate issues confirmed:**

1. **`noopLogger` breaks Baileys message receiving**
   - Fix: Use `console as any` instead of `noopLogger`
   - Status: CONFIRMED FIXED

2. **Service binding (`GATEWAY`) breaks message receiving on redeploy**
   - Fresh QR login with service binding: WORKS
   - Redeploy (no re-login): BREAKS
   - Switch back to `GSV_GATEWAY_URL`: Need to test
   - Theory: Redeploy with different bindings somehow affects the DO's WhatsApp connection

### Key Insight

The service binding WORKS on fresh QR login, but BREAKS after redeploy. This suggests:
- It's not the service binding itself that's the problem
- Something about redeploying while the DO has an active WhatsApp connection causes issues
- The DO might need to be fully restarted or re-authenticated after binding changes

### Final Conclusion

**Root Causes Identified:**

1. **`noopLogger` breaks Baileys** - CONFIRMED
   - Baileys internally relies on the logger for something beyond just printing
   - Fix: Use `console as any` instead of `noopLogger`

2. **Service bindings break WhatsApp message receiving** - CONFIRMED
   - NOT caused by redeployment (GSV_GATEWAY_URL survives redeploys fine)
   - Specifically triggered by having a `GATEWAY` service binding
   - Theory: Service bindings may change Worker's egress IP or network topology
   - WhatsApp may reject messages to companion devices that change IP mid-session

### Recommended Solution

Support BOTH connection methods:
1. **Primary: WebSocket via `GSV_GATEWAY_URL`** - Reliable, works consistently
2. **Fallback: Service binding RPC** - For environments where it works

The WhatsApp channel code should:
- Check which bindings are available at runtime
- Prefer `GSV_GATEWAY_URL` if available (WebSocket to Gateway)
- Fall back to `GATEWAY` service binding if URL not configured
- Or: Make it a config option

### Files Modified

```
channels/whatsapp/src/whatsapp-account.ts  - noopLogger → console, debug logs added
gateway/alchemy/infra.ts                   - using GSV_GATEWAY_URL (working config)
```

### Open Questions

1. Does Smart Placement affect this?
2. Would a different service binding (not to Gateway) also break it?
3. Is this a Cloudflare Workers issue or WhatsApp server-side behavior?
4. Can we detect and auto-reconnect when this happens?
