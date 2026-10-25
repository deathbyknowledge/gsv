import assert from "node:assert/strict";
import { test } from "node:test";
import * as protocol from "../dist/protocol.js";

// The derivation's fixed vectors, from the BIP39 entropies of all zeros and of 0x7f repeated.
test("names a sheet by the first 30 bits of its did:key's SHA-256, in Crockford's base32", async () => {
  assert.equal(await protocol.recoverySheetCode("did:key:zDnaewGvRNmdcuZt2bW7LxUWxazHNEUMBQmpF9UqyVVVs19Hk"), "E35-BAN");
  assert.equal(await protocol.recoverySheetCode("did:key:zDnaeawtd1GGcWMADtNZPXHbhGtfX7F3dPFfh116iVeEz62yp"), "PJW-P30");
});

test("writes sheet codes without the letters people misread", async () => {
  for (let index = 0; index < 64; index += 1) {
    assert.match(await protocol.recoverySheetCode(`did:key:z${index}`), /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
  }
});
