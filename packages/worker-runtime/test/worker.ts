import { DurableObject } from "cloudflare:workers";

export class PortableDoFixture extends DurableObject<Env> {
  readonly testStorage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.testStorage = ctx.storage;
  }
}

export default { fetch: () => new Response("not found", { status: 404 }) };
