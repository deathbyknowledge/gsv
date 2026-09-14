import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const marker = "<!-- gsv-pr-preview -->";

export function positiveInteger(value, label) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]{0,14}$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`Invalid ${label}`);
  }
  return text;
}

export function githubClient(repository, token, fetcher = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
    throw new Error("A GitHub repository and token are required");
  }
  return async (path, options = {}) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
      ...options,
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  };
}

/** Recheck live metadata inside the per-PR lock; queued jobs never deploy stale heads. */
export async function resolvePreview(api, { number, repositoryId, headSha, action = "deploy" }) {
  number = positiveInteger(number, "pull request number");
  repositoryId = positiveInteger(repositoryId, "repository ID");
  if (!["deploy", "destroy"].includes(action)) throw new Error("Invalid preview action");
  if (action === "deploy" && !/^[a-f0-9]{40}$/.test(headSha ?? "")) throw new Error("An exact head SHA is required");
  const pr = await api(`/pulls/${number}`);
  if (String(pr.number) !== number || String(pr.base?.repo?.id) !== repositoryId) {
    throw new Error("Pull request repository identity changed");
  }
  const allowed = action === "destroy"
    ? pr.state === "closed"
    : pr.state === "open" && pr.base.ref === "main"
      && String(pr.head?.repo?.id) === repositoryId && pr.head.sha === headSha;
  return { eligible: allowed, number, repositoryId, headSha: pr.head?.sha ?? "" };
}

export async function closedPreviews(api, numbers, repositoryId) {
  const closed = [];
  for (const number of numbers) {
    if ((await resolvePreview(api, { number, repositoryId, action: "destroy" })).eligible) closed.push(String(number));
  }
  return closed;
}

export function previewComment({ status, number, headSha, url, runUrl }) {
  positiveInteger(number, "pull request number");
  if (!["building", "ready", "failed", "deleted"].includes(status)) throw new Error("Invalid preview status");
  if (headSha && !/^[a-f0-9]{40}$/.test(headSha)) throw new Error("Invalid preview revision");
  const safeUrl = (value, label) => {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash
      || /[\s<>"()\\]/.test(value)) throw new Error(`Invalid ${label}`);
    return value;
  };
  const lines = [marker, `**GSV preview · ${status}**`];
  if (headSha) lines.push(`Revision: \`${headSha.slice(0, 12)}\``);
  if (status === "ready") {
    lines.push(`[Open preview](${safeUrl(url, "preview URL")})`,
      "Sign in with your company identity, create a space, and complete normal onboarding. AI is included.",
      "This preview keeps its data across updates and is deleted when the PR closes.");
  } else if (status === "building") {
    lines.push("The preview is updating. A link will appear here when it is ready.");
  } else if (status === "failed") {
    lines.push("This revision's preview did not become ready. An earlier deployment may still be running.");
  } else {
    lines.push("The preview's resources have been removed.");
  }
  if (runUrl) lines.push(`[Workflow run](${safeUrl(runUrl, "workflow URL")})`);
  return lines.join("\n\n");
}

export async function publishPreview(api, input) {
  const number = positiveInteger(input.number, "pull request number");
  const body = previewComment(input);
  // The bot identity matters: a PR author cannot nominate someone else's comment for editing.
  for (let page = 1; ; page++) {
    const comments = await api(`/issues/${number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error("Invalid GitHub comments response");
    const existing = comments.find((comment) => comment.user?.login === "github-actions[bot]"
      && comment.body?.startsWith(marker));
    if (existing) {
      await api(`/issues/comments/${positiveInteger(existing.id, "comment ID")}`, { method: "PATCH", body: JSON.stringify({ body }) });
      return;
    }
    if (comments.length < 100) break;
  }
  await api(`/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}

async function main() {
  const env = process.env;
  const api = githubClient(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN);
  const output = (name, value) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
    else process.stdout.write(`${name}=${value}\n`);
  };
  switch (process.argv[2]) {
    case "resolve": {
      const result = await resolvePreview(api, { number: env.GSV_PREVIEW_NUMBER,
        repositoryId: env.GITHUB_REPOSITORY_ID, headSha: env.GSV_PREVIEW_HEAD_SHA,
        action: env.GSV_PREVIEW_ACTION ?? "deploy" });
      for (const [key, value] of Object.entries(result)) output(key, String(value));
      break;
    }
    case "closed": {
      const numbers = JSON.parse(readFileSync(process.argv[3], "utf8"));
      if (!Array.isArray(numbers)) throw new Error("Expected a list of preview numbers");
      output("numbers", JSON.stringify(await closedPreviews(api, numbers, env.GITHUB_REPOSITORY_ID)));
      break;
    }
    case "publish":
      await publishPreview(api, { status: env.GSV_PREVIEW_STATUS, number: env.GSV_PREVIEW_NUMBER,
        headSha: env.GSV_PREVIEW_HEAD_SHA, url: env.GSV_PREVIEW_URL,
        runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` });
      break;
    default: throw new Error("Use resolve, closed <file>, or publish");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
