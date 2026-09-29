# Isolated managed upgrade acceptance

This fixture proves that credentials and runtime state issued by genuine pre-extraction GSV survive migration to the extracted services. It creates its own resources and two spaces, performs a real reset on the old implementation, then adopts the same D1 database and Worker/DO identities. It does not use or reset an existing person's space.

The operator transport is synthetic: an acceptance-only Accounts subclass checks an exact host and secret, then forwards only the existing administration API to the historical localhost admission path. Setup, local passwords, token issuance, routing, Kernel/Process state and the reset coordinator are the unchanged historical implementation. This is **not** Cloudflare Access, owner authentication, a browser-device UI, Telegram, or existing H&M staging acceptance. Those remain separate gates in the consolidation spec.

No adapter or email is configured in this fixture. Inference funding is disabled. The harness issues a machine protocol credential and reconnects an empty acceptance target with an `fs.stat` error handler; the historical Kernel requires a nonempty implements list. It does not enroll real hardware. Any explicitly authorized history seed must first prove the effective model stack contains only deployment-base `gsv` entries and the actual inference binding is boolean false, so generation stops at the old disabled guard before provider execution. Expected zero external provider requests is derived from these verified guards and configuration, not measured request telemetry.

## Historical sources

| Component | Revision |
| --- | --- |
| Pre-extraction public GSV | `6915d5e65f6891b248d9081c6cf0901e0a57b939` |
| Pre-extraction private services | `3777be4bd18e5d6a201aa4c81683b309442ca675` |
| Initially validated current runtime | public `3c65ead619ed0aa7abe3d8ca0fc2c7c11ef7dc4d`, private `8a2b01fb35f5f08c66ab5a06b3db65f46c11f6db` |

The old private revision has all twelve immutable legacy migration files and references that exact public revision. Its ordinary reset prepares the private inference participant, writes a durable preparation receipt, retains the old installation, creates a replacement and leaves physical deletion pending. The fixture uses that real operation, with no SQL-inserted account or reset state.

This old pair is the last pre-extraction source pair, not a claim that it was the deployed H&M overlay. The earlier deployed overlay `3202181d602482eb0f0d85620021306a148737a6` references public `de19ded2b18314039b36caac31e016ba3a69d82d` and private `48c71dd8227e89f7c4d01270e787ae4d85ffa9d4`, which have ten migrations. Testing that earlier atomic reset is an additional historical case.

## Configuration and local build

Keep configuration, credentials, snapshots and logs outside the repository in a directory with mode `0700`; files are `0600`. `fixture.json` has these fields:

```json
{
  "accountId": "<32 hexadecimal characters>",
  "zoneId": "<32 hexadecimal characters>",
  "domain": "example.com",
  "fixtureId": "a1b2c3d4",
  "profile": "explicit-personal-profile",
  "publicRepository": "/absolute/path/to/gsv",
  "privateRepository": "/absolute/path/to/gsv-services",
  "currentPublicRevision": "<40 character public revision>",
  "currentPrivateRevision": "<40 character private revision>",
  "artifactsDirectory": "/private/state/upgrade/artifacts"
}
```

The current private revision's nested `gsv` gitlink must match the configured public revision. Only acceptance tooling may live at a later revision when Worker/runtime sources are unchanged; record this distinction in the run evidence.

Create an operator env file containing a newly generated 64-character hexadecimal `GSV_UPGRADE_ADMIN_SECRET`. Use the selected Alchemy profile's existing deployment authentication. Never put credentials in command arguments or repository files.

```sh
node deployment/acceptance/legacy-upgrade/build.ts /private/state/fixture.json legacy
node deployment/acceptance/legacy-upgrade/build.ts /private/state/fixture.json current
npx tsc --noEmit -p deployment/acceptance/legacy-upgrade/tsconfig.json
npx vitest run deployment/test/legacy-upgrade.test.ts
```

The build checks out detached, exact private and public sources under `artifacts/sources`, refuses tracked source changes, and produces prebuilt Worker modules and assets. Wrangler runs only with `--dry-run`. It installs private dependencies before the nested public dependencies: doing the reverse lets the public esbuild 0.28 native binary shadow the SDK's pinned 0.27 binary during the private postinstall. No historical lockfile or source modification is needed. Native build tools follow the historical scripts; the output hashes, rather than a claim of bitwise reproducibility, identify the tested artifacts.

