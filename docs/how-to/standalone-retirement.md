# Standalone retirement

GSV now deploys one operator stack with public Accounts, Gateway and inference
Workers. Each space has an immutable installation identity, trusted directory
routing and scoped storage. An operator may run one space or many; there is no
separate singleton runtime or per-person messenger application setup.

## Preserved baseline

- [v0.5.0](https://github.com/deathbyknowledge/gsv/releases/tag/v0.5.0) is the
  last published standalone release, at commit
  `9404ea9f51d7d11effd28a9ef1c846b2b6bd4ca1`.
- [compat/standalone-final-2026-09-13](https://github.com/deathbyknowledge/gsv/tree/compat/standalone-final-2026-09-13)
  preserves the final source before removal, at commit
  `cb237d34f1e8ed7c1ee45a1274cc3a28b4a2f12a`. This includes fixes after v0.5.0;
  it is a source snapshot, not a newly published binary release.

The preserved source passed all 18 CI jobs. The published release's seven
downloaded artifact checksums and six archive layouts were verified before
cutover. Those checks do not claim a new live deployment of the old release.

## Existing standalone operators

Do not deploy this revision over a singleton environment. It removes the
standalone Alchemy composition, Wrangler wrapper, unscoped physical routing and
per-person Telegram, Slack and Discord application setup. The previous unofficial
WhatsApp adapter is also removed; WhatsApp Business is separate future work.

Pin the preserved release or source and keep its original deployment state and
resource configuration. Export the data you need and prepare a new environment
using the [operator deployment guide](./deploy-with-alchemy.md). There is no
automatic conversion of old credentials, process identities or unprefixed R2
objects to a new space. The current runtime does not reassign or erase that data.

## Existing operators with scoped spaces

Keep the same resource names, Durable Object namespaces, storage prefixes and
Alchemy state. The cutover preserves those physical identities. Complete any
required [Accounts migration ownership handoff](../../deployment/installation-migration-adoption.md)
and [Mail queue reader upgrade](../../deployment/mail-queue-upgrade.md) before
deploying their dependent writers. Removing standalone does not replace either
upgrade protocol.

Historical adapter namespaces that remain in the deployment exist for owned
inspection and deletion. They cannot start provider connections or accept new
traffic. Their presence does not mean old state has already been erased.

## Retained historical names

The cutover removes executable alternatives, not every historical spelling:

- Shipped migrations, historical upgrade fixtures and design records retain the
  names needed to explain or inspect their original state.
- Existing `wrangler.managed*.jsonc` files and callable `Managed*` aliases may
  remain inputs to an operator composition. They do not select a runtime mode.
- Persisted adapter-link `metadata.managed` identifies generation-fenced peer
  links. Renaming it would require a separate data migration.
- Historical adapter classes are retained only where they own cleanup. Their
  connection and send methods reject new work.
- Unrelated language, such as standalone Unix groups, has no hosting meaning.
