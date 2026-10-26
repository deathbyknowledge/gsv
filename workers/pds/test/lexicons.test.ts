import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { fromBase64Url, toBase16, toBase64Url } from "@atcute/multibase";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PdsEnv } from "../src/gsv/env";
import { SHIP_LEXICONS } from "../src/gsv/generated/ship-lexicons";
import { LEXICON_REPOSITORY, publishLexicons, republishLexicons, type ShipLexicon } from "../src/gsv/lexicons";
import { PdsLifecycleEntrypoint } from "../src/gsv/lifecycle";
import { signOperatorToken, type OperatorRequest } from "../src/gsv/operator-token";
import { PdsPublisherEntrypoint } from "../src/gsv/publisher";
import worker from "../src/index";
import { FakeAccounts } from "./accounts";
import { FakePlcDirectory } from "./plc";
import { deliver, errorOf, installFakePlc, read, rejection } from "./support";

const HANDLE = "lexicons.ship.test";
const SCHEMA = "com.atproto.lexicon.schema";
const NSIDS = SHIP_LEXICONS.map((lexicon) => lexicon.id);

const hosted = z.object({ did: z.string(), handle: z.string(), status: z.optional(z.literal("takendown")) });
const status = z.object({ handle: z.string().nullable(), account: hosted.nullable(), pending: z.array(z.string()) });
const published = z.object({ published: z.array(z.string()), pending: z.array(z.string()) });
const record = z.object({ uri: z.string(), cid: z.string(), value: z.record(z.string(), z.json()) });
const latest = z.object({ cid: z.string(), rev: z.string() });

let plc: FakePlcDirectory;
let accounts: FakeAccounts;
let configured: string | undefined;

