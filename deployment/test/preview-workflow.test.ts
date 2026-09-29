import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/preview.yml", import.meta.url), "utf8");
const tracking = workflow.match(/      - name: Record the preview deployment\n        if: ([^\n]+)\n[\s\S]*?          script: \|\n((?: {12}[^\n]*\n)+)/);
if (!tracking) throw new Error("Preview deployment step is missing");
const condition = tracking[1];
const script = tracking[2].replace(/^ {12}/gm, "");

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
