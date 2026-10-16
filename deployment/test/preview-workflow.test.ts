import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/preview.yml", import.meta.url), "utf8");
const tracking = workflow.match(/      - name: Record the preview deployment\n        if: ([^\n]+)\n[\s\S]*?          script: \|\n((?: {12}[^\n]*\n)+)/);
if (!tracking) throw new Error("Preview deployment step is missing");
const condition = tracking[1];
const script = tracking[2].replace(/^ {12}/gm, "");
const admission = workflow.match(/  preview:\n    if: >-\n([\s\S]*?)    runs-on:/);
const current = workflow.match(/        id: current\n[\s\S]*?          script: \|\n((?: {12}[^\n]*\n)+)/);
if (!admission || !current) throw new Error("Preview admission step is missing");
const admissionCondition = admission[1];
const currentScript = current[1].replace(/^ {12}/gm, "");

async function previewCommand(options: {
  base?: string;
  event?: string;
  action?: string;
  previousBase?: string | null;
  enabled?: boolean;
  fork?: boolean;
  state?: string;
  stale?: boolean;
  account?: string;
} = {}) {
  const repository = { full_name: "example/gsv" };
  const head = { sha: "a".repeat(40), repo: options.fork ? { full_name: "fork/gsv" } : repository };
  const pr = { head, base: { ref: options.base ?? "main" }, state: options.state ?? "open" };
  const eventName = options.event ?? "pull_request";
  const payload = {
    repository, pull_request: pr, action: options.action ?? "synchronize",
    changes: { base: { ref: { from: options.previousBase ?? null } } },
  };
  const outputs: Record<string, string> = {};
  if (!runInNewContext(admissionCondition, {
    github: { repository: repository.full_name, event_name: eventName, event: payload },
    vars: { GSV_PREVIEWS_ENABLED: String(options.enabled ?? true) },
  })) return outputs;
  await runInNewContext(`(async () => {\n${currentScript}\n})()`, {
    github: { rest: { pulls: { get: async () => ({
      data: { ...pr, head: { ...head, sha: options.stale ? "b".repeat(40) : head.sha } },
    }) } } },
    context: { repo: { owner: "example", repo: "gsv" }, issue: { number: 41 }, eventName, payload },
    process: { env: { CLOUDFLARE_ACCOUNT_ID: options.account ?? "preview-account" } },
    core: { setOutput: (key: string, value: string) => { outputs[key] = value; }, notice: () => {} },
  });
  return outputs;
}

describe("GitHub preview admission", () => {
  it("listens for same-repository PRs regardless of their base branch", () => {
    const trigger = workflow.match(/  pull_request:\n([\s\S]*?)  pull_request_target:/)?.[1];
    expect(trigger).toContain("synchronize");
    expect(trigger).not.toMatch(/branches/);
  });

  it.each(["main", "friendly-popup"])("deploys the current head with base %s", async (base) => {
    expect(await previewCommand({ base })).toEqual({ command: "deploy", ref: "a".repeat(40) });
  });

  it("redeploys instead of destroying a preview when its base changes", async () => {
    expect(await previewCommand({ base: "friendly-popup", action: "edited", previousBase: "main" }))
      .toEqual({ command: "deploy", ref: "a".repeat(40) });
    expect(await previewCommand({ event: "pull_request_target", action: "edited", previousBase: "main" }))
      .toEqual({});
  });

  it.each([
    { fork: true }, { enabled: false }, { stale: true }, { state: "closed" }, { action: "edited" },
  ])("skips ineligible or obsolete deploys: %j", async (options) => {
    expect(await previewCommand(options)).toEqual({});
  });

  it("cleans closed stacked PRs using trusted main even when new previews are disabled", async () => {
    expect(await previewCommand({
      base: "friendly-popup", event: "pull_request_target", action: "closed", state: "closed", enabled: false,
    })).toEqual({ command: "destroy", ref: "main" });
  });

  it.each([{ state: "open" }, { fork: true }, { account: "" }])("skips ineligible cleanup: %j", async (options) => {
    expect(await previewCommand({
      event: "pull_request_target", action: "closed", state: "closed", ...options,
    })).toEqual({});
  });
});

interface DeploymentInput {
  environment: string;
  ref: string;
  transient_environment: boolean;
  production_environment: boolean;
  auto_merge: boolean;
  required_contexts: string[];
}

interface DeploymentStatus {
  deployment_id: number;
  state: string;
  auto_inactive: boolean;
  environment_url: string;
  log_url: string;
  description: string;
}

interface Deployment extends DeploymentInput {
  id: number;
  statuses: DeploymentStatus[];
}

interface DeploymentQuery {
  environment: string;
  per_page: number;
}

interface StatusQuery {
  deployment_id: number;
  per_page: number;
}

class GitHubDeployments {
  records: Deployment[] = [];
  failStatus = "";

