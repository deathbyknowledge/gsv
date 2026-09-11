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

Each namespace is enumerated until the actual empty terminal page, including
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
