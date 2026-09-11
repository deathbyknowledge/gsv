import assert from "node:assert/strict";
import { test } from "node:test";
import {
  installationResetPreparationSchema,
  installationResetPreparedSchema,
} from "../dist/services/lifecycle.js";

const preparation = {
  version: 1,
  operationId: "reset_1",
  previousInstallationId: "inst_old",
  replacementInstallationId: "inst_new",
};

test("reset preparation requires distinct exact installation identities", () => {
  assert.deepEqual(installationResetPreparationSchema.parse(preparation), preparation);
  for (const invalid of [
    { ...preparation, version: 2 },
    { ...preparation, operationId: "" },
    { ...preparation, replacementInstallationId: "../other" },
    { ...preparation, replacementInstallationId: preparation.previousInstallationId },
    { ...preparation, erase: true },
  ]) {
    assert.equal(installationResetPreparationSchema.safeParse(invalid).success, false);
  }
});

test("reset acknowledgment identifies the durable operation and both installations", () => {
  const receipt = { ...preparation, state: "prepared" };
  assert.deepEqual(installationResetPreparedSchema.parse(receipt), receipt);
  assert.equal(installationResetPreparedSchema.safeParse({ state: "prepared" }).success, false);
  assert.equal(installationResetPreparedSchema.safeParse({ ...receipt, state: "pending" }).success, false);
});
