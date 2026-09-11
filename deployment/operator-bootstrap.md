# First installation and operator recovery

The public directory owns the first-installation bootstrap and installation
administration. Cloudflare Access and the optional operator credential authorize
that administration; neither grants a Kernel account credential. Owner identity
and Kernel root recovery use their separate owner-link flow.

`GsvDeployment` creates the public directory D1 and Worker when the operator does
not supply an existing directory. Its `installation_migrations` ledger applies
only public schema migrations. Existing combined Accounts databases must use the
[verified migration handoff](installation-migration-adoption.md); supplying an
existing Worker does not create a new database or replay historical migrations.

After a successful initial deployment, run the explicit bootstrap command from
your local terminal, using the account ID, directory database ID, administration
origin and configured access mode from the deployment. The API token stays in
the operator's environment; do not paste it into the command or a request file.

```sh
node deployment/src/operator-bootstrap-command.ts issue \
  --account "$CLOUDFLARE_ACCOUNT_ID" --database "$GSV_INSTALLATIONS_DATABASE_ID" \
  --origin "https://accounts.example.com" --mode operator
```

The command requires `CLOUDFLARE_API_TOKEN` with access to that D1 database. It
opens `/dev/tty` before making a database change and writes the bootstrap link
only there. Redirected stdout receives a status without credentials. CI has no
controlling terminal and must not run this step. The link expires after one hour;
only its hash is stored. Running `issue` again is inert once a claim or an
installation exists. Ordinary deployment never rotates access or creates another
first installation.

Opening the link clears its fragment from browser history. Before redemption,
the browser stores its attempt and newly generated setup/operator secrets in
session storage. A lost HTTP response therefore retries the same attempt. A
successful redemption creates one installation and its setup link. In operator
mode the page displays the operator credential once and installs a host-only,
HttpOnly, Secure, SameSite=Strict cookie. Save the credential in your password
manager; `/operator` accepts it after signing out. In Access mode the page issues
no operator credential. Setup completion, explicit setup reissue, operator
rotation and revocation remain authoritative when an old bootstrap is retried.

If initial terminal output was lost or the unused link expired, run the same
command with `reissue-bootstrap`. This replaces only an unstarted claim. Once
redemption starts, use `rotate-operator` to regain operator administration; it
revokes the previous operator credential and never creates a new first
installation. `revoke-operator` revokes operator access without modifying
installation identities or setup claims. Access deployments use their Access
policy for recovery. These operations require deployment-owner Cloudflare
credentials and must never be exposed as unauthenticated Worker routes.

An uncertain D1 response is not automatically replayed. `issue` remains inert if
the original commit succeeded; use explicit reissue/recovery when needed. A
rotation whose terminal output was lost requires another explicit rotation.

Validation covers real local D1 fixtures for fresh schema, expiry, lost replies,
interleaved retries, setup claim preservation, second-installation isolation,
access mode, CSRF, cookie flags and credential recovery. These local fixtures do
not substitute for fresh-account Cloudflare deployment and two-installation
acceptance on staging.

## Deletion inventory

Set `GSV_DELETION_CATALOG_FILE` to an operator-reviewed JSON catalog before
enabling complete deletion inventory registration. The schema and evidence API
are documented in the [operator evidence contract](../engineering/installation-deletion-operator.md).
Without that file, ordinary service works but full deletion admission remains
unavailable. Configuration never supplies an erasure receipt.

`GsvDeletionResourceBindings` combines the operator catalog with the exact
application-owner storage scopes. `GsvDeployment` derives those scopes for its
fresh public components. An overlay supplying its own directory, inference or
Mail must call the helper with its complete owner inventory. Historical services,
exports, custom provider endpoints and user-provider accounts remain the
operator's responsibility; today's enabled bindings cannot prove their absence.
