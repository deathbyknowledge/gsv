import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  docsFileExists,
  docsRoot,
  headingSlugs,
  listDocsPages,
  readNavLinks,
  readRedirects,
  readSidebarLinks,
  repositoryRoot,
  routeToFile,
} from "./routes.mjs";

/**
 * The docs site is navigated by hand-written routes: the sidebar, the redirect
 * map, and links inside pages. This keeps each of them pointing at a page that
 * exists, with a heading that exists, and refuses links that escape docs/ and
 * so 404 on the published site.
 */

const problems = [];
const redirects = readRedirects();
const redirectKeys = new Set(redirects.map((redirect) => redirect.from));

for (const link of [...readNavLinks(), ...readSidebarLinks()]) {
  const file = routeToFile(link.route);
  if (file && !docsFileExists(file)) {
    problems.push(`docs/.vitepress/config.ts:${link.line}  ${link.route} has no page (expected docs/${file})`);
  }
}

for (const redirect of redirects) {
  if (redirectKeys.has(redirect.to)) {
    problems.push(`docs/.vitepress/config.ts:${redirect.line}  redirect ${redirect.from} chains into another redirect (${redirect.to}); point it at the final page`);
    continue;
  }
  const file = routeToFile(redirect.to);
  if (file && !docsFileExists(file)) {
    problems.push(`docs/.vitepress/config.ts:${redirect.line}  redirect ${redirect.from} -> ${redirect.to} has no page (expected docs/${file})`);
  }
}

const slugCache = new Map();
function slugsOf(file) {
  if (!slugCache.has(file)) slugCache.set(file, headingSlugs(readFileSync(join(docsRoot, file), "utf8")));
  return slugCache.get(file);
}

function checkPageLink(page, line, target) {
  if (/^[a-z]+:/.test(target) || target.startsWith("//")) return;
  const [pathPart, anchor] = target.split("#");
  if (target.startsWith("../../")) {
    problems.push(`docs/${page}:${line}  ${target} leaves docs/ and 404s on the published site; link to the GitHub blob URL or drop it`);
    return;
  }
  let file;
  if (pathPart === "") {
    file = page;
  } else if (pathPart.startsWith("/")) {
    if (redirectKeys.has(pathPart.replace(/\/$/, ""))) return;
    file = routeToFile(pathPart);
  } else {
    file = posix.normalize(posix.join(posix.dirname(page), pathPart));
    if (file.startsWith("../")) {
      problems.push(`docs/${page}:${line}  ${target} leaves docs/ and 404s on the published site`);
      return;
    }
    if (file.endsWith("/")) file = `${file}index.md`;
    else if (!/\.[a-z0-9]+$/i.test(file)) file = `${file}.md`;
  }
  if (!docsFileExists(file)) {
    problems.push(`docs/${page}:${line}  ${target} has no page (expected docs/${file})`);
    return;
  }
  if (anchor && file.endsWith(".md") && !slugsOf(file).has(anchor)) {
    problems.push(`docs/${page}:${line}  ${target} names a heading docs/${file} does not have`);
  }
}

for (const page of listDocsPages()) {
  const lines = readFileSync(join(docsRoot, page), "utf8").split("\n");
  let fenced = false;
  lines.forEach((text, index) => {
    if (/^\s*```/.test(text)) fenced = !fenced;
    if (fenced) return;
    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      checkPageLink(page, index + 1, match[1].replace(/^<|>$/g, ""));
    }
  });
}

const productLinksFile = "web/src/app/features/instrument/settings/messengers/messengerDocs.ts";
const productLinks = readFileSync(join(repositoryRoot, productLinksFile), "utf8");
for (const match of productLinks.matchAll(/https:\/\/docs\.gsv\.space\/([^"#\s]+)(?:#([^"\s]+))?/g)) {
  const file = routeToFile(`/${match[1]}`);
  const line = productLinks.slice(0, match.index).split("\n").length;
  if (!docsFileExists(file)) {
    problems.push(`${productLinksFile}:${line}  links ${match[0]} but docs/${file} does not exist`);
  } else if (match[2] && !slugsOf(file).has(match[2])) {
    problems.push(`${productLinksFile}:${line}  links ${match[0]} but docs/${file} has no "${match[2]}" heading`);
  }
}

for (const problem of problems) console.error(problem);
if (problems.length > 0) {
  console.error(`docs links: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  process.exitCode = 1;
}
