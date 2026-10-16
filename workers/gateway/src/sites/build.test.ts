import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { bodyFromText, type JsonObject, type SiteManifest, type SiteResult } from "@humansandmachines/gsv/protocol";
import type { NativeShellCommandOptions } from "../drivers/native/shell/commands";
import { GsvFs } from "../fs/gsv-fs";
import { createInstallationStorage } from "../installation/storage";
import type { KernelContext } from "../kernel/context";
import { testPeer } from "../test-support/peers";
import { publishSiteProject } from "./build";

const owner = { uid: 1000, gid: 1000, gids: [1000], username: "alice", home: "/home/alice", cwd: "/home/alice" };
const revision = "a".repeat(40);
const config = { slug: "demo", title: "Demo", description: "Built from saved source", routing: "spa", output: "dist" };
const initial: SiteResult = { site: { id: `site-${"a".repeat(32)}`, slug: "demo", origin: "https://demo.sites.example", createdAtMs: 1 },
  publication: { revision: 7, releaseId: "old", publishedAtMs: 1 }, manifest: null, shareUrl: "https://alice.example/public/demo" };
type Request = NonNullable<NativeShellCommandOptions["request"]>;

function fixture(options: { symlink?: boolean; buildFails?: boolean; abort?: AbortController; abortSource?: AbortController; cleanupFails?: boolean; publicationChanged?: boolean } = {}) {
  const storage = createInstallationStorage(env.STORAGE, `inst_${crypto.randomUUID()}`);
  const fs = new GsvFs(storage, owner);
  const target = new Map<string, Uint8Array>();
  const reads: URL[] = [];
  const cancelSource = vi.fn();
  const sources = new Map([
    ["site.json", new TextEncoder().encode(JSON.stringify(config))],
    ["public/image.bin", new Uint8Array([0, 255, 128, 10])],
    ["package.json", new TextEncoder().encode("{}")],
    ["build.sh", new TextEncoder().encode("#!/bin/sh\n")],
  ]);
  // SAFETY: The native filesystem uses this real scoped storage and explicit account/config fixtures only.
  const ctx = { installationId: "inst_test", peer: testPeer({ account: owner, calls: ["*"] }),
    config: { list: () => [], get: () => null },
    auth: { getPasswdByUid: () => owner, getPasswdByUsername: () => null, isPersonalAgentUid: () => false },
    env: { STORAGE: storage, RIPGIT: { fetch: async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      reads.push(url);
      const path = url.searchParams.get("path") ?? "";
      if (path === "public/image.bin" && options.abortSource) {
        options.abortSource.abort(new Error("caller stopped source copy"));
        return new Response(new ReadableStream<Uint8Array>({ cancel: cancelSource }));
      }
      if (sources.has(path)) return new Response(sources.get(path));
      if (path === "public") return Response.json([{ name: "image.bin", mode: "100644", type: "blob" }]);
      return Response.json([{ name: "site.json", mode: "100644", type: "blob" }, { name: "package.json", mode: "100644", type: "blob" },
        { name: "build.sh", mode: "100755", type: "blob" }, { name: "public", mode: "040000", type: "tree" },
        ...(options.symlink ? [{ name: "outside", mode: "120000", type: "symlink" }] : [])]);
    } } },
  } as KernelContext;
  let manifest: SiteManifest;
  let root = "";
  let activeCommand = "";
  let buildSession = "";
  const request = vi.fn<Request>(async (frame, signal) => {
    signal?.throwIfAborted();
    const reply = (data: JsonObject) => {
      // SAFETY: Each fixture branch supplies the result of its matching request below.
      return { type: "res", id: frame.id, ok: true, data } as Awaited<ReturnType<Request>>;
    };
    if (frame.call === "repo.log") return reply({ repo: "alice/demo", ref: "main", entries: [{ hash: revision }] });
    if (frame.call === "site.create") return reply(initial);
    if (frame.call === "fs.copy") {
      const { source, destination } = frame.args;
      if (source.target === "gsv") {
        expect((await fs.stat(source.path)).mode).toBe(0o600);
        const bytes = await fs.readFileBuffer(source.path);
        target.set(destination.path, bytes);
        return reply({ ok: true, size: bytes.length });
      }
      const bytes = target.get(source.path);
      if (!bytes) throw new Error(`Missing target output ${source.path}`);
      await fs.writeFile(destination.path, bytes);
      return reply({ ok: true, size: bytes.length });
    }
    if (frame.call === "shell.exec") {
      if (frame.args.start) {
        activeCommand = frame.args.input;
        if (activeCommand.startsWith("node ")) buildSession = frame.args.sessionId!;
        return reply({ status: "running", sessionId: frame.args.sessionId, output: "" });
      }
      if (activeCommand.startsWith("node ")) {
        if (options.abort) {
          options.abort.abort(new Error("caller stopped build"));
          signal?.throwIfAborted();
        }
        if (options.buildFails) return reply({ status: "completed", exitCode: 1, output: "npm build failed: missing import" });
        const jobPath = [...target.keys()].find(path => path.endsWith("/job.json"))!;
        root = jobPath.slice(0, -"/job.json".length);
        const job = JSON.parse(new TextDecoder().decode(target.get(jobPath)));
        const html = new TextEncoder().encode(`<script src="${job.base}assets/app.js"></script>`);
        manifest = { ...job.manifest, files: [{ path: "index.html", size: html.length, sha256: "a".repeat(64) }] };
        target.set(`${root}/project/dist/index.html`, html);
      }
      if (activeCommand.startsWith("rm ") && options.cleanupFails) throw new Error("cleanup response lost");
      return reply({ status: "completed", exitCode: 0, output: "" });
    }
    if (frame.call === "shell.cancel") return reply({ sessionId: frame.args.sessionId, cancelled: true });
    if (frame.call === "fs.transfer.send") return { type: "res", id: frame.id, ok: true, data: { ok: true, size: 0 }, body: bodyFromText(JSON.stringify(manifest)) };
    if (frame.call === "site.publish") {
      if (options.publicationChanged) return { type: "res", id: frame.id, ok: false, error: { code: 409, message: "Publication changed; reload before publishing" } };
      return reply({ ...initial, manifest: frame.args.manifest, publication: { revision: 8, releaseId: frame.args.releaseId, publishedAtMs: 2 } });
    }
    throw new Error(`Unexpected request ${frame.call}`);
  });
  return { ctx, fs, request, target, reads, sources, cancelSource, buildSession: () => buildSession };
}