  rest = {
    repos: {
      createDeployment: async (input: DeploymentInput) => {
        const deployment = { ...input, id: this.records.length + 1, statuses: [] };
        this.records.push(deployment);
        return { data: deployment };
      },
      createDeploymentStatus: async (input: DeploymentStatus) => {
        if (input.state === this.failStatus) throw new Error("GitHub status unavailable");
        this.record(input.deployment_id).statuses.unshift(input);
        return { data: input };
      },
      listDeployments: async (input: DeploymentQuery) => ({
        data: this.records.filter((record) => record.environment === input.environment),
      }),
      listDeploymentStatuses: async (input: StatusQuery) => ({
        data: this.record(input.deployment_id).statuses.slice(0, input.per_page),
      }),
    },
  };

  async paginate(request: (input: DeploymentQuery) => Promise<{ data: Deployment[] }>, input: DeploymentQuery) {
    return (await request(input)).data;
  }

  record(id: number): Deployment {
    const record = this.records.find((deployment) => deployment.id === id);
    if (!record) throw new Error("Unknown deployment");
    return record;
  }
}

async function recordPreview(github: GitHubDeployments, number: number, command: string, succeeded = true) {
  if (!runInNewContext(condition, {
    success: () => succeeded,
    steps: { current: { outputs: { command } } },
  })) return;
  await runInNewContext(`(async () => {\n${script}\n})()`, {
    github,
    context: {
      repo: { owner: "example", repo: "gsv" },
      issue: { number },
      payload: { pull_request: { head: { sha: "a".repeat(40) } } },
      serverUrl: "https://github.com",
      runId: 123,
    },
    process: { env: { ALCHEMY_COMMAND: command, GSV_PREVIEW_BASE_DOMAIN: "preview.example.com" } },
  });
}

describe("GitHub preview lifecycle", () => {
  it("publishes the deployed revision as a transient preview with its URL and run log", async () => {
    const github = new GitHubDeployments();
    await recordPreview(github, 41, "deploy");
    expect(github.records).toHaveLength(1);
    expect(github.record(1)).toMatchObject({
      environment: "gsv-preview-pr-41", ref: "a".repeat(40),
      transient_environment: true, production_environment: false,
      auto_merge: false, required_contexts: [],
      statuses: [{ state: "success", auto_inactive: false,
        environment_url: "https://accounts.pr-41.preview.example.com/admin/installations",
        log_url: "https://github.com/example/gsv/actions/runs/123" }],
    });
  });

  it("supersedes, destroys and reopens one PR without changing another PR's preview", async () => {
    const github = new GitHubDeployments();
    await recordPreview(github, 41, "deploy");
    await recordPreview(github, 42, "deploy");
    await recordPreview(github, 41, "deploy");
    expect(github.record(1).statuses[0].state).toBe("inactive");
    expect(github.record(2).statuses[0].state).toBe("success");
    expect(github.record(3).statuses[0].state).toBe("success");

    await recordPreview(github, 41, "destroy");
    await recordPreview(github, 41, "destroy");
    expect(github.records).toHaveLength(3);
    expect(github.record(1).statuses).toHaveLength(2);
    expect(github.record(2).statuses[0].state).toBe("success");
    expect(github.record(3).statuses).toHaveLength(2);
    expect(github.record(3).statuses[0]).toMatchObject({
      state: "inactive", environment_url: "", description: "Preview removed",
    });

    await recordPreview(github, 41, "deploy");
    expect(github.records).toHaveLength(4);
    expect(github.record(3).statuses[0].state).toBe("inactive");
    expect(github.record(4).statuses[0].state).toBe("success");
  });

  it("does not publish failed updates, retire previews after failed cleanup, or record skipped jobs", async () => {
    const github = new GitHubDeployments();
    await recordPreview(github, 41, "deploy");
    await recordPreview(github, 41, "deploy", false);
    await recordPreview(github, 41, "destroy", false);
    await recordPreview(github, 41, "");
    expect(github.records).toHaveLength(1);
    expect(github.record(1).statuses).toHaveLength(1);
    expect(github.record(1).statuses[0].state).toBe("success");
  });

  it("does not invent a deployment when cleaning up a PR with no preview", async () => {
    const github = new GitHubDeployments();
    await recordPreview(github, 41, "destroy");
    expect(github.records).toEqual([]);
  });

  it("keeps the previous preview active if publishing its replacement fails", async () => {
    const github = new GitHubDeployments();
    await recordPreview(github, 41, "deploy");
    github.failStatus = "success";
    await expect(recordPreview(github, 41, "deploy")).rejects.toThrow("GitHub status unavailable");
    expect(github.record(1).statuses[0].state).toBe("success");

    github.failStatus = "";
    await recordPreview(github, 41, "deploy");
    expect(github.record(1).statuses[0].state).toBe("inactive");
    expect(github.record(2).statuses[0].state).toBe("inactive");
    expect(github.record(3).statuses[0].state).toBe("success");
  });

  it("surfaces a failed status update and completes cleanup on retry", async () => {
    const github = new GitHubDeployments();
    await recordPreview(github, 41, "deploy");
    github.failStatus = "inactive";
    await expect(recordPreview(github, 41, "destroy")).rejects.toThrow("GitHub status unavailable");
    expect(github.record(1).statuses[0].state).toBe("success");

    github.failStatus = "";
    await recordPreview(github, 41, "destroy");
    expect(github.record(1).statuses[0].state).toBe("inactive");
  });
});
