import {
  addRemote,
  appendLineAndCommit,
  cleanupTempDirs,
  cloneFixture,
  git,
  pushAsOwner,
} from "../tests/helpers/git.mjs";
import { actorHeaders, createTestServer, uniqueId } from "../tests/helpers/mf.mjs";

const tempDirs = [];
const server = await createTestServer();

function uniqueToken(prefix) {
  return `${prefix}${uniqueId("token")}`.replace(/[^a-zA-Z0-9]/g, "");
}

async function postForm(path, actorName, form = {}) {
  return server.dispatch(path, {
    method: "POST",
    redirect: "manual",
    headers: {
      "X-Ripgit-Actor-Name": actorName,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
}

try {
  const owner = uniqueId("owner");
  const repo = uniqueId("repo");
  const contributor = uniqueId("contributor");
  const baseBranch = uniqueId("base");
  const topBranch = uniqueId("top");
  const baseToken = uniqueToken("stackbase");
  const topToken = uniqueToken("stacktop");
  const remoteUrl = new URL(`/${owner}/${repo}`, server.url).toString();

  const source = await cloneFixture();
  tempDirs.push(source.workDir);
  await addRemote(source.repoDir, "ripgit", remoteUrl);
  await pushAsOwner(source.repoDir, owner, "push", "ripgit", "HEAD:refs/heads/main");

  await git(source.repoDir, ["checkout", "-b", baseBranch]);
  await appendLineAndCommit(
    source.repoDir,
    "README.md",
    `stacked base token ${baseToken}`,
    "add base stacked change",
  );
  await pushAsOwner(source.repoDir, owner, "push", "ripgit", `HEAD:refs/heads/${baseBranch}`);

  await git(source.repoDir, ["checkout", "-b", topBranch]);
  await appendLineAndCommit(
    source.repoDir,
    "README.md",
    `stacked top token ${topToken}`,
    "add top stacked change",
  );
  await pushAsOwner(source.repoDir, owner, "push", "ripgit", `HEAD:refs/heads/${topBranch}`);

  await postForm(`/${owner}/${repo}/pulls`, contributor, {
    title: "Base stacked PR",
    body: "Base branch PR",
    source: baseBranch,
    target: "main",
  });
  await postForm(`/${owner}/${repo}/pulls`, contributor, {
    title: "Top stacked PR",
    body: "Top branch PR",
    source: topBranch,
    target: baseBranch,
  });

  let response = await server.dispatch(`/${owner}/${repo}/pulls/2?format=md`);
  console.log("--- PR #2 before merge ---");
  console.log(await response.text());

  await server.dispatch(`/${owner}/${repo}/pulls/1/merge`, {
    method: "POST",
    redirect: "manual",
    headers: actorHeaders(owner),
  });

  response = await server.dispatch(`/${owner}/${repo}/pulls/2?format=md`);
  console.log("--- PR #2 after PR #1 merge ---");
  console.log(await response.text());

  response = await server.dispatch(`/${owner}/${repo}/file?ref=main&path=README.md`);
  const readme = await response.text();
  console.log("--- main README markers ---");
  console.log(`base token present: ${readme.includes(baseToken)}`);
  console.log(`top token present: ${readme.includes(topToken)}`);
} finally {
  await cleanupTempDirs(tempDirs);
  await server.mf.dispose();
}
