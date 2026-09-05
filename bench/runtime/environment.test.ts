import { describe, expect, it } from "vitest";
import {
  browserEnvironment,
  laptopEnvironment,
  serverEnvironment,
  slackEnvironment,
  SyntheticCapabilityEnvironment,
} from "./environment";
import { SyntheticTargetRegistry } from "./target-registry";

describe("synthetic capability environments", () => {
  it("implements deterministic filesystem and shell state", async () => {
    const laptop = laptopEnvironment({
      id: "laptop",
      ownerUid: 1000,
      accessGids: [1000],
      online: true,
      files: {
        "/workspace/app.txt": "before\nneedle\n",
      },
      commands: {
        "build app": {
          output: "built\n",
          effects: [
            { type: "state.set", key: "build", value: "passed" },
            { type: "file.write", path: "/workspace/artifact.txt", content: "ok\n" },
          ],
        },
      },
    });

    const read = await laptop.invoke("fs.read", {
      path: "/workspace/app.txt",
      target: "laptop",
    });
    expect(read.isError).toBe(false);
    expect(JSON.stringify(read.value)).toContain("     2\\tneedle");

    const edit = await laptop.invoke("fs.edit", {
      path: "/workspace/app.txt",
      oldString: "before",
      newString: "after",
      target: "laptop",
    });
    expect(edit.value).toMatchObject({ ok: true, replacements: 1 });

    const search = await laptop.invoke("fs.search", {
      path: "/workspace",
      query: "after",
      include: "*.txt",
      target: "laptop",
    });
    expect(search.value).toMatchObject({ ok: true, count: 1 });

    const build = await laptop.invoke("shell.exec", {
      input: "build app",
      target: "laptop",
    });
    expect(build.value).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(laptop.snapshot()).toMatchObject({
      state: { build: "passed" },
      files: { "/workspace/artifact.txt": "ok\n" },
    });
  });

  it("provides truthful defaults for each environment family", () => {
    const common = {
      ownerUid: 1000,
      accessGids: [1000],
      online: true,
    };
    const browser = browserEnvironment({ ...common, id: "browser" });
    const slack = slackEnvironment({ ...common, id: "slack" });
    const server = serverEnvironment({ ...common, id: "server" });

    expect(browser.snapshot()).toMatchObject({
      kind: "browser",
      platform: "browser",
      implements: ["fs.*", "shell.exec"],
    });
    expect(slack.snapshot()).toMatchObject({
      kind: "slack",
      platform: "slack",
      implements: ["shell.exec"],
    });
    expect(server.snapshot()).toMatchObject({
      kind: "server",
      platform: "linux",
      implements: ["fs.*", "shell.exec"],
    });
  });

  it("constructs registered special targets through the shared driver seam", () => {
    const registry = new SyntheticTargetRegistry();
    registry.register("special-test", (spec) => new SyntheticCapabilityEnvironment({
      ...spec,
      state: { installedBy: "special-test" },
    }));
    const environment = registry.create({
      id: "special",
      kind: "server",
      driver: "special-test",
      ownerUid: 1000,
      accessGids: [1000],
      online: true,
    });

    expect(environment.snapshot()).toMatchObject({
      id: "special",
      driver: "special-test",
      state: { installedBy: "special-test" },
    });
    expect(() => registry.create({
      id: "unknown",
      kind: "server",
      driver: "missing",
      ownerUid: 1000,
      accessGids: [1000],
      online: true,
    })).toThrow("Unknown synthetic target driver: missing");
  });
});
