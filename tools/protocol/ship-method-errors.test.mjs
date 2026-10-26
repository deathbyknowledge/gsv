import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkShipMethodErrors } from "./check-ship-method-errors.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INVITATIONS = "workers/gateway/src/kernel/federation/invitations.ts";
const FEDERATION = "workers/gateway/src/kernel/federation.ts";

/** The source with `from` replaced by `to` once, and the line it's on. */
function changed(path, from, to) {
  const source = readFileSync(join(root, path), "utf8");
  const at = source.indexOf(from);
  assert.ok(at >= 0 && source.indexOf(from, at + 1) < 0, `${path} has ${from} once`);
  return { text: source.slice(0, at) + to + source.slice(at + from.length), line: source.slice(0, at).split("\n").length };
}

test("every error a Ship method's handler answers with is declared by its lexicon", () => {
  assert.deepEqual(checkShipMethodErrors(), []);
});

test("an error a handler names that its lexicon doesn't declare is a problem, with where it's thrown", () => {
  const { text, line } = changed(INVITATIONS, `"InvitationExpired", "This invitation has expired"`, `"InvitationLapsed", "This invitation has expired"`);
  assert.deepEqual(checkShipMethodErrors({ overrides: { [INVITATIONS]: text } }), [
    `space.ship.acceptInvitation answers InvitationLapsed (${INVITATIONS}:${line}), which its lexicon doesn't declare`,
  ]);
});

test("a shared refusal is named by its status, for each method that reaches it", () => {
  const { text, line } = changed(FEDERATION, `throw new PublicFederationError(409, "Granted resource is not retained locally")`, `throw new PublicFederationError(410, "Granted resource is not retained locally")`);
  assert.deepEqual(checkShipMethodErrors({ overrides: { [FEDERATION]: text } }), [
    `space.ship.getAttachment answers Gone (${FEDERATION}:${line}), which its lexicon doesn't declare`,
  ]);
});

test("an error whose name the checker can't read is a problem", () => {
  const { text, line } = changed(INVITATIONS, `new ShipXrpcError(410, "InvitationExpired"`, `new ShipXrpcError(410, ["Invitation", "Expired"].join("")`);
  assert.deepEqual(checkShipMethodErrors({ overrides: { [INVITATIONS]: text } }), [
    `${INVITATIONS}:${line} throws a ShipXrpcError whose name isn't a string literal`,
  ]);
});
