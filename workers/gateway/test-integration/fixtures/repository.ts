import type { RipgitApplyOp, RipgitTreeEntry } from "../../src/fs/ripgit/client";

type Repository = { revision: number; files: Record<string, number[]> };

/** Minimal durable read/apply fixture so onboarding writes can be read by Process. */
export async function repositoryRequest(request: Request, storage: DurableObjectStorage): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/apply") && request.method === "POST") {
    const input = await request.json<{ ops: RipgitApplyOp[]; expectedHead?: string }>();
    return storage.transaction(async (transaction) => {
      const repo = await transaction.get<Repository>("repository") ?? { revision: 0, files: {} };
      if (input.expectedHead && input.expectedHead !== `revision-${repo.revision}`) {
        return Response.json({ ok: false, conflict: true, error: "ref moved" });
      }
      for (const op of input.ops) {
        if (op.type === "put") repo.files[op.path] = op.contentBytes;
        else if (op.type === "delete") {
          for (const path of Object.keys(repo.files)) {
            if (path === op.path || (op.recursive && path.startsWith(`${op.path}/`))) delete repo.files[path];
          }
        } else if (op.type === "move") {
          const bytes = repo.files[op.from];
          if (bytes) {
            repo.files[op.to] = bytes;
            delete repo.files[op.from];
          }
        }
      }
      repo.revision += 1;
      await transaction.put("repository", repo);
      return Response.json({ ok: true, head: `revision-${repo.revision}` });
    });
  }
  const repo = await storage.get<Repository>("repository");
  if (url.pathname.endsWith("/refs")) {
    return Response.json({ heads: repo ? { main: `revision-${repo.revision}` } : {}, tags: {} });
  }
  const path = url.searchParams.get("path") ?? "";
  const bytes = repo?.files[path];
  if (bytes) return new Response(new Uint8Array(bytes));
  const prefix = path ? `${path}/` : "";
  const entries = new Map<string, RipgitTreeEntry>();
  for (const filename of Object.keys(repo?.files ?? {})) {
    if (!filename.startsWith(prefix)) continue;
    const relative = filename.slice(prefix.length);
    const name = relative.split("/")[0];
    const tree = relative.includes("/");
    entries.set(name, { name, type: tree ? "tree" : "blob", mode: tree ? "040000" : "100644", hash: "fixture" });
  }
  return entries.size
    ? Response.json([...entries.values()])
    : new Response(null, { status: 404 });
}
