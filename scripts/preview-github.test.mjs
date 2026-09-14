import assert from "node:assert/strict";
import test from "node:test";
import { closedPreviews, githubClient, positiveInteger, previewComment, publishPreview, resolvePreview } from "./preview-github.mjs";

const sha = "a".repeat(40);
const input = { number: "12", repositoryId: "123", headSha: sha };
const pull = (overrides = {}) => ({ number: 12, state: "open", base: { ref: "main", repo: { id: 123 } },
  head: { sha, repo: { id: 123 } }, ...overrides });

test("only the current open same-repository head can deploy", async () => {
  assert.equal((await resolvePreview(async () => pull(), input)).eligible, true);
  for (const changed of [pull({ state: "closed" }), pull({ head: { sha: "b".repeat(40), repo: { id: 123 } } }),
    pull({ head: { sha, repo: { id: 456 } } }), pull({ head: { sha, repo: null } }),
    pull({ base: { ref: "different", repo: { id: 123 } } })]) {
    assert.equal((await resolvePreview(async () => changed, input)).eligible, false);
  }
  await assert.rejects(resolvePreview(async () => pull({ base: { repo: { id: 456 } } }), input), /identity/);
  await assert.rejects(resolvePreview(async () => pull(), { ...input, headSha: "main" }), /exact head/);
});

test("cleanup rechecks closure so reopening protects a queued preview", async () => {
  assert.equal((await resolvePreview(async () => pull(), { ...input, action: "destroy" })).eligible, false);
  assert.equal((await resolvePreview(async () => pull({ state: "closed", head: { repo: null } }),
    { ...input, action: "destroy" })).eligible, true);
  assert.deepEqual(await closedPreviews(async () => pull({ state: "closed" }), [12], "123"), ["12"]);
  await assert.rejects(closedPreviews(async () => { throw new Error("unavailable"); }, [12], "123"), /unavailable/);
});

test("identities and URLs cannot inject shell, output, or credential fragments", () => {
  for (const value of ["", "0", "-1", "1\nnumber=2", "1;echo", "9007199254740993"]) {
    assert.throws(() => positiveInteger(value, "number"));
  }
  for (const url of ["http://example.com", "https://user:secret@example.com", "https://example.com/#secret",
    "https://example.com/)\n[bad](https://other.com)"]) {
    assert.throws(() => previewComment({ status: "ready", number: "12", headSha: sha, url }));
  }
});

test("sticky comments update only our bot's marker and support pagination", async () => {
  const writes = [];
  const api = async (path, options) => {
    if (options) { writes.push({ path, ...options }); return {}; }
    if (path.endsWith("page=1")) return Array.from({ length: 100 }, () => ({ id: 1,
      user: { login: "someone" }, body: "<!-- gsv-pr-preview -->" }));
    return [{ id: 77, user: { login: "github-actions[bot]" }, body: "<!-- gsv-pr-preview -->\nold" }];
  };
  await publishPreview(api, { number: "12", status: "ready", headSha: sha, url: "https://accounts.pr-12.example.com/admin/installations" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/issues/comments/77");
  assert.match(JSON.parse(writes[0].body).body, /normal onboarding/);
});

test("failed deployment cannot leave a sticky comment claiming this revision is ready", () => {
  const body = previewComment({ number: "12", status: "failed", headSha: sha });
  assert.match(body, /did not become ready/);
  assert.doesNotMatch(body, /Open preview/);
});

test("GitHub API requests do not follow redirects or expose response bodies", async () => {
  const api = githubClient("example/gsv", "secret", async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer secret");
    return new Response("private content", { status: 403 });
  });
  await assert.rejects(api("/pulls/12"), { message: "GitHub request failed (403)" });
});
