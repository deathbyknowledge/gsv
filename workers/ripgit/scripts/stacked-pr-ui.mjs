import {
  addRemote,
  appendLineAndCommit,
  cleanupTempDirs,
  cloneFixture,
  git,
  pushAsOwner,
} from "../tests/helpers/git.mjs";
import { actorHeaders, createTestServer } from "../tests/helpers/mf.mjs";

const tempDirs = [];
const server = await createTestServer();

const owner = "demo-owner";
const contributor = "demo-contributor";

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

async function seedRepo(repo, mergeBasePr) {
  const baseBranch = "stack-base";
  const topBranch = "stack-top";
  const remoteUrl = new URL(`/${owner}/${repo}`, server.url).toString();
  const source = await cloneFixture();

  tempDirs.push(source.workDir);
  await addRemote(source.repoDir, "ripgit", remoteUrl);
  await pushAsOwner(source.repoDir, owner, "push", "ripgit", "HEAD:refs/heads/main");

  await git(source.repoDir, ["checkout", "-b", baseBranch]);
  await appendLineAndCommit(
    source.repoDir,
    "README.md",
    `stacked base token ${repo}`,
    "add base stacked change",
  );
  await pushAsOwner(source.repoDir, owner, "push", "ripgit", `HEAD:refs/heads/${baseBranch}`);

  await git(source.repoDir, ["checkout", "-b", topBranch]);
  await appendLineAndCommit(
    source.repoDir,
    "README.md",
    `stacked top token ${repo}`,
    "add top stacked change",
  );
  await pushAsOwner(source.repoDir, owner, "push", "ripgit", `HEAD:refs/heads/${topBranch}`);

  await postForm(`/${owner}/${repo}/pulls`, contributor, {
    title: "Base stacked PR",
    body: "This is the lower PR in the stack.",
    source: baseBranch,
    target: "main",
  });
  await postForm(`/${owner}/${repo}/pulls`, contributor, {
    title: "Top stacked PR",
    body: "This PR sits on top of the base PR.",
    source: topBranch,
    target: baseBranch,
  });

  if (mergeBasePr) {
    await server.dispatch(`/${owner}/${repo}/pulls/1/merge`, {
      method: "POST",
      redirect: "manual",
      headers: actorHeaders(owner),
    });
  }
}

async function main() {
  await seedRepo("stack-open", false);
  await seedRepo("stack-restacked", true);

  const base = server.url.toString().replace(/\/$/, "");
  const urls = [
    `${base}/${owner}/stack-open/pulls`,
    `${base}/${owner}/stack-open/pulls/1`,
    `${base}/${owner}/stack-open/pulls/2`,
    `${base}/${owner}/stack-restacked/pulls`,
    `${base}/${owner}/stack-restacked/pulls/2`,
  ];

  console.log("Stacked PR UI demo is running.");
  console.log("");
  console.log("Open stack:");
  console.log(`  ${urls[0]}`);
  console.log(`  ${urls[1]}`);
  console.log(`  ${urls[2]}`);
  console.log("");
  console.log("After lower PR merged:");
  console.log(`  ${urls[3]}`);
  console.log(`  ${urls[4]}`);
  console.log("");
  console.log("Press Ctrl+C to stop.");

  const shutdown = async () => {
    await cleanupTempDirs(tempDirs);
    await server.mf.dispose();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

try {
  await main();
} catch (error) {
  await cleanupTempDirs(tempDirs);
  await server.mf.dispose();
  throw error;
}
