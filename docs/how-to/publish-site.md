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

Primary, legacy and publication domains must be lowercase and have no leading or
trailing dots. Deployment rejects noncanonical domains before creating resources.

Use a separate registrable domain for untrusted content to isolate same-site
cookie policies too. Deployment rejects the primary and legacy installation
domains themselves; it guarantees separate origins but does not check the public
suffix list or reject sibling subdomains. Public deployment
metadata advertises `sitesDomain` but grants no authority. Accounts stores each
exact hostname against immutable installation and site IDs. Unknown hosts cannot
select a Kernel. Resetting a space never transfers its old site origins.

## Build and publish

Run `sites` on the `gsv` target. It creates an ordinary Vite, React and TypeScript
project in the human owner's GSV repository, accessible to Ship and Crew:

```bash
sites init my-game
```

The command returns `/src/repos/OWNER/my-game`. Edit those files with the
ordinary file tools; repository writes commit automatically. Source remains
available for later edits after the build computer has stopped. Init refuses to
replace files in an existing repository.

Start a [cloud computer](/how-to/cloud-computers), or select an accessible Linux
computer with Node.js and npm. Then run on `gsv`:

```bash
sites publish my-game --target COMPUTER
```

The command snapshots the saved source, installs dependencies, builds on the
selected computer, uploads the output, and returns the share URL. Release paths,
file transfers, checksums and activation checks are handled internally. It
cleans up its temporary build directory; stop an idle cloud computer separately.
Set the Shell timeout to 300000 ms for installation and build. Cancellation stops
the owned build session; it does not stop the computer. If cancellation prevents
directory cleanup, the error identifies the temporary path; stopping a cloud
computer discards it.

Use `OWNER/REPO` to publish from another accessible repository, or omit the
repository argument when running inside `/src/repos/OWNER/REPO`. The selected
computer is only the builder; neither source nor public hosting depends on its
continued availability. Save computer-side edits back to GSV before publishing.

`site.json` contains the public metadata. Builds write to `dist`:

```json
{
  "slug": "my-game",
  "title": "My game",
  "description": "A browser game made with Ship",
  "routing": "spa",
  "output": "dist"
}
```

An optional `image` names a built PNG, JPEG or WebP for sharing previews.
`routing: "static"` disables HTML navigation fallback. Other npm-based static
projects can use the same configuration: provide `npm run build`, write
`dist/index.html`, and use `GSV_SITE_BASE` as the build's public
asset base. The starter's Vite configuration already does this. Client-side
routers should use `import.meta.env.BASE_URL` as their basename. Hosting itself
does not depend on React or Vite.

Source and output access, target permissions and approvals use the existing
syscalls. An atomic activation check prevents a build that started earlier from
overwriting a newer publish or unpublish. Sizes and checksums are verified while
streaming to R2; a failed build or upload leaves the current release unchanged.

Limits are 1,024 files, 256 MiB per file, and 1 GiB total output per release. A site
retains up to 1,024 distinct published releases. Source remains in its original
repository: deleting that repository can remove source while published output
continues to exist.

## Browser behavior and sharing

The responsive share page includes server-rendered Open Graph and Twitter card
metadata, an isolated iframe, and a full-screen launch link. Title and description
come from `site.json`. A declared social image is used when supplied; otherwise
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

Edit the saved repository and run `sites publish` again. To inspect share URLs or
take a site offline:

```bash
sites list
sites unpublish my-game
```

Unpublishing returns 404 for the share page and every release URL on subsequent
server requests. Restricting or retiring the installation also blocks them.
Downloaded or browser-cached bytes cannot be recalled. Publication metadata and
outputs remain stored; installation deletion clears their installation-scoped
storage with other data.

The public client and CodeMode also expose `site.create/list/get/publish/unpublish`
for direct integrations. The last published manifest records the exact source
repository and revision, including after unpublish. See the
[site syscall reference](/reference/syscalls). Old releases remain available for
open tabs; incomplete uploads stay private until installation cleanup.
