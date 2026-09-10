import { describe, expect, it, vi } from "vitest";
import { executeSlackTarget, managedSlackTargetRequestSchema, type SlackTargetResponse } from "./slack-target";
import { SlackTargetFileSystem } from "./slack-target-fs";
import type { FsReadArgs, FsSearchArgs } from "../../../../packages/gsv/src/protocol/syscalls/fs.js";
import type { ShellExecArgs } from "../../../../packages/gsv/src/protocol/syscalls/shell.js";

type TargetOperation =
  | { call: "fs.read"; args: FsReadArgs }
  | { call: "fs.search"; args: FsSearchArgs }
  | { call: "shell.exec"; args: ShellExecArgs };

const CHANNEL = "/conversations/CGENERAL1";
const ROOT_TS = "1700000001.000100";
const REPLY_TS = "1700000002.000100";

function fixture(options: { text?: string; isLimited?: boolean } = {}) {
  const controller = new AbortController();
  const calls: Array<{ method: string; args: Record<string, string>; token: string | null }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").at(-1)!;
    const args = init?.method === "POST" ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams);
    calls.push({ method, args, token: new Headers(init?.headers).get("Authorization") });
    if (method === "conversations.info") {
      if (args.channel === "CSECRET01") return Response.json({ ok: false, error: "channel_not_found" });
      return Response.json({ ok: true, channel: { id: args.channel, name: "general", is_member: true } });
    }
    if (method === "conversations.list") return Response.json({
      ok: true,
      channels: args.cursor ? [{ id: "DOTHER001", is_im: true, user: "UOTHER001" }] : [{ id: "CGENERAL1", name: "general" }],
      response_metadata: { next_cursor: args.cursor ? "" : "channels-next" },
    });
    if (method === "users.list") return Response.json({ ok: true, members: [{ id: "UALICE01", name: "alice" }] });
    if (method === "users.info") return Response.json({ ok: true, user: { id: args.user, name: "alice" } });
    if (method === "conversations.history" || method === "conversations.replies") {
      const ts = args.oldest === REPLY_TS && method === "conversations.replies" ? REPLY_TS : ROOT_TS;
      return Response.json({
        ok: true,
        messages: [{ ts, user: "UALICE01", text: args.cursor ? "older message" : options.text ?? "Literal [release].*\nHello 🦊 café", reply_count: 1 }],
        has_more: !args.cursor && !args.oldest,
        is_limited: options.isLimited,
        response_metadata: { next_cursor: !args.cursor && !args.oldest ? "messages-next" : "" },
      });
    }
    throw new Error(`Unexpected Slack method ${method}`);
  });
  const input = {
    userToken: "xoxp-user-test-token",
    botToken: "xoxb-bot-test-token",
    actorId: "UALICE01",
    botUserId: "UGSVBOT1",
    teamId: "TWORK123",
    teamName: "Acme",
    signal: controller.signal,
    slackFetch: fetcher,
    guard: vi.fn(async () => {}),
  };
  const run = (request: TargetOperation) => executeSlackTarget({
    type: "req", id: "test", deadlineAt: Date.now() + 120_000, ...request,
  }, input);
  return { input, run, calls, controller, fetcher };
}

async function readText(response: SlackTargetResponse): Promise<string> {
  if (!response.ok || !response.body) throw new Error(`Expected a file body: ${JSON.stringify(response)}`);
  return await new Response(response.body.stream).text();
}

