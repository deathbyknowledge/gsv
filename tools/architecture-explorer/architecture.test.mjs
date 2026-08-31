import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import {
  ARCHITECTURE_EDGES,
  ARCHITECTURE_FLOWS,
  ARCHITECTURE_SOURCE_GUIDES,
  ARCHITECTURE_SUBSYSTEMS,
} from "./architecture.mjs";
import {
  ATLAS_LENSES,
  ATLAS_SYSTEM_DETAIL,
  ATLAS_TOUR_NOTES,
  ATLAS_ZONES,
} from "./atlas-meta.mjs";
import {
  createArchitectureExplorerServer,
  REPO_ROOT,
  resolveGitHubSourceMetadata,
} from "./server.mjs";

const REQUIRED_SUBSYSTEM_IDS = [
  "gateway",
  "kernel",
  "process",
  "conversation",
  "protocol",
  "native-target",
  "inference",
  "sdk",
  "services",
  "web",
  "host",
  "adapters",
  "extension",
  "ripgit",
  "deployment",
];
const REQUIRED_EDGE_IDS = [
  "deployment-services",
  "deployment-gateway",
  "deployment-adapters",
  "deployment-ripgit",
  "services-gateway",
  "sdk-protocol",
  "sdk-gateway",
  "protocol-gateway",
  "adapters-gateway",
  "kernel-adapters",
  "kernel-ripgit",
  "native-ripgit",
];
const ADAPTER_CATALOG_IDS = ["discord", "slack", "telegram", "whatsapp"];

function allReferencedPaths() {
  const paths = new Set(ARCHITECTURE_SOURCE_GUIDES);
  for (const subsystem of ARCHITECTURE_SUBSYSTEMS) {
    paths.add(subsystem.sourceRoot);
    for (const component of subsystem.components) {
      for (const path of component.paths) paths.add(path);
    }
    const detail = ATLAS_SYSTEM_DETAIL[subsystem.id];
    for (const path of detail.docs) paths.add(path);
    for (const path of detail.tests) paths.add(path);
  }
  return [...paths];
}

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function requireSubsystem(id) {
  const subsystem = ARCHITECTURE_SUBSYSTEMS.find((candidate) => candidate.id === id);
  assert.ok(subsystem, `missing required subsystem ${id}`);
  return subsystem;
}

function requireComponent(subsystemId, componentId) {
  const component = requireSubsystem(subsystemId).components.find(
    (candidate) => candidate.id === componentId,
  );
  assert.ok(component, `missing required component ${subsystemId}/${componentId}`);
  return component;
}

