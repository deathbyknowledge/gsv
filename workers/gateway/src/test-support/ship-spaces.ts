import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { signServiceAuth } from "@humansandmachines/gsv-pds/src/host/service-auth";
import type { PdsService, PublicRepository, PublicRepositoryAccount } from "@humansandmachines/gsv/services/pds";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import { getKernelByInstallationId } from "../installation/routing";
import type { KernelContext } from "../kernel/context";
import type { Kernel } from "../kernel/do";
import type { ShipIdentity } from "../kernel/ships/identity";
import { SHIP_METHODS } from "../kernel/ships/methods";
import { handleShipXrpc } from "../kernel/ships/xrpc";
import { testPeer } from "./peers";
import { TEST_PDS_URL, type TestDidAccount, type TestShipNetwork } from "./ship-network";

/** Each test space has one person, signed in from a client. */
export const SPACE_OWNER_UID = 1000;

/**
 * A space in a Ship test: a real Kernel with its person, a DID on the test
 * network, and a Gateway at `<name>.ship.test` that serves its Ship methods
 * and names its DID as the handle's.
 */
export type TestSpace = {
  name: string;
  hostname: string;
  account: TestDidAccount;
  installationId: string;
  /** Runs work in the space as its signed-in person; a thrown error comes back as one with the same message. */
  run<T>(work: (ctx: KernelContext, storage: DurableObjectStorage) => T | Promise<T>): Promise<T>;
};

export async function testSpace(network: TestShipNetwork, name: string): Promise<TestSpace> {
  const hostname = `${name}.ship.test`;
  const account = await network.account(hostname);
  const installationId = `inst_${name}_${crypto.randomUUID()}`;
  const person = {
    uid: SPACE_OWNER_UID,
    gid: SPACE_OWNER_UID,
    gids: [100, SPACE_OWNER_UID],
    username: name,
    home: `/home/${name}`,
    cwd: `/home/${name}`,
  };
  await runInDurableObject(await getKernelByInstallationId(env.KERNEL, installationId), async (instance: Kernel) => {
    await instance.ensureInstallationIdentity({ installationId, handle: name, canonicalOrigin: `https://${hostname}` });
    instance.auth.addUser({
      username: name,
      uid: SPACE_OWNER_UID,
      gid: SPACE_OWNER_UID,
      gecos: `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`,
      home: person.home,
      shell: "/bin/init",
    });
    instance.auth.addGroup({ name: "users", gid: 100, members: [name] });
    instance.auth.addGroup({ name, gid: SPACE_OWNER_UID, members: [] });
    instance.auth.setShadow(makeShadowEntry(name, await hashPassword("ship-space-fixture")));
  });
  const space: TestSpace = {
    name,
    hostname,
    account,
    installationId,
    run: async <T>(work: (ctx: KernelContext, storage: DurableObjectStorage) => T | Promise<T>) => {
      // A stub serves only the Durable Object, or test, that made it; another space's call makes its own.
      const kernel = await getKernelByInstallationId(env.KERNEL, installationId);
      const outcome = await runInDurableObject(kernel, async (instance: Kernel, state) => {
        const base = instance.buildKernelContext({
          peer: testPeer({ kind: "human", account: person, calls: ["contact.*", "profile.*", "approach.*"] }),
          callerOwnerUid: SPACE_OWNER_UID,
        });
        const ctx: KernelContext = {
          ...base,
          // SAFETY: contact handlers only check that a direct human connection exists.
          connection: {} as KernelContext["connection"],
          env: { ...base.env, PDS: testPds(space, base.shipIdentity) },
        };
        try {
          return { ok: true as const, value: await work(ctx, state.storage) };
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.value;
    },
  };
  network.hosts.set(hostname, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/atproto-did") return new Response(account.did);
    const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
    const headers = [...request.headers];
    const answer = await space.run(async (ctx) => {
      const response = await handleShipXrpc(new Request(url.href, { method: request.method, headers, body }), ctx, SHIP_METHODS);
      return { status: response.status, headers: [...response.headers], body: await response.arrayBuffer() };
    });
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  });
  return space;
}

/** The space's repository host: its account appears with its first outward act, and it signs as the space's DID. */
function testPds(space: TestSpace, identity: ShipIdentity): PdsService {
  const account: PublicRepositoryAccount = { did: space.account.did, handle: space.hostname, host: TEST_PDS_URL };
  const repository: PublicRepository = {
    ensureAccount: async () => account,
    account: async () => identity.current() ? account : null,
    serviceAuth: async (request) => await signServiceAuth(space.account.did, space.account.signingHex, request),
    applyWrites: async () => {
      throw new Error("This test space publishes no records");
    },
    uploadBlob: async () => {
      throw new Error("This test space publishes no records");
    },
    readBlob: async () => null,
  };
  return { getInstallation: async () => repository };
}
