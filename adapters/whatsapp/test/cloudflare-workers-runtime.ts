export class DurableObject {}
type TestExecutionContext = {
  readonly fixture?: "worker-entrypoint";
};

export class WorkerEntrypoint<Env = unknown> {
  protected readonly env: Env;

  constructor(_ctx: TestExecutionContext, env: Env) {
    this.env = env;
  }
}
