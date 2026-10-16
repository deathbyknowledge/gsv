import { Bash } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import type { SiteResult } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import { testPeer } from "../../../test-support/peers";
import type { publishSiteProject } from "../../../sites/build";
import type { NativeShellCommandOptions } from "./commands";
import { buildSitesCommand } from "./sites";

const head = "a".repeat(40);
const site = { id: `site-${"a".repeat(32)}`, slug: "orbits", origin: "https://orbits.example.net", createdAtMs: 1 };
const published: SiteResult = { site, publication: { revision: 4, releaseId: null, publishedAtMs: null }, manifest: null, shareUrl: "https://person.example/public/orbits" };
type Request = NonNullable<NativeShellCommandOptions["request"]>;

function fixture(calls = ["repo.*", "site.*", "fs.*", "shell.*"], username = "crew") {
  // SAFETY: The command only reads these identity fields; syscall execution is the typed request stub.
  const ctx = {
    peer: testPeer({ account: { uid: 1001, gid: 1000, gids: [1000], username, home: `/home/${username}`, cwd: `/home/${username}` }, calls }),
    callerOwnerUid: 1000,
    auth: { getPasswdByUid: (uid: number) => uid === 1000 ? { uid, username: "person" } : null },
    installationIdentity: { canonicalOrigin: "https://person.example" },
    requestSignal: new AbortController().signal,
  } as KernelContext;
  const request = vi.fn<Request>(async frame => {
    const data = frame.call === "repo.create" ? { repo: "person/orbits", ref: "main", head, created: true }
      : frame.call === "repo.read" ? { repo: "person/orbits", ref: head, path: "", kind: "tree", entries: [] }
      : frame.call === "repo.apply" ? { ok: true, repo: "person/orbits", ref: "main", head: "b".repeat(40) }
      : frame.call === "site.list" ? { sites: [site] }
      : published;
    return { type: "res", id: frame.id, ok: true, data };
  });
  const publish = vi.fn<typeof publishSiteProject>().mockResolvedValue(published);
  const shell = new Bash({ customCommands: [buildSitesCommand(ctx, { request }, publish)] });
  return { ctx, request, shell, publish };
}

describe("sites shell workflow", () => {
  it.each(["ship", "crew"])("%s creates shared owner source in one revision without publishing or running a machine", async username => {
    const { shell, request, publish } = fixture(undefined, username);
    const result = await shell.exec("sites init orbits");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("/src/repos/person/orbits\n");
    expect(request.mock.calls.map(([frame]) => frame.call)).toEqual(["repo.create", "repo.read", "repo.apply"]);
    expect(request.mock.calls[0][0]).toMatchObject({ args: { repo: "person/orbits" } });
    expect(request.mock.calls[1][0]).toMatchObject({ args: { repo: "person/orbits", ref: head } });
    const frame = request.mock.calls[2][0];
    expect(frame).toMatchObject({ args: { repo: "person/orbits", expectedHead: head } });
    if (frame.call !== "repo.apply") throw new Error("Expected repository commit");
    expect(frame.args.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "put", path: "src/App.tsx" }),
      expect.objectContaining({ type: "put", path: "site.json" }),
    ]));
    expect(publish).not.toHaveBeenCalled();
  });

  it("never overwrites an existing project", async () => {
    const { shell, request } = fixture();
    request.mockResolvedValueOnce({ type: "res", id: "create", ok: true, data: { repo: "person/orbits", ref: "main", head, created: false } });
    request.mockResolvedValueOnce({ type: "res", id: "read", ok: true, data: { kind: "tree", entries: [{ name: "index.html" }] } });
    const result = await shell.exec("sites init orbits");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already has files");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("requires every initialization grant before allocating a repository", async () => {
    for (const calls of [["repo.create"], ["repo.create", "repo.read"]]) {
      const { shell, request } = fixture(calls);
      expect((await shell.exec("sites init orbits")).exitCode).toBe(1);
      expect(request).not.toHaveBeenCalled();
    }
  });

  it.each(["ship", "crew"])("%s publishes shared owner source through the build workflow", async username => {
    const { shell, ctx, request, publish } = fixture(undefined, username);
    const result = await shell.exec("sites publish orbits --target cloud-build");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${published.shareUrl}\n`);
    expect(publish).toHaveBeenCalledWith({ repo: "person/orbits", target: "cloud-build" }, ctx, { request }, expect.any(AbortSignal));
    expect(request).not.toHaveBeenCalled();
  });

  it("supports an explicit repository and rejects missing or invalid computer selection", async () => {
    const { shell, publish } = fixture();
    expect((await shell.exec("sites publish owner/project --target cloud-build")).exitCode).toBe(0);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ repo: "owner/project" }), expect.anything(), expect.anything(), expect.anything());
    for (const input of ["sites publish orbits", "sites publish orbits --target gsv", "sites publish --target cloud-build", "sites publish orbits --target one --target two"]) {
      expect((await shell.exec(input)).exitCode).toBe(1);
    }
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("resolves the project from a repository subdirectory", async () => {
    const { shell, publish } = fixture();
    const result = await shell.exec("mkdir -p /src/repos/crew/orbits/src && cd /src/repos/crew/orbits/src && sites publish --target cloud-build");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(publish).toHaveBeenCalledWith({ repo: "crew/orbits", target: "cloud-build" }, expect.anything(), expect.anything(), expect.any(AbortSignal));
  });

  it("does not allocate source after caller cancellation", async () => {
    const { shell, ctx, request } = fixture();
    ctx.requestSignal = AbortSignal.abort(new Error("Cancelled by user"));
    const result = await shell.exec("sites init orbits");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cancelled by user");
    expect(request).not.toHaveBeenCalled();
  });

  it("lists friendly URLs and unpublishes by name while retaining concurrency checks", async () => {
    const { shell, request } = fixture();
    expect((await shell.exec("sites list")).stdout).toBe("orbits\thttps://person.example/public/orbits\n");
    const result = await shell.exec("sites unpublish orbits");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ call: "site.unpublish", args: { siteId: site.id, expectedRevision: 4 } });
    expect(request.mock.calls.some(([frame]) => frame.call === "site.create")).toBe(false);
  });

  it("preserves upstream failure details", async () => {
    const { shell, request } = fixture();
    request.mockResolvedValueOnce({ type: "res", id: "denied", ok: false, error: { code: 403, message: "Publication is unavailable; diagnostic test-123" } });
    const result = await shell.exec("sites list");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Publication is unavailable; diagnostic test-123");
  });
});
