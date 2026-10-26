import { GSVClient } from "@humansandmachines/gsv";
import { bodyFromText, type AtprotoRecoverySetResult } from "@humansandmachines/gsv/protocol";
import type { OwnerNotice } from "@humansandmachines/gsv/services/owner-confirmations";
import { describe, expect, it } from "vitest";
import { socketFrom } from "./harness";
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

  it("waits, even for the right password, after wrong passwords signing in from the session's address", async () => {
    const runtime = await startProcessRuntimeHarness({ pds: true });
    const people = sessions(runtime);
    try {
      await runtime.waitFor(async () => (await listed(runtime)) !== null, "the Ship's identity created at sign-in");
      const person = await people.signIn("198.51.100.7");
      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(people.signIn("198.51.100.7", `wrong-${attempt}`)).rejects.toMatchObject({ code: 401 });
      }
      expectWait(await change(person));
      expect(await listed(runtime)).toEqual({ ownerRecoveryKey: null, pending: false });
    } finally { people.close(); await runtime.close(); }
  });

  it("makes signing in from the session's address wait after its wrong passwords, and leaves other addresses alone", async () => {
    const runtime = await startProcessRuntimeHarness({ pds: true });
    const people = sessions(runtime);
    try {
      await runtime.waitFor(async () => (await listed(runtime)) !== null, "the Ship's identity created at sign-in");
      const person = await people.signIn("198.51.100.8");
      for (let attempt = 0; attempt < 5; attempt++) {
        expect(await change(person, `wrong-${attempt}`)).toEqual({ status: "refused", reason: "password" });
      }
      await expect(people.signIn("198.51.100.8")).rejects.toMatchObject({ code: 429, message: expect.stringContaining("Too many sign-in attempts") });
      expectWait(await change(person));
      await expect(people.signIn("198.51.100.9")).resolves.toBeInstanceOf(GSVClient);
    } finally { people.close(); await runtime.close(); }
  });
});

function confirmation(code?: string, password = PASSWORD) {
  return bodyFromText(JSON.stringify(code === undefined ? { password } : { password, code }));
}

async function change(person: GSVClient, password = PASSWORD): Promise<AtprotoRecoverySetResult> {
  return (await person.request("atproto.recovery.set", { key: SHEET }, { body: confirmation(undefined, password) })).data;
}

/** The answer to an attempt that sign-in pacing holds for its first wait, of 30 seconds. */
function expectWait(result: AtprotoRecoverySetResult) {
  expect(result).toEqual({ status: "refused", reason: "attempts", retryAt: expect.any(Number) });
  const waitMs = result.status === "refused" && result.reason === "attempts" ? result.retryAt - Date.now() : 0;
  expect(waitMs).toBeGreaterThan(20_000);
  expect(waitMs).toBeLessThanOrEqual(30_000);
}

/** The person signing in to the runtime's Ship from one address or another, each in a session of its own. */
function sessions(runtime: Runtime) {
  const clients: GSVClient[] = [];
  return {
    async signIn(address: string, password = PASSWORD): Promise<GSVClient> {
      const client = new GSVClient({
        url: runtime.client.getStatus().url ?? undefined,
        password,
        peer: { id: `person-${clients.length}`, version: "1.0.0", platform: "node" },
        WebSocket: socketFrom(address),
      });
      clients.push(client);
      await client.connect();
      return client;
    },
    close() {
      for (const client of clients) client.close();
    },
  };
}

async function listed(runtime: Runtime) {
  const { PDS } = await runtime.harness.getWorker<FixtureBindings>("gsv").getEnv();
  return await (await PDS.getInstallation("inst_integration_default")).ownerRecoveryKey();
}
