import * as z from "zod/mini";
import { bodyToBytes, cancelBinaryBody, siteFilePathSchema, siteSlugSchema,
  type ArgsOf, type ResultOf, type SiteManifest, type SiteResult, type SyscallName } from "@humansandmachines/gsv/protocol";
import { createNativeFileSystem } from "../drivers/native/filesystem";
import { requireCommandCapability } from "../drivers/native/shell/common";
import type { NativeShellCommandOptions } from "../drivers/native/shell/commands";
import { RipgitClient } from "../fs/ripgit/client";
import type { KernelContext } from "../kernel/context";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import { SITE_BUILD_HELPER } from "./node-helper";
import { validateSiteManifest } from "./storage";

const projectSchema = z.strictObject({
  slug: siteSlugSchema,
  title: z.string().check(z.minLength(1), z.maxLength(160)),
  description: z.string().check(z.maxLength(400)),
  routing: z.enum(["static", "spa"]),
  output: z.literal("dist"),
  image: z.optional(siteFilePathSchema),
});
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 300_000;

/** Builds a pinned repository snapshot on a computer and activates it through the ordinary publisher. */
export async function publishSiteProject(
  input: { repo: string; target: string }, ctx: KernelContext, options: NativeShellCommandOptions, signal?: AbortSignal,
): Promise<SiteResult> {
  const request = options.request;
  if (!request) throw new Error("Site publication requires Kernel request support");
  if (!input.target.trim() || input.target === "gsv") throw new Error("Choose a Linux computer to build the site");
  for (const capability of ["repo.read", "repo.log", "fs.copy", "fs.read", "fs.transfer.send", "site.create", "site.publish", "shell.exec", "shell.cancel"]) {
    requireCommandCapability(ctx, capability);
  }
  const signals = [AbortSignal.timeout(BUILD_TIMEOUT_MS)];
  if (ctx.requestSignal) signals.push(ctx.requestSignal);
  if (signal) signals.push(signal);
  const activeSignal = AbortSignal.any(signals);
  const call = async <S extends SyscallName>(name: S, args: ArgsOf<S>, requestSignal = activeSignal): Promise<ResultOf<S>> => {
    requestSignal.throwIfAborted();
    // SAFETY: The call and arguments share S; dispatch returns the matching response contract.
    const frame = { type: "req", id: crypto.randomUUID(), call: name, args } as RequestFrame;
    const response = await request(frame, requestSignal);
    if (!response.ok) throw new Error(response.error.message);
    await cancelBinaryBody(response.body, "Site orchestration expects metadata from this syscall");
    // SAFETY: The typed request above determines this response's data type.
    return response.data as ResultOf<S>;
  };
  const source = await call("repo.log", { repo: input.repo, limit: 1 });
  const revision = source.entries[0]?.hash;
  if (!revision || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Source repository has no committed revision");
  const [owner, repo] = source.repo.split("/");
  const sourceRef = { owner, repo, branch: revision };
  const ripgit = new RipgitClient(ctx.env.RIPGIT);
  const readOptions = { maxBytes: MAX_SOURCE_FILE_BYTES, signal: activeSignal };
  const configuration = await ripgit.readPath(sourceRef, "site.json", readOptions);
  if (configuration.kind !== "file" || configuration.bytes.length > 16_384) throw new Error("Repository needs a small site.json project file");
  const project = projectSchema.parse(JSON.parse(new TextDecoder().decode(configuration.bytes)));
  const created = await call("site.create", { slug: project.slug });
  const releaseId = crypto.randomUUID();
  const root = `/tmp/gsv-site-${releaseId}`;
  const fs = createNativeFileSystem(ctx);
  const metadata: Omit<SiteManifest, "files"> = { version: 1, entry: "index.html", routing: project.routing, title: project.title,
    description: project.description, source: { repo: source.repo, revision } };
  if (project.image) metadata.image = project.image;
  let sessionId: string | undefined;
  let targetTouched = false;
  let published: SiteResult | undefined;
  let failure: Error | undefined;
  const cleanupErrors: Error[] = [];
  const run = async (command: string, requestSignal = activeSignal, timeout = BUILD_TIMEOUT_MS) => {
    sessionId = crypto.randomUUID();
    let output = "";
    let result = await call("shell.exec", { target: input.target, input: command, sessionId, start: true, timeout }, requestSignal);
    while (result.status === "running") {
      output = (output + result.output).slice(-8192);
      result = await call("shell.exec", { target: input.target, input: "", sessionId, yieldMs: 1000 }, requestSignal);
    }
    sessionId = undefined;
    if (result.status !== "completed" || result.exitCode !== 0) {
      throw new Error(`Site build command failed: ${result.status === "failed" ? `${result.error}\n` : ""}${(output + result.output).slice(-8192)}`);
    }
  };
  const copy = async (sourceTarget: string, sourcePath: string, destinationTarget: string, destinationPath: string) => {
    const result = await call("fs.copy", { source: { target: sourceTarget, path: sourcePath }, destination: { target: destinationTarget, path: destinationPath } });
    if (!result.ok) throw new Error(result.error);
    return result;
  };
  const privateFile = async (path: string) => {
    await fs.writeFile(path, "");
    await fs.chmod(path, 0o600);
  };
  try {
    activeSignal.throwIfAborted();
    await fs.mkdir(root, { recursive: true });
    await privateFile(`${root}/source.bin`);
    targetTouched = true;
    await run(`umask 077; mkdir -m 700 -- '${root}' && mkdir -- '${root}/project'`);
    let sourceBytes = 0;
    let entries = 0;
    const executable: string[] = [];
    const copySource = async (path: string, depth: number): Promise<void> => {
      activeSignal.throwIfAborted();
      if (depth > 32 || ++entries > 2048) throw new Error("Source repository has too many entries");
      const content = await ripgit.readPath(sourceRef, path, readOptions);
      if (content.kind === "tree") {
        for (const entry of content.entries) {
          if (entry.type === "symlink" || (entry.type === "blob" && !["100644", "100755"].includes(entry.mode))) throw new Error("Site source cannot contain symlinks or special files");
          if (entry.name.includes("/")) throw new Error("Invalid source repository path");
          const relative = siteFilePathSchema.parse(path ? `${path}/${entry.name}` : entry.name);
          if (entry.mode === "100755") executable.push(relative);
          await copySource(relative, depth + 1);
        }
        return;
      }
      if (content.kind !== "file") throw new Error("Source revision became unavailable");
      sourceBytes += content.bytes.length;
      if (sourceBytes > 64 * 1024 * 1024) throw new Error("Site source exceeds 64 MiB");
      await fs.writeFile(`${root}/source.bin`, content.bytes);
      await copy("gsv", `${root}/source.bin`, input.target, `${root}/project/${path}`);
    };
    await copySource("", 0);
    for (const [name, content] of [["helper.mjs", SITE_BUILD_HELPER], ["job.json", JSON.stringify({ base: `/_r/${releaseId}/`, manifest: metadata, executable })]]) {
      await privateFile(`${root}/${name}`);
      await fs.writeFile(`${root}/${name}`, content);
      await copy("gsv", `${root}/${name}`, input.target, `${root}/${name}`);
    }
    await run(`node '${root}/helper.mjs' '${root}'`);
    // SAFETY: This exact syscall determines the response contract; its body is consumed below.
    const response = await request({ type: "req", id: crypto.randomUUID(), call: "fs.transfer.send", args: { target: input.target, path: `${root}/manifest.json` } }, activeSignal) as ResponseFrame<"fs.transfer.send">;
    if (!response.ok) throw new Error(response.error.message);
    if (!response.data?.ok || !response.body) {
      await cancelBinaryBody(response.body, "Site build did not return a manifest");
      throw new Error("Site build did not return a manifest");
    }
    const generated = validateSiteManifest(JSON.parse(new TextDecoder().decode(await bodyToBytes(response.body, 512 * 1024, activeSignal))));
    const manifest = validateSiteManifest({ ...metadata, files: generated.files });
    await fs.mkdir(`${root}/output`, { recursive: true });
    for (const file of manifest.files) {
      await fs.mkdir(`${root}/output/${file.path.slice(0, file.path.lastIndexOf("/") + 1)}`, { recursive: true });
      await privateFile(`${root}/output/${file.path}`);
      const copied = await copy(input.target, `${root}/project/dist/${file.path}`, "gsv", `${root}/output/${file.path}`);
      if (copied.size !== file.size) throw new Error("Build output changed before publication");
    }
    published = await call("site.publish", { siteId: created.site.id, expectedRevision: created.publication.revision,
      releaseId, outputPath: `${root}/output`, manifest });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    const cancelOwnedCommand = async () => {
      if (!sessionId) return;
      try {
        if (options.cancelOwnedShellSession) await options.cancelOwnedShellSession(sessionId, AbortSignal.timeout(10_000));
        else await call("shell.cancel", { target: input.target, sessionId }, AbortSignal.timeout(10_000));
        sessionId = undefined;
      } catch (error) { cleanupErrors.push(new Error(`Could not cancel site command; target directory retained at ${root}: ${String(error)}`)); }
    };
    await cancelOwnedCommand();
    if (targetTouched && activeSignal.aborted) {
      cleanupErrors.push(new Error(`Temporary build directory retained on ${input.target}: ${root}`));
    } else if (targetTouched && !sessionId) {
      try { await run(`rm -rf -- '${root}'`, AbortSignal.timeout(10_000), 10_000); }
      catch (error) { cleanupErrors.push(new Error(`Could not remove target build directory ${root}: ${String(error)}`)); }
      await cancelOwnedCommand();
    }
    try { await fs.rm(root, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(new Error(`Could not remove local build directory ${root}: ${String(error)}`)); }
  }
  if (cleanupErrors.length) {
    throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
      `${published ? `Published at ${published.shareUrl}; ` : failure ? `${failure.message}; ` : ""}${cleanupErrors.map(error => error.message).join("; ")}`);
  }
  if (failure) throw failure;
  if (!published) throw new Error("Site publication did not complete");
  return published;
}
