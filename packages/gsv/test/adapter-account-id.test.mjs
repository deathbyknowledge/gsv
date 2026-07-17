import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ADAPTER_ACCOUNT_ID_LENGTH,
  normalizeAdapterAccountId,
} from "../dist/protocol.js";

test("normalizes bounded adapter account IDs without restricting provider syntax", () => {
  assert.equal(
    normalizeAdapterAccountId(" 15551234567:4@s.whatsapp.net/device "),
    "15551234567:4@s.whatsapp.net/device",
  );
  assert.equal(normalizeAdapterAccountId("telegram/アカウント"), "telegram/アカウント");
});

test("rejects empty, control-character, and oversized adapter account IDs", () => {
  assert.equal(normalizeAdapterAccountId("  "), null);
  assert.equal(normalizeAdapterAccountId("account\u0000id"), null);
  assert.equal(normalizeAdapterAccountId("x".repeat(MAX_ADAPTER_ACCOUNT_ID_LENGTH + 1)), null);
  assert.equal(normalizeAdapterAccountId({ accountId: "primary" }), null);
});