describe("Slack target resources", () => {
  it("discovers channels and DMs through complete directory listings and paged indexes", async () => {
    const { run, calls } = fixture();
    expect(await run({ call: "fs.read", args: { path: "/conversations" } })).toMatchObject({
      ok: true, data: { ok: true, files: ["index.json"], directories: ["CGENERAL1", "DOTHER001", "pages"] },
    });
    const first = JSON.parse(await readText(await run({ call: "fs.read", args: { path: "/conversations/index.json" } })));
    expect(first).toMatchObject({ hasMore: true, items: [{ id: "CGENERAL1", path: CHANNEL }] });
    const next = JSON.parse(await readText(await run({ call: "fs.read", args: { path: first.nextPath } })));
    expect(next).toMatchObject({ hasMore: false, nextPath: null, items: [{ id: "DOTHER001", kind: "im" }] });
    expect(calls.every((call) => call.token === "Bearer xoxp-user-test-token")).toBe(true);
  });

  it("reports page coverage and produces a working continuation path", async () => {
    const { run, calls } = fixture();
    const index = JSON.parse(await readText(await run({ call: "fs.read", args: { path: `${CHANNEL}/history/recent/index.json` } })));
    expect(index).toMatchObject({ scope: "page", count: 1, limit: 15, hasMore: true, isLimited: false });
    expect(index.items[0]).toMatchObject({ path: `${CHANNEL}/messages/${ROOT_TS}.json`, threadPath: `${CHANNEL}/threads/${ROOT_TS}` });
    expect(await readText(await run({ call: "fs.read", args: { path: `${index.nextPath}/transcript.txt` } })))
      .toContain("older message");
    const history = calls.filter((call) => call.method === "conversations.history");
    expect(history.map((call) => call.args.limit)).toEqual([15, 15]);
    expect(history[1].args.cursor).toBe("messages-next");
  });

  it("addresses exact messages and replies without returning a neighboring timestamp", async () => {
    const { run, calls } = fixture();
    const path = `${CHANNEL}/threads/${ROOT_TS}/messages/${REPLY_TS}.json`;
    expect(JSON.parse(await readText(await run({ call: "fs.read", args: { path } })))).toMatchObject({ ts: REPLY_TS });
    expect(calls.at(-1)).toMatchObject({ method: "conversations.replies", args: {
      ts: ROOT_TS, oldest: REPLY_TS, latest: REPLY_TS, inclusive: true, limit: 1,
    } });
    expect(await run({ call: "fs.read", args: { path: `${CHANNEL}/messages/1700000099.000100.json` } })).toMatchObject({
      ok: true, data: { ok: false, error: expect.stringContaining("No such Slack message") },
    });
  });

  it("uses one page for all file representations in an invocation", async () => {
    const { input, calls } = fixture();
    const fs = new SlackTargetFileSystem(input);
    await fs.get(`${CHANNEL}/threads/${ROOT_TS}/index.json`);
    const transcript = await fs.get(`${CHANNEL}/threads/${ROOT_TS}/transcript.txt`);
    expect(transcript).toMatchObject({ kind: "file", text: expect.stringContaining("More messages: yes") });
    expect(calls.filter((call) => call.method === "conversations.replies")).toHaveLength(1);
  });

  it("preserves line offsets, byte limits, and valid UTF-8", async () => {
    const { run } = fixture();
    const path = `${CHANNEL}/history/recent/transcript.txt`;
    const first = await run({ call: "fs.read", args: { path, limit: 2 } });
    expect(first).toMatchObject({ data: { lines: 2, truncated: true, nextOffset: 2 } });
    expect((await readText(first)).split("\n")).toHaveLength(2);
    const next = await run({ call: "fs.read", args: { path, offset: 2, limit: 1 } });
    expect(await readText(next)).toMatch(/^More messages:/);
    const unicode = await run({ call: "fs.read", args: { path, offset: 8, limit: 1, maxBytes: 8 } });
    expect(unicode).toMatchObject({ data: { truncated: true } });
    expect(unicode.ok && unicode.data && "nextOffset" in unicode.data).toBe(false);
    expect(await readText(unicode)).toBe("Hello ");
  });

  it("searches literal file content with readable paths", async () => {
    const { run, calls } = fixture();
    const result = await run({ call: "fs.search", args: { path: `${CHANNEL}/history/recent`, query: "[release].*", include: "*.txt" } });
    expect(result).toMatchObject({ data: { ok: true, count: 1, matches: [{
      path: `${CHANNEL}/history/recent/transcript.txt`, line: 8, content: "Literal [release].*",
    }] } });
    expect(calls.filter((call) => call.method === "conversations.history")).toHaveLength(1);
    expect(await run({ call: "fs.search", args: { path: "/", query: "release" } })).toMatchObject({ data: { ok: false, error: expect.stringContaining("workspace-wide") } });
  });

  it("reports provider history restrictions and match truncation independently", async () => {
    const { run } = fixture({ text: "needle\n".repeat(201), isLimited: true });
    const index = JSON.parse(await readText(await run({ call: "fs.read", args: { path: `${CHANNEL}/history/recent/index.json` } })));
    expect(index).toMatchObject({ isLimited: true, hasMore: true });
    const result = await run({ call: "fs.search", args: { path: `${CHANNEL}/history/recent/transcript.txt`, query: "needle" } });
    expect(result).toMatchObject({ data: { ok: true, count: 200, truncated: true } });
  });

  it("rejects invalid continuation paths before calling Slack", async () => {
    const { run, calls } = fixture();
    expect(await run({ call: "fs.read", args: { path: "/users/pages/%%%.json" } })).toMatchObject({ data: { ok: false } });
    expect(calls).toEqual([]);
  });

  it("does not return fetched content after authorization is revoked", async () => {
    const { run, input, fetcher } = fixture();
    const provider = fetcher.getMockImplementation()!;
    let authorized = true;
    input.guard.mockImplementation(async () => {
      if (!authorized) throw new Error("authorization changed");
    });
    fetcher.mockImplementation(async (...args) => {
      const result = await provider(...args);
      authorized = false;
      return result;
    });
    expect(await run({ call: "fs.read", args: { path: "/users/UALICE01.json" } })).toEqual({
      type: "res", id: "test", ok: true, data: { ok: false, error: "authorization changed" },
    });
  });

  it("shares resources with cat, grep, cwd, and ephemeral shell scratch files", async () => {
    const { run, calls } = fixture();
    const result = await run({ call: "shell.exec", args: {
      cwd: `${CHANNEL}/history/recent`,
      input: "cat transcript.txt > /tmp/thread.txt && grep -F 'Hello' /tmp/thread.txt",
    } });
    expect(result).toMatchObject({ data: { status: "completed", output: "Hello 🦊 café\n", exitCode: 0 } });
    expect(calls.filter((call) => call.method === "conversations.history")).toHaveLength(1);
    expect(await run({ call: "shell.exec", args: { input: `echo overwrite > ${CHANNEL}/meta.json` } }))
      .toMatchObject({ data: { status: "failed", error: expect.stringContaining("read-only") } });
    expect(calls.every((call) => !call.method.startsWith("chat."))).toBe(true);
    expect(await run({ call: "shell.exec", args: { input: "cat /tmp/thread.txt" } })).toMatchObject({ data: { status: "failed" } });
  });

  it("never falls back to bot credentials for unreadable resources", async () => {
    const { run, calls } = fixture();
    expect(await run({ call: "fs.read", args: { path: "/conversations/CSECRET01/history/recent/transcript.txt" } }))
      .toMatchObject({ data: { ok: false } });
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBe("Bearer xoxp-user-test-token");
  });

  it("rejects late reads after authorization changes and forwards cancellation to the provider", async () => {
    const { input, run, controller, fetcher } = fixture();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    fetcher.mockImplementationOnce(async (_url, init) => {
      expect(init?.signal).toBe(input.signal);
      started();
      await waiting;
      return Response.json({ ok: true, members: [] });
    });
    const pending = run({ call: "fs.read", args: { path: "/users/index.json" } });
    const rejected = expect(pending).rejects.toThrow("cancelled read");
    await entered;
    controller.abort(new Error("cancelled read"));
    release();
    await rejected;
  });

  it("fails instead of returning a partial directory when pagination does not terminate", async () => {
    const { run, fetcher } = fixture();
    fetcher.mockImplementation(async () => Response.json({
      ok: true, channels: [], response_metadata: { next_cursor: "same-cursor" },
    }));
    expect(await run({ call: "fs.read", args: { path: "/conversations" } })).toMatchObject({ data: {
      ok: false, error: expect.stringContaining("/conversations/index.json"),
    } });
  });

  it("validates the filesystem boundary before routing", () => {
    const frame = { type: "req", id: "test", deadlineAt: 1, call: "fs.read", args: { path: "/workspace.json" } };
    expect(managedSlackTargetRequestSchema.safeParse(frame).success).toBe(true);
    for (const changed of [
      { ...frame, call: "fs.write" },
      { ...frame, id: "   " },
      { ...frame, args: { path: "/workspace.json", offset: -1 } },
      { ...frame, args: { path: "/workspace.json", token: "xoxb-untrusted" } },
      { ...frame, args: { path: "bad\0path" } },
      { ...frame, body: {} },
    ]) expect(managedSlackTargetRequestSchema.safeParse(changed).success).toBe(false);
  });
});
