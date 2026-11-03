import { WorkerEntrypoint } from "cloudflare:workers";

const REPOSITORY_ACTION = /^\/hyperspace\/repos\/[^/]+\/[^/]+\/(refs|read|apply)$/;
const RETIREMENT_ACTION = /^\/\.gsv\/installation\/(quiesce|erase)$/;

/**
 * Unit-test ripgit: every repository is empty, every write is accepted and
 * forgotten, and an installation with no repositories retires at once.
 * Tests that inspect repository contents or retirement bind their own fake.
 */
export async function answerFromEmptyRipgit(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const retirement = RETIREMENT_ACTION.exec(path)?.[1];
  if (retirement) {
    const { installationId, operationId } = await request.json<{ installationId: string; operationId: string }>();
    const phase = retirement === "quiesce" ? "quiesced" : "live-erased";
    return Response.json({ version: 1, installationId, operationId, phase, pendingResources: 0 });
  }
  switch (REPOSITORY_ACTION.exec(path)?.[1]) {
    case "refs":
      return Response.json({ heads: {}, tags: {} });
    case "read":
      return new Response("missing", { status: 404 });
    case "apply":
      await request.body?.cancel();
      return Response.json({ ok: true, head: "test-head" });
    default:
      await request.body?.cancel();
      return new Response("Unit-test ripgit serves only refs, reads, applies and retirement", { status: 501 });
  }
}

/** The unit-test Worker's RIPGIT binding; never deployed. */
export class TestRipgit extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    return await answerFromEmptyRipgit(request);
  }
}
