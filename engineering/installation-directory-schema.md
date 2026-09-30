# Installation directory: validation and schema rollout

Moved from the public installation-directory architecture page. It describes
implementer and operator procedure for `workers/installations/`, not the product
contract; the contract stays in `docs/architecture/installation-directory.md`.

Keep tests at both ends: Accounts tests cover reservation races, claim
binding, expiry/reissue, activation, reset idempotency and rollback; gateway
tests cover unknown-host rejection, state gates, immutable addressing, and
cross-installation isolation. Test both an upgraded database containing
ownership rows and a fresh instance.

Ownership-column retirement uses two deployments because migrations run
before the replacement Worker is active. First make the legacy role column
default to `owner` and stop writing or reading both obsolete columns. Both
old and new Workers work with that intermediate schema. After the new Worker
is deployed and older requests are drained, a subsequent migration removes
both columns and their obsolete uid uniqueness constraint. Keep the removal
out of the first deployment's applied migration directory. Existing
principal/installation foreign keys and ownership rows survive both steps.

Shipped migration files are immutable. Cloudflare D1 enforces foreign keys
during migrations; a table rebuild must preserve the relationships rather
than disabling them. See [D1 foreign-key behavior](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
