import { DurableObject } from "cloudflare:workers";

export { HostFirehose } from "../src/host/firehose";
export { HostedRepo } from "../src/host/repo";

/** Gives engine tests a SQLite-backed Durable Object to host a bare repository in. */
export class TestRepoHost extends DurableObject {}

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
