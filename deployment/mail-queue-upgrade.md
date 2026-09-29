# Upgrade an existing outbound mail queue

Existing deployments with the Mail service require two completed deployments
before Gateway can write version-2 queue messages. Fresh stacks can deploy the
final version directly.

Version 1 includes a draft fingerprint. Version 2 carries only the version,
immutable installation ID and outbound ID; Mail resolves the fingerprint from
the owning Kernel through the trusted Gateway binding. An old Mail reader
silently acknowledges unsupported version-2 messages, losing their queue
notification. Alchemy updates existing Workers concurrently, so applying the
final version in one deployment does not enforce reader-before-writer order.

## Prerequisites

This bridge is part of the hosting consolidation, not a shortcut around its
migration requirements. Operators adopting legacy Accounts, including H&M,
must complete the reviewed [Accounts migration handoff](installation-migration-adoption.md)
and required forward migrations before Worker cutover. Preserve historical SQL,
reset preparation, the operator's commercial-service pins and existing resource
identities; follow the [migration inventory](../engineering/hosting-consolidation-migration-inventory.md).
Deployments already using public Accounts retain their current migration
ledgers; do not replay adoption. The bridge does not migrate a singleton
installation into the new composition.

## Two deployments

1. Select compatibility tag `compat/mail-queue-v2-reader-2026-09-13`, resolving
   to public commit `fadc88add67d36ae1597e6877e953cb6d9744fb8`. Build and deploy
   that bridge through your normal operator deployment, with compatible
   private-service pins where applicable. It adds the dual-version Mail reader
   and Gateway's `resolveOutboundMailReference` RPC; Gateway still writes v1.
2. Verify the deployed Mail and Gateway module bytes against the bridge build,
   their active versions and service bindings, and preserve the deployment
   receipt. Both the dual reader and resolver must be live before proceeding;
   a local build, health response or submitted deployment alone is insufficient.
3. Build and deploy the final version through the same operator deployment.
   It switches Gateway's writer to v2 while retaining the dual reader. Verify
   that Mail still runs the compatible reader and that resource identities,
   existing queues and pending delivery state remain preserved.

Use the commands and explicit account/stage configuration belonging to your
operator composition. There is no Alchemy `--target` option for this upgrade;
use the two complete deployments above, not an assumed Worker update order.
The compatibility tag is a preserved upgrade checkpoint, not a GitHub release.

## Rollback

A producer rollback may restore v1 writes while keeping the bridge Mail reader
and Gateway resolver. Never roll Mail back to its old v1-only reader while v2
messages may remain in either the main or dead-letter queue. Keep the dual reader
through retries and replays; do not purge queues to perform this upgrade.
