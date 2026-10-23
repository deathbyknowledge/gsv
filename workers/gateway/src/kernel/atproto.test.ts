import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { bodyFromText } from "@humansandmachines/gsv/protocol";
import { PUBLIC_BLOB_MAX_BYTES, type PublicRecordWrite, type PublicRepository } from "@humansandmachines/gsv/services/pds";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testPeer } from "../test-support/peers";
import * as processTransport from "../shared/utils";
import { atprotoMissingRequirements, handleAtprotoBlobRead, handleAtprotoBlobUpload, handleAtprotoIdentity, handleAtprotoWrite } from "./atproto";
import type { KernelContext } from "./context";

const OWNER: ProcessIdentity = { uid: 1000, gid: 1000, gids: [100, 1000], username: "alice", home: "/home/alice", cwd: "/home/alice" };
const ACCOUNT = { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", handle: "alice.ship.space", host: "https://pds.ship.space" };
const NOTE: PublicRecordWrite = { action: "put", collection: "space.ship.note", rkey: "first", record: { $type: "space.ship.note", text: "hello" } };
const COMMIT = { commit: { cid: "bafycommit", rev: "3l2" }, results: [{ uri: `at://${ACCOUNT.did}/space.ship.note/first`, cid: "bafyrecord" }] };

afterEach(() => vi.restoreAllMocks());

describe("who publishes", () => {
  it.each([
    ["a delegated process of the same person", { processId: "proc:crew", personal: false }],
    ["a machine", { peer: testPeer({ kind: "machine", account: OWNER }), callerOwnerUid: undefined }],
    ["another account", { humanUid: 1001 }],
    ["a process without a connection's human", { connection: undefined }],
  ])("refuses %s before reaching the repository", async (_label, overrides) => {
    const { ctx, repository, getInstallation } = context(overrides);
    for (const call of [
      () => handleAtprotoIdentity(ctx),
      () => handleAtprotoWrite({ writes: [NOTE] }, ctx),
      () => handleAtprotoBlobUpload({ mimeType: "text/plain" }, ctx, bodyFromText("hi")),
      () => handleAtprotoBlobRead({ cid: "bafkblob" }, ctx),
    ]) {
      await expect(call()).rejects.toThrow("Publishing to the open network requires the signed-in person or their Ship");
    }
    expect(getInstallation).not.toHaveBeenCalled();
    expect(repository.applyWrites).not.toHaveBeenCalled();
  });

  it("tells the shell manual what a caller still needs, and nothing else once the host is missing", () => {
    expect(atprotoMissingRequirements(context({ pds: false, humanUid: 1001 }).ctx)).toEqual(["configured open-network host"]);
    expect(atprotoMissingRequirements(context({ ...shipProcess(), personal: false }).ctx)).toEqual(["the signed-in person or their Ship"]);
    expect(atprotoMissingRequirements(context({ ...shipProcess(), published: false }).ctx)).toEqual(["published profile"]);
    expect(atprotoMissingRequirements(context(shipProcess()).ctx)).toEqual([]);
  });

  it("reports the Ship's identity to the person and their Ship", async () => {
    const human = context();
    expect(await handleAtprotoIdentity(human.ctx)).toEqual({ identity: ACCOUNT });
    expect(human.getInstallation).toHaveBeenCalledExactlyOnceWith("inst_alice");
    expect(human.repository[Symbol.dispose]).toHaveBeenCalledOnce();
    const ship = context({ ...shipProcess(), account: null });
    expect(await handleAtprotoIdentity(ship.ctx)).toEqual({ identity: null });
    expect(ship.repository.ensureAccount).not.toHaveBeenCalled();
  });

  it("says when the deployment has no open-network host", async () => {
    const { ctx } = context({ pds: false });
    await expect(handleAtprotoIdentity(ctx)).rejects.toThrow("isn't available on this deployment");
  });
});

describe("writing records", () => {
  it("asks before the Ship publishes, naming its address, and writes nothing when the person declines", async () => {
    const send = approval(false);
    const { ctx, repository } = context(shipProcess());
    await expect(handleAtprotoWrite({ writes: [NOTE] }, ctx)).rejects.toThrow("Tool execution was not approved: atproto.write");
    expect(send).toHaveBeenCalledExactlyOnceWith("inst_alice", "proc:ship", expect.objectContaining({
      call: "proc.tool.authorize",
      args: expect.objectContaining({
        runId: "run", requestId: "request", syscall: "atproto.write", defaultAction: "ask",
        args: { handle: "alice", address: "alice.ship.space", writes: [NOTE] },
      }),
    }));
    expect(repository.applyWrites).not.toHaveBeenCalled();
    expect(repository.ensureAccount).not.toHaveBeenCalled();
  });

  it("creates the identity on the first approved publish, then commits the writes once", async () => {
    approval(true);
    const { ctx, repository } = context({ ...shipProcess(), account: null });
    expect(await handleAtprotoWrite({ writes: [NOTE] }, ctx)).toEqual(COMMIT);
    expect(repository.ensureAccount).toHaveBeenCalledExactlyOnceWith("alice.ship.space");
    // The Kernel keeps the new DID, so checking incoming calls doesn't wait on the PDS.
    expect(ctx.shipIdentity.remember).toHaveBeenCalledExactlyOnceWith(ACCOUNT.did);
    expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([NOTE]);
    expect(repository[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("does not ask the signed-in person who publishes directly", async () => {
    const send = approval(true);
    const { ctx, repository } = context();
    expect(await handleAtprotoWrite({ writes: [NOTE] }, ctx)).toEqual(COMMIT);
    expect(send).not.toHaveBeenCalled();
    expect(repository.ensureAccount).not.toHaveBeenCalled();
  });

  it("refuses while the profile is private, before asking", async () => {
    const send = approval(true);
    const { ctx, repository } = context({ ...shipProcess(), published: false });
    await expect(handleAtprotoWrite({ writes: [NOTE] }, ctx)).rejects.toThrow("Your profile is private, so your Ship can't publish to the open network");
    expect(send).not.toHaveBeenCalled();
    expect(repository.applyWrites).not.toHaveBeenCalled();
  });

  it("writes nothing when the profile became private while the person decided", async () => {
    const profile = { published: true };
    vi.spyOn(processTransport, "sendFrameToProcess").mockImplementation(async () => {
      profile.published = false;
      return { type: "res", id: "approval", ok: true, data: { approved: true } };
    });
    const { ctx, repository } = context({ ...shipProcess(), profile });
    await expect(handleAtprotoWrite({ writes: [NOTE] }, ctx)).rejects.toThrow("Your profile is private");
    expect(repository.applyWrites).not.toHaveBeenCalled();
  });

  it.each(["space.ship.profile", "Space.SHIP.profile"])("sends %s back to People", async (collection) => {
    const send = approval(true);
    const { ctx, repository } = context(shipProcess());
    await expect(handleAtprotoWrite({ writes: [NOTE, { action: "delete", collection, rkey: "self" }] }, ctx))
      .rejects.toThrow("space.ship.profile is your profile; change it in People");
    expect(send).not.toHaveBeenCalled();
    expect(repository.applyWrites).not.toHaveBeenCalled();
  });

  it("keeps a collection whose name differs only in case", async () => {
    approval(true);
    const { ctx, repository } = context();
    const write: PublicRecordWrite = { action: "delete", collection: "space.ship.Profile", rkey: "self" };
    await handleAtprotoWrite({ writes: [write] }, ctx);
    expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([write]);
  });

  it.each<[string, unknown]>([
    ["no writes", []],
    ["more than ten writes", Array.from({ length: 11 }, () => NOTE)],
    ["a collection that is not an NSID", [{ ...NOTE, collection: "notes" }]],
    ["a reserved record key", [{ ...NOTE, rkey: ".." }]],
    ["a record that is not an object", [{ ...NOTE, record: ["text"] }]],
    ["an unknown field", [{ ...NOTE, cid: "bafy" }]],
  ])("refuses %s before asking", async (_label, writes) => {
    const send = approval(true);
    const { ctx, repository } = context(shipProcess());
    // SAFETY: the handler validates arguments that arrive outside the typed client.
    await expect(handleAtprotoWrite({ writes } as never, ctx)).rejects.toThrow("Invalid writes");
    expect(send).not.toHaveBeenCalled();
    expect(repository.applyWrites).not.toHaveBeenCalled();
  });

  it("asks for a batch only as large as the approval can show", async () => {
    const send = approval(true);
    const { ctx } = context(shipProcess());
    const write = { ...NOTE, record: { $type: "space.ship.note", text: "x".repeat(64 * 1024) } };
    await expect(handleAtprotoWrite({ writes: [write] }, ctx)).rejects.toThrow("exceed 64 KiB");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("files", () => {
  it("streams an upload of the declared size without asking", async () => {
    const send = approval(false);
    const { ctx, repository } = context(shipProcess());
    const blob = { $type: "blob" as const, ref: { $link: "bafkreiblob" }, mimeType: "text/plain", size: 5 };
    let received = "";
    repository.uploadBlob.mockImplementation(async (body, size, mimeType) => {
      received = await new Response(body).text();
      return { ...blob, size, mimeType };
    });
    expect(await handleAtprotoBlobUpload({ mimeType: "text/plain" }, ctx, bodyFromText("hello"))).toEqual({ blob });
    expect(received).toBe("hello");
    expect(repository.uploadBlob).toHaveBeenCalledExactlyOnceWith(expect.any(ReadableStream), 5, "text/plain");
    expect(send).not.toHaveBeenCalled();
  });

  it.each<[string, () => { stream: ReadableStream<Uint8Array>; length?: number } | undefined, string]>([
    ["no body", () => undefined, "requires the file as its request body"],
    ["a body of unknown length", () => ({ stream: bodyFromText("hello").stream }), "of declared length"],
    ["an empty body", () => bodyFromText(""), "The file is empty"],
    ["a body larger than a message attachment", () => ({ stream: bodyFromText("x").stream, length: PUBLIC_BLOB_MAX_BYTES + 1 }), "limited to 48 MiB"],
  ])("refuses %s", async (_label, body, message) => {
    const { ctx, repository } = context();
    await expect(handleAtprotoBlobUpload({ mimeType: "text/plain" }, ctx, body())).rejects.toThrow(message);
    expect(repository.uploadBlob).not.toHaveBeenCalled();
  });

  it("refuses an upload while the profile is private", async () => {
    const { ctx, repository } = context({ published: false });
    await expect(handleAtprotoBlobUpload({ mimeType: "text/plain" }, ctx, bodyFromText("hello"))).rejects.toThrow("Your profile is private");
    expect(repository.uploadBlob).not.toHaveBeenCalled();
  });

  it("reports the repository's refusal of an upload", async () => {
    const { ctx, repository } = context();
    repository.uploadBlob.mockImplementation(async (body) => {
      await body.cancel();
      throw new Error("InvalidRequest: plain is not a MIME type");
    });
    await expect(handleAtprotoBlobUpload({ mimeType: "plain" }, ctx, bodyFromText("hello"))).rejects.toThrow("plain is not a MIME type");
  });

  it("reads a file back with its type and size", async () => {
    const { ctx, repository } = context();
    repository.readBlob.mockResolvedValue({ body: bodyFromText("hello").stream, mimeType: "text/plain", size: 5 });
    const { data, body } = await handleAtprotoBlobRead({ cid: "bafkreiblob" }, ctx);
    expect(data).toEqual({ mimeType: "text/plain", size: 5 });
    expect(body.length).toBe(5);
    expect(await new Response(body.stream).text()).toBe("hello");
    repository.readBlob.mockResolvedValue(null);
    await expect(handleAtprotoBlobRead({ cid: "bafkreimissing" }, ctx)).rejects.toThrow("No file with CID bafkreimissing");
  });
});

type ContextOptions = Partial<KernelContext> & {
  account?: typeof ACCOUNT | null;
  published?: boolean;
  profile?: { published: boolean };
  pds?: boolean;
  /** Whether the calling process is its owner's Ship. */
  personal?: boolean;
  /** The space's personal human account. */
  humanUid?: number;
};

function context(options: ContextOptions = {}) {
  const { account = ACCOUNT, published = true, profile = { published }, pds = true, personal = true, humanUid = OWNER.uid, ...overrides } = options;
  const repository = {
    account: vi.fn<PublicRepository["account"]>(async () => account),
    ensureAccount: vi.fn<PublicRepository["ensureAccount"]>(async () => ACCOUNT),
    applyWrites: vi.fn<PublicRepository["applyWrites"]>(async () => COMMIT),
    uploadBlob: vi.fn<PublicRepository["uploadBlob"]>(),
    readBlob: vi.fn<PublicRepository["readBlob"]>(),
    [Symbol.dispose]: vi.fn(),
  };
  const getInstallation = vi.fn(async () => repository);
  // SAFETY: the handlers use only the caller, process, account, profile, address and binding fields here.
  const ctx = {
    installationId: "inst_alice",
    installationIdentity: { installationId: "inst_alice", canonicalOrigin: "https://alice.gsv.space", handle: "alice" },
    env: { GSV_PUBLIC_CONFIG: JSON.stringify({ primaryDomain: "ship.space" }), ...(pds ? { PDS: { getInstallation } } : undefined) },
    peer: testPeer({ account: OWNER, calls: ["atproto.*"] }),
    callerOwnerUid: OWNER.uid,
    connection: {},
    auth: { getHumanAccount: () => ({ ...OWNER, uid: humanUid }) },
    profiles: { get: (uid: number, origin: string) => uid === OWNER.uid && origin === "https://alice.gsv.space" && profile.published
      ? { published: { url: "https://alice.ship.space/profile", revision: 1, contactPolicy: "requests" } }
      : { revision: 1 } },
    procs: { get: () => ({ isPersonalController: personal, ownerUid: OWNER.uid }), getOwnerUid: () => OWNER.uid },
    requestId: "request",
    defer: vi.fn(),
    shipIdentity: { current: () => null, remember: vi.fn() },
    ...overrides,
  } as KernelContext;
  return { ctx, repository, getInstallation };
}

function shipProcess(): Partial<KernelContext> {
  return { processId: "proc:ship", processRunId: "run", connection: undefined };
}

function approval(approved: boolean) {
  return vi.spyOn(processTransport, "sendFrameToProcess")
    .mockResolvedValue({ type: "res", id: "approval", ok: true, data: { approved } });
}