beforeEach(() => {
  plc = new FakePlcDirectory();
  installFakePlc(plc, env.PLC_URL);
  accounts = new FakeAccounts();
  configured = HANDLE;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A deployment has one lexicon account, so these run in order against the same one.
describe("the deployment's lexicon account", () => {
  it("is refused while the deployment configures no lexicon handle", async () => {
    configured = undefined;
    expect(await errorOf(operator({ aud: env.PDS_ORIGIN, act: "create", handle: HANDLE }))).toBe("LexiconsNotConfigured");
    expect(await errorOf(operator({ aud: env.PDS_ORIGIN, act: "publish" }))).toBe("LexiconsNotConfigured");
    expect(await read(status, operator({ aud: env.PDS_ORIGIN, act: "status" }))).toEqual({ handle: null, account: null, pending: NSIDS });
    expect(await republishLexicons(deployedEnv())).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("is refused for a handle Accounts routes to a Ship", async () => {
    configured = accounts.add().handle;
    expect(await errorOf(operator({ aud: env.PDS_ORIGIN, act: "create", handle: configured }))).toBe("HandleNotAvailable");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("answers only a request the host's rotation key signed for this host, while it lasts", async () => {
    const request: OperatorRequest = { aud: env.PDS_ORIGIN, act: "create", handle: HANDLE };
    const send = (headers: HeadersInit, method = "POST") =>
      worker.fetch(new Request(`${env.PDS_ORIGIN}/operator/lexicons`, { method, headers }), deployedEnv());
    expect(await errorOf(send({}))).toBe("AuthenticationRequired");
    expect(await errorOf(send({ Authorization: "Bearer not-a-token" }))).toBe("InvalidToken");
    for (const token of [
      await signOperatorToken(toBase16(crypto.getRandomValues(new Uint8Array(32))), request),
      await signOperatorToken(env.PLC_ROTATION_KEY, { ...request, aud: "https://pds.elsewhere.test" }),
      await signOperatorToken(env.PLC_ROTATION_KEY, request, Date.now() - 61_000),
      await signOperatorToken(env.PLC_ROTATION_KEY, request, Date.now() + 120_000),
    ]) {
      expect(await errorOf(send({ Authorization: `Bearer ${token}` }))).toBe("InvalidToken");
    }
    const valid = await signOperatorToken(env.PLC_ROTATION_KEY, request);
    const [header = "", payload = "", signature = ""] = valid.split(".");
    // The same signature over claims for another handle.
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    const altered = toBase64Url(new TextEncoder().encode(JSON.stringify({ ...claims, handle: "other.ship.test" })));
    expect(await errorOf(send({ Authorization: `Bearer ${header}.${altered}.${signature}` }))).toBe("InvalidToken");
    expect(await errorOf(send({ Authorization: `Bearer ${valid}` }, "GET"))).toBe("InvalidRequest");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("isn't created on schedule, and has nothing to publish before it exists", async () => {
    await worker.scheduled(createScheduledController(), deployedEnv());
    expect(await errorOf(operator({ aud: env.PDS_ORIGIN, act: "publish" }))).toBe("AccountNotFound");
    expect(await read(status, operator({ aud: env.PDS_ORIGIN, act: "status" }))).toEqual({ handle: HANDLE, account: null, pending: NSIDS });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("is created for the deployment's handle by the operator's request, once", async () => {
    expect(await errorOf(operator({ aud: env.PDS_ORIGIN, act: "create", handle: "other.ship.test" }))).toBe("InvalidHandle");
    expect(await errorOf(operator({ aud: env.PDS_ORIGIN, act: "create" }))).toBe("InvalidHandle");
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const created = await read(status, operator({ aud: env.PDS_ORIGIN, act: "create", handle: HANDLE.toUpperCase() }));
    const did = created.account?.did ?? "";
    expect(created).toEqual({ handle: HANDLE, account: { did: expect.stringMatching(/^did:plc:/), handle: HANDLE }, pending: NSIDS });
    // The account isn't a Ship: its DID names only the PDS that holds its repository.
    expect(plc.operations(did)).toEqual([expect.objectContaining({
      alsoKnownAs: [`at://${HANDLE}`],
      services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: env.PDS_ORIGIN } },
    })]);
    expect(await read(status, operator({ aud: env.PDS_ORIGIN, act: "create", handle: HANDLE }))).toEqual(created);
    expect(plc.operations(did)).toHaveLength(1);
  });

  it("leaves the first publish to the operator", async () => {
    const { did } = await account();
    await deliver(env.REPOS.getByName(LEXICON_REPOSITORY));
    await worker.scheduled(createScheduledController(), deployedEnv());
    expect(await republishLexicons(deployedEnv())).toEqual([]);
    expect(await errorOf(serve("com.atproto.repo.getRecord", { repo: did, collection: SCHEMA, rkey: first().id }))).toBe("RecordNotFound");
    expect((await read(status, operator({ aud: env.PDS_ORIGIN, act: "status" }))).pending).toEqual(NSIDS);
  });

  it("publishes each lexicon as a schema record under its NSID, and rewrites only what changed", async () => {
    const { did } = await account();
    expect(await read(published, operator({ aud: env.PDS_ORIGIN, act: "publish" }))).toEqual({ published: NSIDS, pending: [] });
    await deliver(env.REPOS.getByName(LEXICON_REPOSITORY));
    for (const lexicon of SHIP_LEXICONS) {
      expect((await read(record, serve("com.atproto.repo.getRecord", { repo: HANDLE, collection: SCHEMA, rkey: lexicon.id }))).value)
        .toEqual({ ...lexicon, $type: SCHEMA });
    }
    const commit = await read(latest, serve("com.atproto.sync.getLatestCommit", { did }));
    expect(await read(published, operator({ aud: env.PDS_ORIGIN, act: "publish" }))).toEqual({ published: [], pending: [] });
    expect(await read(latest, serve("com.atproto.sync.getLatestCommit", { did }))).toEqual(commit);

    expect(await publishLexicons(deployedEnv(), revised())).toEqual([first().id]);
    await deliver(env.REPOS.getByName(LEXICON_REPOSITORY));
    expect((await read(record, serve("com.atproto.repo.getRecord", { repo: did, collection: SCHEMA, rkey: first().id }))).value)
      .toMatchObject({ description: "A revised lexicon" });
    expect(await read(latest, serve("com.atproto.sync.getLatestCommit", { did }))).not.toEqual(commit);
  });

  it("publishes each deploy's changes on schedule once the operator has published", async () => {
    expect(await republishLexicons(deployedEnv(), revised())).toEqual([]);
    // This release's lexicons replace the revised one.
    expect((await read(status, operator({ aud: env.PDS_ORIGIN, act: "status" }))).pending).toEqual([first().id]);
    await worker.scheduled(createScheduledController(), deployedEnv());
    expect((await read(status, operator({ aud: env.PDS_ORIGIN, act: "status" }))).pending).toEqual([]);
    expect(await republishLexicons(deployedEnv())).toEqual([]);
  });

  it("never deletes a lexicon that a later release drops", async () => {
    const { did } = await account();
    expect(await publishLexicons(deployedEnv(), SHIP_LEXICONS.slice(1))).toEqual([]);
    await deliver(env.REPOS.getByName(LEXICON_REPOSITORY));
    expect((await read(record, serve("com.atproto.repo.getRecord", { repo: did, collection: SCHEMA, rkey: first().id }))).value)
      .toEqual({ ...first(), $type: SCHEMA });
  });

  it("publishes nothing while the host has the account taken down", async () => {
    const { did } = await account();
    const repo = env.REPOS.getByName(LEXICON_REPOSITORY);
    const subject = { $type: "com.atproto.admin.defs#repoRef", did } as const;
    expect(await publishLexicons(deployedEnv(), revised())).toEqual([first().id]);
    await repo.updateSubjectStatus({ subject, takedown: { applied: true, ref: "lexicon-test" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await errorOf(operator({ aud: env.PDS_ORIGIN, act: "publish" }))).toBe("RepoTakendown");
    await worker.scheduled(createScheduledController(), deployedEnv());
    expect(warn).toHaveBeenCalledExactlyOnceWith("Lexicon publishing is held while the lexicon account is taken down");
    expect(await read(status, operator({ aud: env.PDS_ORIGIN, act: "status" }))).toMatchObject({
      account: { did, status: "takendown" }, pending: [first().id],
    });

    // Lifting the takedown lets the schedule publish what waited.
    await repo.updateSubjectStatus({ subject, takedown: { applied: false } });
    await worker.scheduled(createScheduledController(), deployedEnv());
    expect(warn).toHaveBeenCalledOnce();
    expect(await read(status, operator({ aud: env.PDS_ORIGIN, act: "status" }))).toEqual({
      handle: HANDLE, account: { did, handle: HANDLE }, pending: [],
    });
  });

  it("is served without asking Accounts, since it belongs to no installation", async () => {
    const { did } = await account();
    const resolve = vi.spyOn(accounts, "resolveInstallation");
    expect((await read(record, serve("com.atproto.repo.getRecord", { repo: did, collection: SCHEMA, rkey: first().id }))).uri)
      .toBe(`at://${did}/${SCHEMA}/${first().id}`);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("can't be reached through the Kernel's publishing binding", async () => {
    const publisher = bound(PdsPublisherEntrypoint, "kernel-publish");
    expect(await rejection(publisher.getInstallation(LEXICON_REPOSITORY))).toContain("active installation");
  });

  it("reads as holding no installation's data in deletion discovery", async () => {
    const ship = accounts.add("retained");
    const resource = { kind: "pds-repository", objectId: env.REPOS.idFromName(LEXICON_REPOSITORY).toString() } as const;
    const lifecycle = bound(PdsLifecycleEntrypoint, "installation-deletion");
    expect((await lifecycle.inspectInstallationDeletion({ installationId: ship.installationId, resources: [resource] })).observations)
      .toEqual([{ ...resource, name: LEXICON_REPOSITORY, outcome: "unrelated" }]);
  });

  it("keeps its handle when the deployment later configures another", async () => {
    configured = "lexicons.other.test";
    expect(await errorOf(operator({ aud: env.PDS_ORIGIN, act: "create", handle: configured }))).toBe("AccountExists");
    expect((await account()).handle).toBe(HANDLE);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

function first(): ShipLexicon {
  const [lexicon] = SHIP_LEXICONS;
  if (!lexicon) throw new Error("Expected at least one lexicon");
  return lexicon;
}

/** This release's lexicons, with the first one's description changed as a later release might. */
function revised(): ShipLexicon[] {
  return SHIP_LEXICONS.map((lexicon) => lexicon.id === first().id ? { ...lexicon, description: "A revised lexicon" } : lexicon);
}

async function account(): Promise<z.output<typeof hosted>> {
  const { account } = await read(status, operator({ aud: env.PDS_ORIGIN, act: "status" }));
  if (!account) throw new Error("Expected the lexicon account");
  return account;
}

/** Sends the operator's request, signed with the host's rotation key, to the deployed worker. */
async function operator(request: OperatorRequest): Promise<Response> {
  const token = await signOperatorToken(env.PLC_ROTATION_KEY, request);
  return worker.fetch(new Request(`${env.PDS_ORIGIN}/operator/lexicons`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  }), deployedEnv());
}

/** Sends a public XRPC query to the deployed worker. */
function serve(method: string, params: Record<string, string>): Promise<Response> {
  return worker.fetch(new Request(`${env.PDS_ORIGIN}/xrpc/${method}?${new URLSearchParams(params)}`), deployedEnv());
}

/** An entrypoint as a binding with the given authority sees it. */
function bound<T>(Entrypoint: new (ctx: never, env: never) => T, authority: string): T {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: { authority } });
  // SAFETY: The entrypoints read only their binding props and the host's bindings.
  return new Entrypoint(ctx as never, deployedEnv() as never);
}

function deployedEnv(): PdsEnv {
  return { ...env, INSTALLATION_DIRECTORY: accounts, PDS_LEXICON_HANDLE: configured };
}
