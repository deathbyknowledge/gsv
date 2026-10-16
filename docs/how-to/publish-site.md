# Publish a Site

Ship can publish a static website, browser game, or WebAssembly build at
`https://YOUR-SPACE/public/SLUG`. The share page embeds the build on its own
isolated origin. Output lives in installation-scoped R2 storage, so the build
computer can stop after publishing.

This serves static browser files. It does not start a server, provide a database,
or give the page a GSV session. Keep credentials and private data out of the build.

## Enable publication

The operator configures `GsvDeployment.sites: { domain, zoneId? }`. The standard
composition reads `GSV_SITES_DOMAIN` and optionally `GSV_SITES_ZONE_ID`. A zone ID
adds wildcard DNS and the Gateway route through the existing deployment plan;
omit it when the operator already owns those resources. Without configuration,
publication is disabled.

Use a separate registrable domain for untrusted content to isolate same-site
cookie policies too. Deployment rejects the primary and legacy installation
domains themselves; it guarantees separate origins but does not check the public
suffix list or reject sibling subdomains. Public deployment
metadata advertises `sitesDomain` but grants no authority. Accounts stores each
exact hostname against immutable installation and site IDs. Unknown hosts cannot
select a Kernel. Resetting a space never transfers its old site origins.

## Build and publish

The public TypeScript client and CodeMode expose `site.*`. Publication requires
`site.publish`, `fs.read`, and `repo.log`, and preserves filesystem and repository
access checks.

1. Keep source in an existing GSV repository. Writes under `/src/repos/OWNER/REPO`
   commit automatically; obtain the full 40-character hash with
   `rgit log OWNER/REPO --limit 1`. Publication verifies that revision is readable; it
   does not make the source public or create a duplicate archive.
2. Call `client.site.create({ slug: "my-game" })`. The result contains an immutable
   site identity and content origin. Repeating create returns your existing site.
3. Choose `crypto.randomUUID()` as the release ID **before building**. Set the
   framework's public base to `/_r/RELEASE_ID/`, including the SPA router basename.
   Vite accepts that path through `--base`. Relative URLs must resolve inside the
   release; root-relative `/assets/...` paths do not work.
4. Copy output onto the `gsv` target using existing filesystem copy/transfer calls.
   List each public file's relative path, byte size, and SHA-256 hex digest in the
   manifest. The HTML entry must be at the build root. Exclude private files and
   development configuration.
5. Call `site.publish` using the revision from `site.get` (initially zero).

```ts
const releaseId = crypto.randomUUID(); // use this ID in the preceding build
const { site, publication } = await client.site.create({ slug: "my-game" });
const published = await client.site.publish({
  siteId: site.id,
  expectedRevision: publication.revision,
  releaseId,
  outputPath: "/tmp/my-game-dist",
  manifest: {
    version: 1,
    entry: "index.html",
    routing: "static", // or "spa" for HTML navigation fallback
    title: "My game",
    description: "A browser game made with Ship",
    source: { repo: "me/my-game", revision: sourceCommit },
    files: buildFiles, // [{ path, size, sha256 }, ...]
    image: "social.png", // optional declared PNG, JPEG or WebP output
  },
});
console.log(published.shareUrl);
```

Agents use the same methods as `site.create/list/get/publish/unpublish` inside
CodeMode, without the `client.` prefix. They retain the caller's capabilities,
owner relationship and approval policy. These methods always address this
installation; a CodeMode default device target does not redirect publication.

Sizes and checksums are verified while streaming to R2. One conditional write
activates the release. If another publish or unpublish wins first, the stale
operation fails without changing the publication. A release ID cannot describe
different files or metadata. Retry uploads with the same manifest; fetch the
current revision before retrying activation.

Limits are 1,024 files, 256 MiB per file, and 1 GiB total output per release. A site
retains up to 1,024 distinct published releases. Source remains in its original
repository: deleting that repository can remove source while published output
continues to exist.

## Browser behavior and sharing

The responsive share page includes server-rendered Open Graph and Twitter card
metadata, an isolated iframe, and a full-screen launch link. Title and description
come from the manifest. A declared social image is used when supplied; otherwise
the card uses the Ship image. Crawlers do not start a build computer.

The content root redirects to the active `/_r/RELEASE_ID/` URL. Asset URLs remain
bound to that release so existing tabs can finish loading old chunks after an
update. Static files and directory index pages use ordinary paths. Unknown paths
return 404. SPA mode falls back only for extensionless HTML navigation requests;
missing scripts, images and JSON requests still return 404. WASM receives the
correct MIME type; files support HEAD, conditional reads and byte ranges.
Threaded WASM requiring cross-origin isolation is not enabled by this mode.

Existing `/public/` files retain their sandbox policy. A site cannot claim the
exact path of an existing public file. Published content cannot use its origin
for installation login or `/ws` and does not share installation browser storage.

## Update and unpublish

Fetch `site.get` to recover the last published manifest, including its source
repository and revision, then build with a fresh release ID and publish using the
current `publication.revision`. This manifest remains available to the owner
after unpublish. Old releases are retained for open tabs. Incomplete
uploads remain private and are retained until installation cleanup.

```ts
const { publication } = await client.site.get({ siteId });
await client.site.unpublish({ siteId, expectedRevision: publication.revision });
```

Unpublishing returns 404 for the share page and every release URL on subsequent
server requests. Restricting or retiring the installation also blocks them.
Downloaded or browser-cached bytes cannot be recalled. Publication metadata and
outputs remain stored; installation deletion clears their installation-scoped
storage with other data.