describe("saved site project publication", () => {
  it("copies an exact binary snapshot and keeps publication concurrency and release details inside the workflow", async () => {
    const f = fixture();
    const result = await publishSiteProject({ repo: "alice/demo", target: "computer" }, f.ctx, { request: f.request });
    expect(result.shareUrl).toBe(initial.shareUrl);
    expect(f.reads.every(url => url.searchParams.get("ref") === revision)).toBe(true);
    const binary = [...f.target.entries()].find(([path]) => path.endsWith("/project/public/image.bin"))!;
    expect(binary[1]).toEqual(f.sources.get("public/image.bin"));
    const calls = f.request.mock.calls.map(([frame]) => frame);
    const publish = calls.find(frame => frame.call === "site.publish")!;
    expect(publish).toMatchObject({ args: { expectedRevision: 7, manifest: { source: { repo: "alice/demo", revision }, routing: "spa" } } });
    if (publish.call !== "site.publish") throw new Error("Expected publication");
    const job = JSON.parse(new TextDecoder().decode(f.target.get(binary[0].replace("project/public/image.bin", "job.json"))));
    expect(job.base).toBe(`/_r/${publish.args.releaseId}/`);
    expect(job.executable).toEqual(["build.sh"]);
    expect(await f.fs.exists(publish.args.outputPath)).toBe(false);
    expect(calls.at(-1)).toMatchObject({ call: "shell.exec", args: { input: "" } });
  });

  it("leaves the active publication untouched after build failure or rejected source symlinks", async () => {
    for (const [options, error] of [[{ buildFails: true }, "missing import"], [{ symlink: true }, "symlinks"]] as const) {
      const f = fixture(options);
      await expect(publishSiteProject({ repo: "alice/demo", target: "computer" }, f.ctx, { request: f.request })).rejects.toThrow(error);
      expect(f.request.mock.calls.some(([frame]) => frame.call === "site.publish")).toBe(false);
      expect(f.request.mock.calls.some(([frame]) => frame.call === "shell.exec" && frame.args.input.startsWith("rm -rf"))).toBe(true);
    }
  });

  it("cancels its owned build when the caller aborts before publication", async () => {
    const abort = new AbortController();
    const f = fixture({ abort });
    const cancelOwnedShellSession = vi.fn(async (_sessionId: string, signal: AbortSignal) => signal.throwIfAborted());
    await expect(publishSiteProject({ repo: "alice/demo", target: "computer" }, { ...f.ctx, requestSignal: abort.signal }, { request: f.request, cancelOwnedShellSession }, abort.signal))
      .rejects.toThrow(/caller stopped build;.*Temporary build directory retained/);
    expect(cancelOwnedShellSession).toHaveBeenCalledWith(f.buildSession(), expect.any(AbortSignal));
    expect(cancelOwnedShellSession.mock.calls[0][1].aborted).toBe(false);
    expect(f.request.mock.calls.some(([frame]) => frame.call === "site.publish")).toBe(false);
    expect(f.request.mock.calls.some(([frame]) => frame.call === "shell.exec" && frame.args.input.startsWith("rm "))).toBe(false);
  });

  it("cancels a cleanup session whose response is lost and reports that publication succeeded", async () => {
    const f = fixture({ cleanupFails: true });
    await expect(publishSiteProject({ repo: "alice/demo", target: "computer" }, f.ctx, { request: f.request })).rejects.toThrow(`Published at ${initial.shareUrl}`);
    const cleanup = f.request.mock.calls.find(([frame]) => frame.call === "shell.exec" && frame.args.input.startsWith("rm -rf"))?.[0];
    if (cleanup?.call !== "shell.exec") throw new Error("Expected cleanup command");
    expect(f.request.mock.calls.at(-1)?.[0]).toMatchObject({ call: "shell.cancel", args: { sessionId: cleanup.args.sessionId } });
  });

  it("cancels a waiting source body and never starts the build after cancellation", async () => {
    const abort = new AbortController();
    const f = fixture({ abortSource: abort });
    await expect(publishSiteProject({ repo: "alice/demo", target: "computer" }, f.ctx, { request: f.request }, abort.signal)).rejects.toThrow("caller stopped source copy");
    expect(f.cancelSource).toHaveBeenCalledTimes(1);
    expect(f.buildSession()).toBe("");
    expect(f.request.mock.calls.some(([frame]) => frame.call === "site.publish")).toBe(false);
  });

  it("preserves a newer publication instead of silently retrying activation", async () => {
    const f = fixture({ publicationChanged: true });
    await expect(publishSiteProject({ repo: "alice/demo", target: "computer" }, f.ctx, { request: f.request })).rejects.toThrow("Publication changed");
    const attempts = f.request.mock.calls.filter(([frame]) => frame.call === "site.publish");
    expect(attempts).toHaveLength(1);
    expect(attempts[0][0]).toMatchObject({ args: { expectedRevision: 7 } });
  });

  it("checks the complete build capability set before allocating a publication or target directory", async () => {
    const f = fixture();
    f.ctx.peer = testPeer({ account: owner, calls: ["repo.*", "fs.copy", "fs.read", "site.*", "shell.*"] });
    await expect(publishSiteProject({ repo: "alice/demo", target: "computer" }, f.ctx, { request: f.request })).rejects.toThrow("Permission denied: fs.transfer.send");
    expect(f.request).not.toHaveBeenCalled();
  });
});