Each completed build writes `receipt.json`. Every plan, deploy and fixture-driver command verifies all listed files and rejects changed, extra or missing artifacts. An interrupted rebuild removes the previous receipt first.

## Isolated composition

All phases use stack and stage `gsv-upgrade-<fixtureId>`. The real process environment must contain the reviewed `CLOUDFLARE_ACCOUNT_ID` and `ALCHEMY_PROFILE`; command-line flags are required as well. Set `GSV_UPGRADE_FIXTURE_FILE` to the absolute config path and `GSV_UPGRADE_PHASE` to the selected phase.

```sh
npx alchemy plan deployment/acceptance/legacy-upgrade/alchemy.run.ts \
  --profile explicit-personal-profile --stage gsv-upgrade-a1b2c3d4 \
  --env-file /private/state/operator.env
```

Use `deploy` in place of `plan` only after the concrete plan is reviewed. Never invoke the stock private overlay, `deploy:staging`, an implicit Alchemy profile, or an ordinary production stage for this fixture.

The resource inventory is four Workers (`accounts`, `inference`, `gateway`, `ripgit`), one D1 database, one R2 bucket, their DO namespaces, and three exact DNS/Worker routes. Names begin `gsv-upgrade-<fixtureId>-`. Routes are `upg-<fixtureId>-admin.<domain>/*`, `upg-<fixtureId>-a.<domain>/*`, and `upg-<fixtureId>-b.<domain>/*`. No wildcard, existing application route, Access application, bot webhook, or mail configuration changes.

The `legacy` phase installs twelve legacy D1 migrations. `handoff` removes that legacy migration runner while retaining the same modules, bindings and resource IDs. `current` updates those same Workers to current modules and introduces the inference executor namespace and current service bindings. Every existing namespace, database, bucket and route identity must survive. `assertUpgradeResourceContinuity` also rejects loss or replacement of unrelated resources when passed complete before/after inventories. Inspect the actual Alchemy plan as well; the helper is not an account inventory collector.

## Run sequence

