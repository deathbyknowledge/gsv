declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown, Props = Record<string, unknown>> {
    constructor(ctx: { props?: Props }, env: Env);
    protected readonly env: Env;
    protected readonly ctx: {
      props?: Props;
    };
  }
}
