import { bodyFromText } from "@humansandmachines/gsv/protocol";
import type { OwnerNotice } from "@humansandmachines/gsv/services/owner-confirmations";
import { describe, expect, it } from "vitest";
import { PASSWORD, startProcessRuntimeHarness } from "./process-runtime-harness";

// A sheet's public half from the derivation's fixed vectors.
const SHEET = "did:key:zDnaewGvRNmdcuZt2bW7LxUWxazHNEUMBQmpF9UqyVVVs19Hk";
// The code the stand-in for Accounts emails for every change.
const CODE = "424242";

type Runtime = Awaited<ReturnType<typeof startProcessRuntimeHarness>>;
type FixtureBindings = {
  PDS: { getInstallation(installationId: string): Promise<{ ownerRecoveryKey(): Promise<{ ownerRecoveryKey: string | null; pending: boolean } | null> }> };
  INSTALLATION_OWNER_CONFIRMATIONS: { notices(): Promise<OwnerNotice[]> };
};

describe("the recovery sheet", () => {
  it("is made in the person's session with their password and the emailed code, from the sheet's public half alone", async () => {
    const runtime = await startProcessRuntimeHarness({ pds: true });
    try {
      await runtime.waitFor(async () => (await listed(runtime)) !== null, "the Ship's identity created at sign-in");
      const identity = { did: "did:plc:dddddddddddddddddddddddd", handle: "default.gsv.space" };
      expect(await runtime.client.atproto.recovery.get({})).toEqual({ available: true, identity, sheet: null });

      const sent = await runtime.client.request("atproto.recovery.set", { key: SHEET }, { body: confirmation() });
      expect(sent.data).toMatchObject({ status: "code-sent", to: "o•••@example.com" });
      expect(await listed(runtime)).toEqual({ ownerRecoveryKey: null, pending: false });

      const done = await runtime.client.request("atproto.recovery.set", { key: SHEET }, { body: confirmation(CODE) });
      const sheet = { code: "E35-BAN", madeAt: expect.any(Number), pending: false };
      expect(done.data).toEqual({ status: "done", sheet });
      expect(await listed(runtime)).toEqual({ ownerRecoveryKey: SHEET, pending: false });
      expect(await runtime.client.atproto.recovery.get({})).toEqual({ available: true, identity, sheet });
      const { INSTALLATION_OWNER_CONFIRMATIONS } = await runtime.harness.getWorker<FixtureBindings>("gsv").getEnv();
      expect(await INSTALLATION_OWNER_CONFIRMATIONS.notices()).toEqual([expect.objectContaining({ change: "made", sheetCode: "E35-BAN" })]);
    } finally { await runtime.close(); }
  });
});

function confirmation(code?: string) {
  return bodyFromText(JSON.stringify(code === undefined ? { password: PASSWORD } : { password: PASSWORD, code }));
}

async function listed(runtime: Runtime) {
  const { PDS } = await runtime.harness.getWorker<FixtureBindings>("gsv").getEnv();
  return await (await PDS.getInstallation("inst_integration_default")).ownerRecoveryKey();
}
