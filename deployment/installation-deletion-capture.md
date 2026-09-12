# Capture Durable Object deletion evidence

This command captures the Durable Object portion of an operator's deletion
inventory. It does not retire a space, register a manifest, import resource
addresses, or begin erasure. The target must already be retained in Accounts,
and Accounts must have the inspection epoch migration and discovery bindings.

Create an operator-reviewed configuration from the deployment's namespace
inventory and trusted directory identities:

```json
{
  "version": 1,
  "accountId": "11111111111111111111111111111111",
  "accountsOrigin": "https://accounts.example.com",
  "installationId": "inst_retired",
  "candidateInstallationIds": ["inst_retired", "inst_other"],
  "namespaces": [
    {
      "namespaceId": "22222222222222222222222222222222",
      "ownerId": "gateway",
      "className": "Process",
      "kind": "process"
    }
  ]
}
```

Include every namespace in the owning deployment's configured inventory,
including previously enabled owners that still have historical state. Do not
filter the Cloudflare enumeration to the current Kernel process registry.
`candidateInstallationIds` comes from the trusted directory capture; the owning
service validates names before opening named objects. For historical resources
whose names are known, a namespace entry may carry a `names` dictionary from
physical object ID to name. A supplied name still must match the physical
address and owning service's identity checks.

Provide `CF_API_TOKEN` (or `CLOUDFLARE_API_TOKEN`) and either
`GSV_OPERATOR_BEARER` or `GSV_OPERATOR_COOKIE` through the environment. The
Cloudflare token needs read access to the configured account's Durable Object
inventory. The operator credential or authenticated cookie must pass the
Accounts deployment's existing operator access policy. No credentials belong in
the configuration file or command arguments.

```bash
node deployment/src/installation-deletion-capture-command.ts \
  --config /private/operator-scope.json \
  --output /private/deletion-capture
```

The output directory must have mode `0700`; artifact files are written atomically
with mode `0600`. Existing files are immutable and symlink files are rejected.
Run the same command and configuration to resume an interruption. Successful
Cloudflare pages, the inspection epoch, and observation chunks are reused.
Accounts also returns persisted observations if a successful probe's HTTP reply
was lost. A changed configuration or changed before/after namespace enumeration
requires a new output directory and a fresh epoch.

Opening the inspection epoch first initializes historical adapter indexes, so
their stored objects are included in both namespace snapshots. Each namespace
is enumerated until the actual empty terminal page, including
the continuation cursor chain. Stored objects are inspected through Accounts in
batches of at most 32. After inspection, a second complete enumeration must match
the first, including each object's stored-data flag. Unidentified objects remain
explicitly unresolved; they are never treated as empty or assumed to belong to
another space.

`durable-objects-index.json` references the before/after page and observation
parts and the server-owned `inspectionEpochId`. `capture-result.json` lists each
evidence reference and SHA-256 digest. To assemble an eventual manifest, use
those exact bytes and hashes and include only target-space observations with
verified names as that space's DO resources. The reusable
`captureInstallationDeletionObjects` function also returns the resource list and
evidence bodies to an authenticated operator integration.

The result is always labeled `scope: "durable-objects", outcome: "captured"`.
R2 objects and unfinished multipart uploads, D1 records, queues, provider logs,
telemetry, caches, and backup retention need their own declared evidence and
owners. This capture alone cannot pass the complete inventory resolver.

## Capture and abort unfinished R2 uploads

`scripts/capture-r2-multipart.ts` and the exported
`captureR2MultipartUploads` helper cover one declared R2 multipart resource.
They derive the prefix from the exact immutable installation ID and use the
operator's S3 credentials. Create a configuration using the exact entry from
the deployment's current and historical operator catalog:

```json
{
  "version": 1,
  "accountId": "11111111111111111111111111111111",
  "installationId": "inst_retired",
  "resourceId": "multipart",
  "catalog": [{
    "id": "multipart",
    "kind": "r2",
    "namespace": "your-storage-bucket",
    "source": "cloudflare-r2-multipart",
    "scope": "installation",
    "disposition": "live"
  }]
}
```

Supply `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and, for temporary credentials,
`R2_SESSION_TOKEN` through the environment. Credentials never belong in command
arguments or artifacts. The helper uses the account's default R2 S3 endpoint
and signs requests for service `s3`, region `auto`; redirects are refused.

```bash
node scripts/capture-r2-multipart.ts \
  --config /private/multipart-scope.json \
  --output /private/multipart-observation-001
```

The default only lists uploads. To abort them after separately authorizing
cleanup, obtain the retired installation ID, deletion operation ID and
application live-erasure timestamp from authenticated Accounts state. Verify
that upload producers are fenced and outstanding provider writes have settled.
Save `{ "installationId": "inst_retired", "operationId": "operation-from-accounts",
"applicationErasedAt": 1789200000000 }` as the authorization file, then run:

```bash
node scripts/capture-r2-multipart.ts \
  --config /private/multipart-scope.json \
  --output /private/multipart-abort-001 \
  --abort --authorization /private/multipart-authorization.json
```

The helper checks matching identity and a completed application-erasure time;
the operator integration owns authenticating that receipt with Accounts.
Both modes follow the exact `key-marker` and `upload-id-marker` pair until
`IsTruncated` is false. Repeated uploads or markers, mismatched scope, grouped
prefixes, malformed responses, or more than 64 pages of 1,000 uploads stop the
capture. Abort mode validates the complete inventory and every exact object
address before its first mutation, then aborts only those enumerated uploads.
It never fetches bodies, lists parts or modifies completed objects.

A new complete enumeration must be empty after aborting. Successful abort
responses and `404 NoSuchUpload` are insufficient on their own. The latter
permits recovery when a previous attempt aborted that exact upload; other
errors remain failures. A lost response or interrupted run may leave some
aborts completed. Retry with a **new** private output directory: every attempt
starts from current provider state. Saved empty pages are never reused as
fresh evidence. Other spaces' uploads stay outside the selected prefix.

Artifacts use the same 0700 directory and 0600 immutable-file helper as the DO
capture. Pages and abort receipts retain hashes of keys and upload IDs; raw
keys remain in memory because they may contain private filenames. Hashes of
marker pairs preserve the cursor chain. The report's `facts` describe the final
enumeration; `before` retains the original counts and page references. Response
hashes cover the sanitized page bytes, not raw S3 responses.

The report always declares exact-prefix coverage and `submission: null`. It
does not submit an attestation or claim complete installation erasure.
Historical unscoped uploads need their own ownership evidence. An application
timestamp does not prove that ambiguous provider uploads settled: S3 documents
that in-flight parts can survive an abort. Keep that case unresolved. Use fresh
empty facts as operator evidence only after confirming the final-write boundary
and the catalog's historical coverage.

See Cloudflare's [S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/),
[ListMultipartUploads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListMultipartUploads.html)
and [AbortMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html).
