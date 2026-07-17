# @humansandmachines/gsv-worker-runtime

Shared Cloudflare Workers runtime primitives for GSV components.

It currently provides versioned Durable Object SQLite migrations and fenced,
journaled logical snapshot/restore helpers used by the gateway, adapters, and
repository runtime. It also provides the provider-neutral inference transport
used when a deployment supplies inference through a service binding. The
helpers implement public runtime mechanics; tenant authorization, provider
resource ownership, rollout policy, and hosted-service control planes remain
outside the package.

The package uses Web and Workers APIs and exposes focused subpaths such as
`@humansandmachines/gsv-worker-runtime/portable-do` and
`@humansandmachines/gsv-worker-runtime/schema`. The inference transport is
available from `@humansandmachines/gsv-worker-runtime/inference-transport`.

## License

MIT
