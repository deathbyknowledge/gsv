import { DurableObject } from "cloudflare:workers";

/** Gives tests a SQLite-backed Durable Object to host a repository in. */
export class TestRepoHost extends DurableObject {}

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
