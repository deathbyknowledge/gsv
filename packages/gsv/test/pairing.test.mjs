import assert from "node:assert/strict";
import { test } from "node:test";
import { createPairingSecret, createPairingCredential, encodeDevicePairingCode, decodeDevicePairingCode } from "../dist/protocol.js";

const pairing = { id: "a5918755-0625-4b1a-8772-41243c2f3ea8", targetId: "my-macbook", label: "My macbook · 工作", username: "human", createdAt: 1, expiresAt: 600001, state: "pending" };

test("device invitation round-trips unicode and carries one exact gateway/account/target", () => {
  const secret = createPairingSecret();
  const code = encodeDevicePairingCode("https://gsv.example", pairing, secret);
  assert.match(code, /^gsv-pair1_[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeDevicePairingCode(code), { version: 1, gatewayUrl: "wss://gsv.example/ws", username: "human", id: pairing.id, secret, targetId: "my-macbook", label: pairing.label, expiresAt: 600001 });
  assert.match(createPairingCredential(), /^gsv_machine_[a-f0-9]{64}$/);
  assert.notEqual(createPairingSecret(), secret);
});

test("invalid pairing payloads never echo their contents in errors", () => {
  const base = decodeDevicePairingCode(encodeDevicePairingCode("http://localhost:1234", pairing, createPairingSecret()));
  for (const change of [{ gatewayUrl: "https://secret@gsv.example" }, { targetId: "unsafe; command" }, { secret: "private-value" }, { label: "line\nbreak" }, { version: 2 }]) {
    const raw = "gsv-pair1_" + Buffer.from(JSON.stringify({ ...base, ...change })).toString("base64url");
    assert.throws(() => decodeDevicePairingCode(raw), { message: "Invalid GSV pairing code. Copy a new invitation from GSV." });
  }
});