function quotedTypeMembers(source, typeName) {
  const declaration = source.match(
    new RegExp(`export type ${typeName} =([\\s\\S]*?);`),
  );
  assert.ok(declaration, `could not find ${typeName}`);
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("the architecture graph has unique and complete identities", () => {
  const subsystemIds = ARCHITECTURE_SUBSYSTEMS.map((subsystem) => subsystem.id);
  assert.equal(new Set(subsystemIds).size, subsystemIds.length);
  assert.ok(ARCHITECTURE_SUBSYSTEMS.length >= 15);
  for (const id of REQUIRED_SUBSYSTEM_IDS) {
    assert.ok(subsystemIds.includes(id), `required subsystem ${id} is absent`);
  }

  for (const subsystem of ARCHITECTURE_SUBSYSTEMS) {
    assert.ok(subsystem.summary.length > 40, `${subsystem.id} needs a substantive summary`);
    assert.ok(subsystem.boundary.length > 40, `${subsystem.id} needs an explicit boundary`);
    assert.ok(subsystem.invariant.length > 40, `${subsystem.id} needs an explicit invariant`);
    assert.ok(subsystem.components.length >= 4, `${subsystem.id} needs component coverage`);
    const componentIds = subsystem.components.map((component) => component.id);
    assert.equal(new Set(componentIds).size, componentIds.length, `${subsystem.id} component IDs must be unique`);
    for (const component of subsystem.components) {
      assert.ok(component.summary.length > 30, `${subsystem.id}/${component.id} needs an explanation`);
      assert.ok(component.mechanics.length >= 2, `${subsystem.id}/${component.id} needs mechanics`);
      assert.ok(component.paths.length >= 1, `${subsystem.id}/${component.id} needs source evidence`);
    }
  }
});

test("edges and guided traces address real systems and components", () => {
  const systems = new Map(ARCHITECTURE_SUBSYSTEMS.map((subsystem) => [subsystem.id, subsystem]));
  const edgeIds = ARCHITECTURE_EDGES.map((edge) => edge.id);
  assert.equal(new Set(edgeIds).size, edgeIds.length);
  for (const id of REQUIRED_EDGE_IDS) {
    assert.ok(edgeIds.includes(id), `required architecture edge ${id} is absent`);
  }
  for (const edge of ARCHITECTURE_EDGES) {
    assert.ok(systems.has(edge.from), `${edge.id} has an unknown source`);
    assert.ok(systems.has(edge.to), `${edge.id} has an unknown destination`);
    assert.notEqual(edge.from, edge.to, `${edge.id} must cross a subsystem boundary`);
  }

  const flowIds = ARCHITECTURE_FLOWS.map((flow) => flow.id);
  assert.equal(new Set(flowIds).size, flowIds.length);
  for (const flow of ARCHITECTURE_FLOWS) {
    assert.ok(flow.steps.length >= 4, `${flow.id} is too short to explain an end-to-end flow`);
    assert.ok(ATLAS_TOUR_NOTES[flow.id], `${flow.id} needs a thesis and warning`);
    for (const step of flow.steps) {
      const subsystem = systems.get(step.subsystemId);
      assert.ok(subsystem, `${flow.id} addresses unknown subsystem ${step.subsystemId}`);
      if (step.componentId) {
        assert.ok(
          subsystem.components.some((component) => component.id === step.componentId),
          `${flow.id} addresses unknown component ${step.subsystemId}/${step.componentId}`,
        );
      }
    }
  }
});

test("every landmark declares ownership, lifecycle, and evidence", () => {
  assert.deepEqual(ATLAS_LENSES.map((lens) => lens.id), ["runtime", "ownership", "security", "durability"]);
  assert.deepEqual(ATLAS_ZONES.map((zone) => zone.id), ["installation", "boundary", "outer"]);
  for (const subsystem of ARCHITECTURE_SUBSYSTEMS) {
    const detail = ATLAS_SYSTEM_DETAIL[subsystem.id];
    assert.ok(detail, `${subsystem.id} is missing atlas metadata`);
    assert.ok(detail.scope.length > 5, `${subsystem.id}.scope is incomplete`);
    for (const field of ["runtime", "owner"]) {
      assert.ok(detail[field]?.length > 10, `${subsystem.id}.${field} is incomplete`);
    }
    for (const field of ["persistence", "admission", "completion"]) {
      assert.ok(detail[field]?.length > 40, `${subsystem.id}.${field} is incomplete`);
    }
    assert.ok(detail.security.length >= 3, `${subsystem.id} needs separate security facts`);
    assert.ok(detail.docs.length >= 2, `${subsystem.id} needs architecture evidence`);
    assert.ok(detail.tests.length >= 2, `${subsystem.id} needs executable evidence`);
    for (const coordinate of ["x", "z", "width", "depth", "height"]) {
      assert.ok(Number.isFinite(detail.scene[coordinate]), `${subsystem.id}.scene.${coordinate} is invalid`);
    }
  }
  assert.deepEqual(Object.keys(ATLAS_SYSTEM_DETAIL).sort(), ARCHITECTURE_SUBSYSTEMS.map(({ id }) => id).sort());
});

test("all evidence paths exist inside the repository", async () => {
  for (const path of allReferencedPaths()) {
    const absolutePath = resolve(REPO_ROOT, path);
    const repositoryRelative = relative(REPO_ROOT, absolutePath);
    assert.ok(
      repositoryRelative !== ".." && !repositoryRelative.startsWith(`..${sep}`),
      `${path} escapes the repository`,
    );
    await assert.doesNotReject(stat(absolutePath), `${path} does not exist`);
  }
});

test("the adapter district distinguishes catalog workers, managed variants, and fixtures", async () => {
  const adapterRoot = join(REPO_ROOT, "adapters");
  const entries = await readdir(adapterRoot, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(adapterRoot, entry.name, "adapter.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.id, entry.name, `${manifestPath} has a mismatched adapter id`);
      manifests.push(manifest);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  assert.deepEqual(manifests.map(({ id }) => id).sort(), ADAPTER_CATALOG_IDS);
  assert.deepEqual(
    manifests.filter(({ managed }) => managed).map(({ id }) => id).sort(),
    ["slack", "telegram"],
  );

  for (const adapter of ADAPTER_CATALOG_IDS) {
    const component = requireComponent("adapters", adapter);
    assert.ok(
      component.paths.some((path) => path.startsWith(`adapters/${adapter}/`)),
      `${adapter} is absent from the adapter district`,
    );
  }

  const managedPaths = {
    telegram: [
      "adapters/telegram/src/managed-http.ts",
      "adapters/telegram/src/managed-peer.ts",
      "adapters/telegram/src/managed-pairing.ts",
    ],
    slack: [
      "adapters/slack/src/managed-workspace.ts",
      "adapters/slack/src/managed-peer.ts",
      "adapters/slack/src/slack-target-shell.ts",
    ],
  };
  for (const [adapter, expectedPaths] of Object.entries(managedPaths)) {
    const paths = requireComponent("adapters", adapter).paths;
    for (const path of expectedPaths) {
      assert.ok(paths.includes(path), `${adapter} is missing managed evidence ${path}`);
    }
  }

  const manifestIds = manifests.map(({ id }) => id);
  assert.ok(!manifestIds.includes("email"), "managed mail must not enter the adapter catalog");
  assert.ok(!manifestIds.includes("test"), "the test fixture must not enter the adapter catalog");
  assert.ok(
    requireComponent("adapters", "email").paths.some((path) => path.startsWith("adapters/email/")),
    "managed mail evidence is absent from the adapter district",
  );
  assert.ok(
    requireComponent("adapters", "test-adapter").paths.some((path) => path.startsWith("adapters/test/")),
  );
});

test("deployment landmarks retain manifest and catalog evidence", () => {
  const expectedEvidence = {
    "runtime-manifest": ["deployment/runtime.json", "deployment/src/manifest.ts"],
    "adapter-catalog": [
      "scripts/adapter-catalog.mjs",
      "adapters/discord/adapter.json",
      "adapters/slack/adapter.json",
      "adapters/telegram/adapter.json",
      "adapters/whatsapp/adapter.json",
      "deployment/src/adapter.ts",
    ],
    "release-bundles": [
      "scripts/build-cloudflare-bundles.sh",
      "scripts/build-deployment-manifest.mjs",
    ],
    "runtime-composition": ["alchemy.run.ts", "deployment/src/runtime.ts", "deployment/src/standalone.ts"],
  };
  for (const [componentId, expectedPaths] of Object.entries(expectedEvidence)) {
    const paths = requireComponent("deployment", componentId).paths;
    for (const path of expectedPaths) {
      assert.ok(paths.includes(path), `deployment/${componentId} is missing ${path}`);
    }
  }
});

test("source contracts underlying the atlas have not drifted", async () => {
  const conversationSource = await readFile(
    join(REPO_ROOT, "packages/gsv/src/protocol/syscalls/conversation.ts"),
    "utf8",
  );
  assert.deepEqual(
    quotedTypeMembers(conversationSource, "ConversationKind"),
    ["ship", "work", "group", "contact"],
  );

  const toolSource = await readFile(
    join(REPO_ROOT, "gateway/src/syscalls/constants.ts"),
    "utf8",
  );
  const toolMap = toolSource.match(
    /export const SYSCALL_TOOL_NAMES = \{([\s\S]*?)\} satisfies/,
  );
  assert.ok(toolMap, "could not find SYSCALL_TOOL_NAMES");
  assert.deepEqual(
    [...toolMap[1].matchAll(/\]: "([^"]+)"/g)].map((match) => match[1]),
    ["Read", "Write", "Edit", "Delete", "Search", "Shell", "CodeMode"],
  );

  const nativeTargetSource = await readFile(
    join(REPO_ROOT, "gateway/src/drivers/native/target.ts"),
    "utf8",
  );
  assert.deepEqual(
    [...nativeTargetSource.matchAll(/case "([^"]+)":/g)].map((match) => match[1]),
    [
      "fs.read",
      "fs.write",
      "fs.edit",
      "fs.delete",
      "fs.search",
      "fs.copy",
      "fs.transfer.stat",
      "fs.transfer.send",
      "fs.transfer.receive",
      "shell.exec",
      "net.fetch",
    ],
  );

  const mountSources = {
    kernel: await readFile(join(REPO_ROOT, "gateway/src/fs/backends/kernel.ts"), "utf8"),
    gsv: await readFile(join(REPO_ROOT, "gateway/src/fs/gsv-fs.ts"), "utf8"),
    media: await readFile(join(REPO_ROOT, "gateway/src/shared/process-media-path.ts"), "utf8"),
    source: await readFile(join(REPO_ROOT, "gateway/src/fs/backends/process-sources.ts"), "utf8"),
    home: await readFile(join(REPO_ROOT, "gateway/src/fs/backends/account-home.ts"), "utf8"),
  };
  for (const path of ["/proc", "/dev", "/sys", "/etc"]) {
    assert.match(mountSources.kernel, new RegExp(`p === "${path}"`));
  }
  assert.match(mountSources.gsv, /normalized === "\/var"/);
  assert.match(mountSources.gsv, /return this\.r2Backend/);
  assert.match(mountSources.media, /PROCESS_MEDIA_ROOT = "\/var\/media"/);
  assert.match(mountSources.source, /normalized === "\/src"/);
  assert.match(mountSources.home, /normalized === "\/home"/);
  assert.match(mountSources.home, /normalized === "\/root"/);

  const nativeAtlas = JSON.stringify(requireSubsystem("native-target"));
  for (const path of ["/proc", "/dev", "/sys", "/etc", "/src/repos", "/workspaces"]) {
    assert.match(nativeAtlas, new RegExp(path.replace("/", "\\/")));
  }
  assert.match(nativeAtlas, /account homes/);
  assert.match(nativeAtlas, /\/workspaces.*ordinary R2/);
});

test("the explorer remains outside the product Web bundle", async () => {
  const files = ["index.html", "app.js", "styles.css", "architecture.mjs", "atlas-meta.mjs", "server.mjs"];
  const combined = (await Promise.all(files.map((file) => readFile(join(REPO_ROOT, "tools/architecture-explorer", file), "utf8")))).join("\n");
  assert.doesNotMatch(combined, /web\/src\/app\/features\/architecture/);
  assert.doesNotMatch(combined, /\/architecture(?:["'`?])/);
  assert.doesNotMatch(combined, /style=|\.style\b/, "strict CSP requires external presentation rules");
});

test("tracked GitHub metadata prefers a remote ref and strips remote credentials", async () => {
  const metadata = await resolveGitHubSourceMetadata(async (args) => {
    if (args[0] === "symbolic-ref" && args.at(-1) === "HEAD") return "feature/atlas";
    if (args[0] === "for-each-ref") return "fork\trefs/heads/feature/atlas";
    if (args.join(" ") === "remote get-url fork") {
      return "https://secret-token@github.com/example/gsv.git";
    }
    throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
  });
  assert.deepEqual(metadata, {
    sourceBase: "https://github.com/example/gsv",
    sha: "feature/atlas",
  });
});

test("GitHub metadata falls back to a remote default branch and then the canonical source", async () => {
  const remoteDefault = await resolveGitHubSourceMetadata(async (args) => {
    if (args[0] === "symbolic-ref" && args.at(-1) === "HEAD") {
      throw new Error("detached");
    }
    if (args.length === 1 && args[0] === "remote") return "origin";
    if (args.join(" ") === "remote get-url origin") return "git@github.com:example/gsv.git";
    if (args.at(-1) === "refs/remotes/origin/HEAD") return "origin/trunk";
    throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
  });
  assert.deepEqual(remoteDefault, {
    sourceBase: "https://github.com/example/gsv",
    sha: "trunk",
  });

  const canonical = await resolveGitHubSourceMetadata(async () => {
    throw new Error("git unavailable");
  });
  assert.deepEqual(canonical, {
    sourceBase: "https://github.com/deathbyknowledge/gsv",
    sha: "main",
  });
});

test("the local server exposes only allowlisted explorer assets", async (context) => {
  const server = createArchitectureExplorerServer({
    metadata: async () => ({
      sourceBase: "https://github.com/example/gsv",
      sha: "feature/atlas",
    }),
  });
  context.after(() => server.close());
  const origin = await listen(server);

  const index = await fetch(origin);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await index.text(), /GSV Architecture Explorer/);

  const meta = await fetch(`${origin}/api/meta`).then((response) => response.json());
  assert.deepEqual(meta, {
    sourceBase: "https://github.com/example/gsv",
    sha: "feature/atlas",
  });

  const sourceAttempt = await fetch(`${origin}/AGENTS.md`);
  assert.equal(sourceAttempt.status, 404);
  const mutationAttempt = await fetch(origin, { method: "POST" });
  assert.equal(mutationAttempt.status, 405);
});
