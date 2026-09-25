import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docsFileExists, docsRoot, listDocsPages, readSidebarLinks, repositoryRoot, routeToFile } from "./routes.mjs";

/**
 * Everything under docs/ is published, indexed and searchable at
 * docs.gsv.space, whether or not the sidebar names it. This refuses content
 * that must not be public (managed-service internals, operator-only paths,
 * editorial notes) and pages that nobody can navigate to.
 */

const FORBIDDEN = [
  [/gsv\.space\/admin/, "names the real operator console; write <admin-origin>/admin"],
  [/deploy\.gsv\.space/, "names the managed deployment host"],
  [/accounts\.gsv\.space/, "names the managed accounts host"],
  [/gsv-(?:managed|staging)-[a-z-]+/, "names a managed deployment resource"],
  [/ManagedGsv[A-Za-z]+/, "names a managed service binding"],
  [/managed_inference_\w+/, "names a managed inference table or setting"],
  [/managed_telegram_(?:pairing|peer)/, "names a managed adapter table"],
  [/PostHog/i, "names the observability vendor"],
  [/Tail Worker/, "names the managed log transport"],
  [/\/admin\/api\/installations\//, "documents an authenticated operator API path"],
  [/OPERATOR_DELETION_CATALOG|DELETION_DISCOVERY_NAMESPACES|DELETION_RESOURCE_SCOPES|DELETION_ADDITIONAL_EVIDENCE/, "names a deletion operator setting"],
  [/GatewayLifecycleEntrypoint/, "names an internal entrypoint"],
  [/gsv-previews|GSV_PREVIEWS_ENABLED|GSV_PREVIEW_CLOUDFLARE_API_TOKEN/, "documents this repository's CI previews"],
  [/cloudflareaccess\.com/, "names an Access team domain"],
  [/engineering\/[\w-]+\.md/, "links into the engineering notes, which are not product documentation"],
  [/Confirm with [A-Z][a-z]+\b/, "is an editorial note left in a published page"],
  [/\bTODO\b|\bFIXME\b/, "is an editorial marker"],
  [/[a-z0-9-]+\.workers\.dev/, "names a workers.dev host", (line) => /example|your-|<|placeholder/i.test(line)],
];

const SOFT = [
  /release gate/i,
  /acceptance gate/i,
  /Production deployment/,
  /adopted staging/i,
  /past_due|trialing/,
  /is being retired/i,
  /\bCI jobs\b/,
];

const problems = [];
const warnings = [];

const files = [...listDocsPages().map((page) => `docs/${page}`), "docs/.vitepress/config.ts"];
for (const file of files) {
  const lines = readFileSync(join(repositoryRoot, file), "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const [pattern, reason, allowed] of FORBIDDEN) {
      const match = line.match(pattern);
      if (!match || (allowed && allowed(line))) continue;
      problems.push(`${file}:${index + 1}  "${match[0]}" ${reason}`);
    }
    for (const pattern of SOFT) {
      const match = line.match(pattern);
      if (match) warnings.push(`${file}:${index + 1}  "${match[0]}" reads as internal status; check it describes the product, not the operator's current state`);
    }
  });
}

const unlisted = JSON.parse(readFileSync(join(docsRoot, ".vitepress", "unlisted.json"), "utf8")).pages;
const reachable = new Set(readSidebarLinks().map((link) => routeToFile(link.route)).filter(Boolean));
for (const page of listDocsPages()) {
  if (reachable.has(page) || page in unlisted) continue;
  problems.push(`docs/${page}  is not in any sidebar and is not listed in docs/.vitepress/unlisted.json; a page nobody can navigate to is a page nobody maintains`);
}
for (const page of Object.keys(unlisted)) {
  if (!docsFileExists(page)) problems.push(`docs/.vitepress/unlisted.json  lists ${page}, which does not exist`);
  else if (reachable.has(page)) problems.push(`docs/.vitepress/unlisted.json  lists ${page}, which is in the sidebar; remove the entry`);
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
for (const problem of problems) console.error(problem);
if (problems.length > 0) {
  console.error(`docs publishable: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  process.exitCode = 1;
}