1. Capture the account's existing resource inventory and obtain authorization for the exact new fixture plan. Deploy `legacy`; verify Worker versions, module hashes, bindings, all twelve migrations, exact routes and new resource IDs. Save private deployment evidence. Existing application resources and spaces must be unchanged.
2. With the operator secret in the process environment, run `driver.ts <config> seed --owned-fixtures-only`. It creates only the two planned handles, saves credentials before setup, writes different values at the same path, and obtains genuine web, CLI and machine protocol credentials. It checks human/root passwords, tokens, files, Process identities and canonical conversation IDs. Credential intent is saved with an exclusive private temporary file, file fsync, atomic rename and directory fsync; exposed files and symlinks are rejected. An uncertain non-idempotent token issue stops for reconciliation rather than issuing another token.
3. Run `driver.ts <config> reset-legacy --owned-fixtures-only`. This invokes the old admin reset, saves the old identity and credentials, completes replacement setup through the old gateway, and repopulates only that replacement. Run `verify-legacy` to establish the pre-migration baseline. The directory now contains one retained old installation and two active installations. Verification also requires HTTP/protocol 401 rejection of the retired space’s old password and token at the replacement route. For explicitly authorized nonempty history coverage, run `history-driver.ts <config> seed-legacy --owned-fixtures-only`: it targets only B, saves an idempotent message intent atomically, checks the live inference JSON binding is false and the effective stack has only base `gsv` entries, sends one local sentinel, and waits for its matching failure and a terminal run. The old private inference guard rejects before provider execution, and the old gateway deliberately projects that exception as exactly `GSV inference is unavailable`; the proof retains that real error. It saves complete bounded history prefixes as IDs and content hashes. Expected zero external provider requests is guard-derived, not measured telemetry; no adapter is configured. Re-running a completed seed only verifies the saved proof. If admission succeeded but proof capture was interrupted, use `history-driver.ts <config> capture-legacy --owned-fixtures-only`: it derives the original deterministic message ID from the saved intent and captures the terminal prefix without another `conversation.send`.
4. Disconnect clients and pause the fixture driver. There are no automatic Accounts maintenance crons. Review and deploy the `handoff` phase: unchanged modules/resources, with the legacy D1 runner removed. Record a reviewed `handoff-deployment.json` with the shape below, using live observed Worker version IDs. This receipt is a reviewed operator observation, not an assertion that a checksum proves deployment history.
5. Set the explicit `CLOUDFLARE_ACCOUNT_ID` and the API token through a private environment loader. Run `migration-request.ts <config> <handoff-deployment.json>`. This performs one read-only D1 query to verify the old reset's exact operation, installation pair, prepared inference participant and durable service receipt. It writes the request and evidence accepted by the existing migration CLI. It performs no D1 writes.
6. Run the existing `installation-migration-command.ts prepare --request <artifacts>/migration-request.json --output <new-private-snapshot-directory>`. This deliberately freezes D1 and writes its snapshot/plan. Stop that process, then invoke `status` in a new process to prove the durable freeze survives interruption. Review the complete plan and its precondition checksum before proceeding. No fixture administration or runtime mutation is allowed while frozen.
7. Run `apply --request <request> --approved-precondition <reviewed-sha256>`. Re-run the exact same `apply` after successful release to verify receipt-based reconciliation, then run `forward --request <request>` to advance both new migration owners. Keep each command's receipt. Do not run Wrangler migrations against an adopted database.
8. Review and deploy `current`, preserving the recorded resource IDs. Run `driver.ts <config> verify-current --owned-fixtures-only`. Existing passwords and all three protocol credential types must work without reissuing credentials, Process/conversation identities and file contents must match, and the old pending deletion must still be pending. Then run `history-driver.ts <config> verify-current --owned-fixtures-only`; it sends no messages and rejects edits, removals or reordering of any saved Conversation or Process record while allowing appended events. This continuity test does not initiate cleanup; full erasure is a separate acceptance.
9. Compare before/after resource identities and the unrelated application snapshot. Record precise coverage and retained resources. Cleanup requires a separate explicit fixture-only plan; the composition retains stateful resources by default.

The driver command path is `deployment/acceptance/legacy-upgrade/driver.ts`. The migration CLI path is `deployment/src/installation-migration-command.ts`. All command reports omit passwords, tokens and sentinel contents; the private credential file and migration snapshot contain sensitive material and must stay private.

```json
{
  "phase": "handoff",
  "prefix": "gsv-upgrade-a1b2c3d4",
  "accountId": "<reviewed account>",
  "databaseId": "<same live database UUID>",
  "publicRevision": "6915d5e65f6891b248d9081c6cf0901e0a57b939",
  "privateRevision": "3777be4bd18e5d6a201aa4c81683b309442ca675",
  "legacyRunnerDisabled": true,
  "legacyBuildReceiptSha256": "<sha256 of exact legacy/receipt.json bytes>",
  "observedAt": "2026-09-12T00:00:00.000Z",
  "workers": [
    { "name": "gsv-upgrade-a1b2c3d4-accounts", "versionId": "<observed version>" },
    { "name": "gsv-upgrade-a1b2c3d4-inference", "versionId": "<observed version>" },
    { "name": "gsv-upgrade-a1b2c3d4-gateway", "versionId": "<observed version>" },
    { "name": "gsv-upgrade-a1b2c3d4-ripgit", "versionId": "<observed version>" }
  ]
}
```

## Remaining gates

This fixture needs an unused prefix, an explicit personal account/profile and permission to create its isolated resources. It needs no new vendor account or external bot. The code and local builds alone are not a completed cloud acceptance.

The actual existing H&M staging adoption still needs its own resource and credential continuity proof. Real Access admission needs its configured identity provider, and real Telegram coverage needs a dedicated bot and controlled actor. An existing production or staging Telegram bot must not be reused: historical deployment scripts call `setWebhook` and would redirect the shared bot. Removing standalone also needs its own last verified standalone release/tag; this managed upgrade fixture does not establish that fact.
