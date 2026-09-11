import { GSVClient } from "@humansandmachines/gsv";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { virtualPasskey } from "../src/test-support/virtual-passkey";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

describe("clean-space passkey authentication", () => {
  let harness: TestHarness;
  let url: string;
  let origin: string;
  const clients: GSVClient[] = [];
  beforeAll(async () => {
    harness = createGatewayTestHarness();
    const address = (await harness.listen()).url;
    address.hostname = "localhost";
    origin = address.origin;
    url = webSocketUrl(address);
  });
  afterAll(async () => { clients.forEach((client) => client.close()); await harness.close(); });

  it("enrolls, signs in after Kernel eviction, revokes the passkey and retains password access", async () => {
    const oneShot = new GSVClient();
    await oneShot.requestOnce(url, "sys.setup", { username: "person", password: "person-password", rootPassword: "root-password" });
    const password = new GSVClient({ url, username: "person", password: "person-password", peer: { id: "password-session" } });
    clients.push(password); await password.connect();
    const begin = await password.account.passkey.register.begin({ label: "Test authenticator" });
    expect(begin.options.rp.id).toBe("localhost");
    const authenticator = await virtualPasskey(begin.options, origin);
    const registered = await password.account.passkey.register.finish({ id: begin.id, response: authenticator.registration });
    expect(registered.id).toBe(authenticator.id);
    await harness.getWorker("gsv").evictDurableObject("KERNEL", { name: "singleton", webSockets: "hibernate" });
    const challenge = await oneShot.requestOnce(url, "account.passkey.authenticate.begin", { username: "person" });
    const response = await authenticator.authenticate(challenge.options);
    const authenticated = await oneShot.requestOnce(url, "account.passkey.authenticate.finish", { id: challenge.id, response });
    const passkey = new GSVClient({ url, username: authenticated.username, token: authenticated.token, peer: { id: "passkey-session" } });
    clients.push(passkey); await passkey.connect();
    expect((await passkey.account.list({})).accounts.find((account) => account.relation === "self")?.uid).toBe(1000);
    await expect(oneShot.requestOnce(url, "account.passkey.authenticate.finish", { id: challenge.id, response })).rejects.toMatchObject({ code: 400 });
    expect(await passkey.account.passkey.revoke({ id: registered.id })).toEqual({ revoked: true });
    expect((await passkey.account.passkey.list({})).passkeys).toHaveLength(0);
    await expect(oneShot.requestOnce(url, "account.passkey.authenticate.begin", { username: "person" })).rejects.toMatchObject({ code: 400 });
    const fallback = new GSVClient({ url, username: "person", password: "person-password", peer: { id: "password-fallback" } });
    clients.push(fallback); await fallback.connect();
    const ledger = await fallback.sys.ledger.list({ callPrefix: "account.passkey", limit: 20 });
    expect(JSON.stringify(ledger)).not.toContain(authenticator.registration.response.attestationObject);
    expect(JSON.stringify(ledger)).not.toContain(response.response.signature);
  });
});
