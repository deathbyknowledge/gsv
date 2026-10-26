import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { createCommandContext, InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GsvFs } from "../../../fs/gsv-fs";
import * as atproto from "../../../kernel/atproto";
import type { KernelContext } from "../../../kernel/context";
import { testPeer } from "../../../test-support/peers";
import { buildAtprotoCommand } from "./atproto";

const OWNER: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000, 100], username: "alice", home: "/home/alice", cwd: "/home/alice" };
const COMMIT = { commit: { cid: "bafycommit", rev: "rev1" }, results: [{ uri: "at://did:plc:alice/com.example.note/first", cid: "bafyrecord" }] };

afterEach(() => vi.restoreAllMocks());

describe("atproto shell command", () => {
  it("gives a record its collection as $type unless it names one", async () => {
    const write = vi.spyOn(atproto, "handleAtprotoWrite").mockResolvedValue(COMMIT);
    const command = buildAtprotoCommand(files({}), context());
    const put = await command.execute(["put", "com.example.note", "first", "--json", '{"text":"hello"}'], shell());
    expect(put).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(put.stdout)).toEqual(COMMIT);
    await command.execute(["create", "com.example.note", "--json", '{"$type":"com.example.other","text":"typed"}'], shell());
    await command.execute(["create", "com.example.note", "--rkey", "chosen", "--json", "{}"], shell());
    await command.execute(["delete", "com.example.note", "first"], shell());
    expect(write.mock.calls.map(([args]) => args)).toEqual([
      { writes: [{ action: "put", collection: "com.example.note", rkey: "first", record: { $type: "com.example.note", text: "hello" } }] },
      { writes: [{ action: "create", collection: "com.example.note", record: { $type: "com.example.other", text: "typed" } }] },
      { writes: [{ action: "create", collection: "com.example.note", rkey: "chosen", record: { $type: "com.example.note" } }] },
      { writes: [{ action: "delete", collection: "com.example.note", rkey: "first" }] },
    ]);
    expect(write.mock.calls[0]![1]).toMatchObject({ peer: context().peer });
  });

  it("applies several writes from a file in one commit", async () => {
    const write = vi.spyOn(atproto, "handleAtprotoWrite").mockResolvedValue(COMMIT);
    const fs = files({ "/home/alice/writes.json": JSON.stringify([
      { action: "put", collection: "com.example.note", rkey: "a", record: { text: "a" } },
      { action: "delete", collection: "com.example.note", rkey: "b" },
    ]) });
    const applied = await buildAtprotoCommand(fs, context()).execute(["apply", "--file", "writes.json"], shell());
    expect(applied.exitCode).toBe(0);
    expect(write).toHaveBeenCalledExactlyOnceWith({ writes: [
      { action: "put", collection: "com.example.note", rkey: "a", record: { $type: "com.example.note", text: "a" } },
      { action: "delete", collection: "com.example.note", rkey: "b" },
    ] }, expect.anything());
  });

  it.each([
    [["put", "com.example.note", "first", "--json", "{oops"], "--json is not valid JSON"],
    [["put", "com.example.note", "first", "--json", "[1]"], "a record must be a JSON object"],
    [["put", "com.example.note", "first"], "give the JSON with either --json or --file"],
    [["put", "com.example.note", "first", "--json", "{}", "--file", "record.json"], "give the JSON with either --json or --file"],
    [["put", "com.example.note", "--json", "{}"], "put requires: atproto put COLLECTION RKEY"],
    [["apply", "--json", "{}"], "apply expects a JSON array of writes"],
    [["apply", "--json", '[{"action":"put","collection":"notes","rkey":"a","record":{}}]'], "Invalid writes"],
    [["delete", "com.example.note", "first", "--force"], "unexpected option: --force"],
  ])("refuses %j without writing", async (args, message) => {
    const write = vi.spyOn(atproto, "handleAtprotoWrite");
    const result = await buildAtprotoCommand(files({}), context()).execute(args, shell());
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain(message);
    expect(write).not.toHaveBeenCalled();
  });

  it("requires the capability for each operation", async () => {
    const write = vi.spyOn(atproto, "handleAtprotoWrite");
    const result = await buildAtprotoCommand(files({}), context(["atproto.identity"]))
      .execute(["delete", "com.example.note", "first"], shell());
    expect(result.stderr).toContain("Permission denied: atproto.write");
    expect(write).not.toHaveBeenCalled();
  });

  it("streams a file upload with its type and size, and cancels the file when the upload is refused", async () => {
    const blob = { $type: "blob" as const, ref: { $link: "bafkreiblob" }, mimeType: "image/png", size: 5 };
    let received = "";
    const upload = vi.spyOn(atproto, "handleAtprotoBlobUpload").mockImplementationOnce(async (_args, _ctx, body) => {
      received = await new Response(body!.stream).text();
      return { blob };
    });
    const fs = files({ "/home/alice/picture.png": "hello" }, "image/png; charset=binary");
    const command = buildAtprotoCommand(fs, context());
    const uploaded = await command.execute(["blob", "picture.png"], shell());
    expect(JSON.parse(uploaded.stdout)).toEqual({ blob });
    expect(received).toBe("hello");
    expect(upload).toHaveBeenCalledWith({ mimeType: "image/png" }, expect.anything(), expect.objectContaining({ length: 5 }));

    const cancel = vi.fn();
    vi.spyOn(fs, "openFile").mockResolvedValueOnce({ body: new ReadableStream({ cancel }), size: 5, totalSize: 5, mtime: new Date(), status: 200 });
    upload.mockRejectedValueOnce(new Error("Your profile is private"));
    const refused = await command.execute(["blob", "picture.png", "--mime", "image/webp"], shell());
    expect(refused.stderr).toContain("Your profile is private");
    expect(upload).toHaveBeenLastCalledWith({ mimeType: "image/webp" }, expect.anything(), expect.anything());
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("prints the Ship's identity", async () => {
    vi.spyOn(atproto, "handleAtprotoIdentity").mockResolvedValue({ identity: null, takedowns: [] });
    const result = await buildAtprotoCommand(files({}), context()).execute(["identity"], shell());
    expect(JSON.parse(result.stdout)).toEqual({ identity: null, takedowns: [] });
  });
});

function context(calls = ["atproto.*"]): KernelContext {
  // SAFETY: the command reads only the caller's grant; the Kernel handlers are mocked.
  return { peer: testPeer({ account: OWNER, calls }) } as KernelContext;
}

function shell() {
  return createCommandContext({ fs: new InMemoryFs(), cwd: "/home/alice" });
}

/** A filesystem holding the given files, which open with the given content type. */
function files(contents: Record<string, string>, contentType?: string): GsvFs {
  const lookup = (path: string) => {
    const content = contents[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
  const fs: Pick<GsvFs, "stat" | "readFile" | "openFile"> = {
    stat: async (path) => ({ isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o644, size: lookup(path).length, mtime: new Date() }),
    readFile: async (path) => lookup(path),
    openFile: async (path) => {
      const content = lookup(path);
      return { body: new Blob([content]).stream(), size: content.length, totalSize: content.length, mtime: new Date(), status: 200, contentType };
    },
  };
  // SAFETY: the command reads files only through these methods.
  return fs as GsvFs;
}
