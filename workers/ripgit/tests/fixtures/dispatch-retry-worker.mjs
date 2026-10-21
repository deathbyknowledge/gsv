import ripgit from "../../build/index.js";

// Run the compiled Rust dispatcher against a binding that fails before delivery.
export default {
  async fetch(request, env, ctx) {
    const scenario = JSON.parse(request.headers.get("x-fixture-scenario"));
    const attempts = [];
    let stubs = 0;
    let registrations = 0;
    class DurableObjectNamespace {
      idFromName(name) { return { name }; }
      get(id) {
        if (id.name.startsWith("installation-index:")) {
          return { async fetch() { registrations++; return new Response(null, { status: 204 }); } };
        }
        const stub = ++stubs;
        let used = false;
        return {
          async fetch(incoming) {
            if (used) throw new Error("broken stub reused");
            used = true;
            attempts.push({ stub, name: id.name, method: incoming.method, path: new URL(incoming.url).pathname,
              installation: incoming.headers.get("x-gsv-installation-id"), body: await incoming.text(), at: Date.now() });
            if (attempts.length <= scenario.failures) {
              if (scenario.httpStatus) return new Response("upstream response", { status: scenario.httpStatus });
              const error = new Error(scenario.message ?? "internal error; reference = fixture123");
              for (const key of ["retryable", "overloaded", "remote"]) {
                if (scenario[key] !== undefined) error[key] = scenario[key];
              }
              throw error;
            }
            return new Response(incoming.method === "HEAD" ? null : "fixture success");
          },
        };
      }
    }
    let outcome;
    const diagnostics = [];
    const originalError = console.error;
    console.error = (...args) => diagnostics.push(args.map(String).join(" "));
    try {
      const method = request.headers.get("x-fixture-method");
      const forwarded = new Request(request.url, { method, headers: request.headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: request.body }) });
      const response = await new ripgit(ctx, { ...env, REPOSITORY: new DurableObjectNamespace() }).fetch(forwarded);
      outcome = { status: response.status, body: await response.text() };
    } catch (error) {
      outcome = { error: String(error) };
    } finally {
      console.error = originalError;
    }
    return Response.json({ attempts, stubs, registrations, outcome, diagnostics });
  },
};
