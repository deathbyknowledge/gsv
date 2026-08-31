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
  ATLAS_ARCHETYPES,
  ATLAS_CONCEPTS,
  ATLAS_DISTRICTS,
  ATLAS_LENSES,
  ATLAS_SYSTEM_DETAIL,
  ATLAS_TOUR_NOTES,
  ATLAS_ZONES,
  atlasArchetype,
  atlasDistrictForSystem,
  atlasScene,
} from "./atlas-meta.mjs";
import {
  PLAIN_EDGES,
  PLAIN_FLOWS,
  PLAIN_SUBSYSTEMS,
  searchPlainLanguage,
} from "./plain-language.mjs";
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
  "services-inference",
  "services-adapters",
  "web-sdk",
  "extension-sdk",
  "host-protocol",
  "sdk-protocol",
  "sdk-gateway",
  "protocol-gateway",
  "host-gateway-human",
  "host-gateway-machine",
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
    assert.ok(
      ["request", "control", "data", "contract", "provision"].includes(edge.kind),
      `${edge.id} has an unknown connection kind`,
    );
  }

  const edgeById = new Map(ARCHITECTURE_EDGES.map((edge) => [edge.id, edge]));
  for (const id of ["deployment-gateway", "deployment-adapters", "deployment-ripgit"]) {
    assert.equal(edgeById.get(id).kind, "provision", `${id} is build-time assembly, not runtime control`);
  }
  for (const id of ["sdk-gateway", "protocol-gateway"]) {
    assert.equal(edgeById.get(id).kind, "contract", `${id} describes a contract rather than an actor call`);
  }
  assert.equal(edgeById.get("services-gateway").kind, "control");
  assert.equal(edgeById.get("services-inference").kind, "contract");
  assert.equal(edgeById.get("services-adapters").kind, "contract");
  assert.match(edgeById.get("services-adapters").label, /managed mail/);
  for (const edge of ARCHITECTURE_EDGES.filter(({ kind }) => kind === "contract")) {
    assert.notEqual(edge.security, true, `${edge.id} contract metadata must not masquerade as a trust crossing`);
  }
  assert.deepEqual(
    ARCHITECTURE_EDGES.filter(({ security }) => security === true).map(({ id }) => id).toSorted(),
    [
      "adapters-gateway",
      "deployment-adapters",
      "deployment-gateway",
      "deployment-ripgit",
      "extension-gateway",
      "gateway-kernel",
      "host-gateway-human",
      "host-gateway-machine",
      "kernel-adapters",
      "kernel-conversation",
      "kernel-extension",
      "kernel-host",
      "kernel-native",
      "kernel-process",
      "kernel-ripgit",
      "native-ripgit",
      "process-inference",
      "process-kernel",
      "services-gateway",
      "web-gateway",
    ],
    "the Security lens must keep the reviewed trust-crossing set exact",
  );

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
    assert.ok(detail.archetype in ATLAS_ARCHETYPES, `${subsystem.id} has an unknown landmark form`);
    assert.equal("scene" in detail, false, `${subsystem.id} must derive geometry from its district and form`);
  }
  assert.deepEqual(Object.keys(ATLAS_SYSTEM_DETAIL).sort(), ARCHITECTURE_SUBSYSTEMS.map(({ id }) => id).sort());
});

test("districts and landmark forms derive deterministic, non-quantitative geometry", () => {
  const systemIds = ARCHITECTURE_SUBSYSTEMS.map(({ id }) => id);
  const assignedIds = ATLAS_DISTRICTS.flatMap(({ systems }) => systems);
  assert.equal(new Set(ATLAS_DISTRICTS.map(({ id }) => id)).size, ATLAS_DISTRICTS.length);
  assert.equal(new Set(assignedIds).size, assignedIds.length, "a subsystem may inhabit only one district");
  assert.deepEqual(assignedIds.toSorted(), systemIds.toSorted(), "districts must cover every subsystem exactly once");

  for (const district of ATLAS_DISTRICTS) {
    assert.ok(district.label.length > 4, `${district.id} needs a readable label`);
    assert.ok(district.summary.length > 40, `${district.id} needs a semantic explanation`);
    assert.ok(district.systems.length >= 1, `${district.id} is empty`);
    for (const id of district.systems) {
      assert.equal(atlasDistrictForSystem(id), district);
    }
  }

  const landmarks = ARCHITECTURE_SUBSYSTEMS.map((subsystem) => {
    const detail = ATLAS_SYSTEM_DETAIL[subsystem.id];
    const form = atlasArchetype(detail.archetype);
    const scene = atlasScene(subsystem);
    for (const coordinate of ["x", "z", "width", "depth", "facadeHeight", "crownHeight", "height"]) {
      assert.ok(Number.isFinite(scene[coordinate]), `${subsystem.id}.scene.${coordinate} is invalid`);
    }
    assert.equal(scene.width, form.width, `${subsystem.id} width must come from its categorical form`);
    assert.equal(scene.depth, form.depth, `${subsystem.id} depth must come from its categorical form`);
    assert.equal(scene.facadeHeight, form.height, `${subsystem.id} facade must come from its categorical form`);
    assert.equal(scene.height, form.height + form.crownHeight);
    assert.equal(scene.districtId, atlasDistrictForSystem(subsystem.id).id);
    assert.equal(scene.archetypeId, detail.archetype);
    assert.deepEqual(scene, atlasScene(subsystem), `${subsystem.id} geometry must be deterministic`);
    return [subsystem.id, scene];
  });

  for (let leftIndex = 0; leftIndex < landmarks.length; leftIndex += 1) {
    const [leftId, left] = landmarks[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < landmarks.length; rightIndex += 1) {
      const [rightId, right] = landmarks[rightIndex];
      const horizontalGap = Math.abs(left.x - right.x) - (left.width + right.width) / 2;
      const verticalGap = Math.abs(left.z - right.z) - (left.depth + right.depth) / 2;
      assert.ok(
        Math.max(horizontalGap, verticalGap) >= 26,
        `${leftId} and ${rightId} need more visual breathing room`,
      );
    }
  }

  for (const sameForm of [["sdk", "services"], ["native-target", "extension"], ["inference", "adapters"]]) {
    const dimensions = sameForm.map((id) => {
      const scene = atlasScene(requireSubsystem(id));
      return [scene.width, scene.depth, scene.facadeHeight, scene.crownHeight];
    });
    assert.deepEqual(dimensions[0], dimensions[1], `${sameForm.join(" and ")} must share categorical dimensions`);
  }
});

test("trust geography, foundations, and gates remain selective", () => {
  const installationRadius = ATLAS_ZONES.find(({ id }) => id === "installation").radius;
  const boundaryRadius = ATLAS_ZONES.find(({ id }) => id === "boundary").radius;
  const footprintRadii = (id) => {
    const scene = atlasScene(requireSubsystem(id));
    const corners = [
      [scene.x - scene.width / 2, scene.z - scene.depth / 2],
      [scene.x + scene.width / 2, scene.z - scene.depth / 2],
      [scene.x + scene.width / 2, scene.z + scene.depth / 2],
      [scene.x - scene.width / 2, scene.z + scene.depth / 2],
    ];
    const radii = corners.map(([x, z]) => Math.hypot(x, z));
    const nearestX = Math.max(Math.abs(scene.x) - scene.width / 2, 0);
    const nearestZ = Math.max(Math.abs(scene.z) - scene.depth / 2, 0);
    return { min: Math.hypot(nearestX, nearestZ), max: Math.max(...radii) };
  };

  for (const id of ["kernel", "process", "conversation", "native-target", "ripgit"]) {
    assert.ok(footprintRadii(id).max < installationRadius, `${id} footprint must remain inside the installation interior`);
  }
  for (const id of ["gateway", "inference"]) {
    const footprint = footprintRadii(id);
    assert.ok(footprint.min < boundaryRadius && footprint.max > boundaryRadius, `${id} must straddle the installation gate`);
  }
  const protocol = footprintRadii("protocol");
  assert.ok(
    protocol.min < installationRadius && protocol.max > boundaryRadius,
    "the stateless Protocol lattice must visibly span the shared contract boundary",
  );
  for (const id of ["sdk", "services", "web", "host", "adapters", "extension", "deployment"]) {
    assert.ok(footprintRadii(id).min > boundaryRadius, `${id} footprint must remain outside the installation gate`);
  }

  const withFoundations = Object.entries(ATLAS_SYSTEM_DETAIL)
    .filter(([, detail]) => detail.foundation)
    .map(([id]) => id)
    .toSorted();
  assert.deepEqual(withFoundations, [
    "adapters", "conversation", "deployment", "extension", "host", "kernel", "process", "ripgit",
  ]);
  const withGates = Object.entries(ATLAS_SYSTEM_DETAIL)
    .filter(([, detail]) => detail.gate)
    .map(([id]) => id)
    .toSorted();
  assert.deepEqual(withGates, [
    "adapters", "conversation", "extension", "gateway", "kernel", "process", "ripgit",
  ]);
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

  const conversationAtlas = JSON.stringify(requireSubsystem("conversation"));
  assert.match(conversationAtlas, /authorized user and contact input/);
  assert.doesNotMatch(conversationAtlas, /contact and system input/);

  const ripgitAtlas = JSON.stringify(requireSubsystem("ripgit"));
  assert.match(ripgitAtlas, /`\/workspaces` remains ordinary R2/);
  assert.doesNotMatch(ripgitAtlas, /wikis, workspaces, and repositories/);

  const targetFlow = ARCHITECTURE_FLOWS.find(({ id }) => id === "target-syscall");
  assert.match(targetFlow.summary, /fs\.\*, shell\.exec, or net\.fetch/);
  assert.match(targetFlow.steps[0].detail, /nested operation issued by Process-local CodeMode/);
  assert.doesNotMatch(targetFlow.steps[0].detail, /CodeMode operation resolves/);
});

test("the explorer remains outside the product Web bundle", async () => {
  const files = ["index.html", "app.js", "styles.css", "architecture.mjs", "atlas-meta.mjs", "plain-language.mjs", "server.mjs"];
  const combined = (await Promise.all(files.map((file) => readFile(join(REPO_ROOT, "tools/architecture-explorer", file), "utf8")))).join("\n");
  assert.doesNotMatch(combined, /web\/src\/app\/features\/architecture/);
  assert.doesNotMatch(combined, /\/architecture(?:["'`?])/);
  assert.doesNotMatch(combined, /style=|\.style\b/, "strict CSP requires external presentation rules");
});

test("the workspace progressively discloses supporting information", async () => {
  const index = await readFile(join(REPO_ROOT, "tools/architecture-explorer/index.html"), "utf8");
  const app = await readFile(join(REPO_ROOT, "tools/architecture-explorer/app.js"), "utf8");
  assert.deepEqual(
    [...index.matchAll(/data-workspace-panel="([^"]+)"/g)].map((match) => match[1]),
    ["systems", "inspector", "trace", "key"],
  );
  assert.doesNotMatch(index, /class="command-deck"/);
  assert.doesNotMatch(index, /subsystem-count|component-count|route-count|id="revision"/);
  assert.match(index, /Colors put places that work closely together into groups/);
  for (const district of ATLAS_DISTRICTS) {
    assert.match(index, new RegExp(`class="key-${district.id}"`), `${district.id} needs a color-key entry`);
  }
  for (const grammar of ["form", "aperture", "foundation", "gate", "ring"]) {
    assert.match(index, new RegExp(`class="grammar-${grammar}"`), `${grammar} needs a grid-grammar entry`);
  }
  assert.match(index, /class="line-request"/);
  assert.match(index, /class="line-control"/);
  assert.match(index, /class="line-data"/);
  assert.match(index, /class="line-contract"/);
  assert.match(index, /class="line-provision"/);
  assert.match(index, /class="line-trace"/);
  assert.match(app, /class="component-aperture/);
  assert.doesNotMatch(app, /component-deck/);
  assert.match(app, /from "\.\/plain-language\.mjs"/);
  assert.match(app, /\["overview", "BIG PICTURE"\]/);
  assert.match(app, /\["components", `SMALLER PARTS/);
  assert.match(app, /\["source", "CODE"\]/);
  assert.match(app, /\["routes", `CONNECTIONS/);
});

test("plain-language copy covers the complete technical map", () => {
  assert.deepEqual(
    PLAIN_SUBSYSTEMS.map(({ id }) => id),
    ARCHITECTURE_SUBSYSTEMS.map(({ id }) => id),
  );
  assert.deepEqual(
    PLAIN_EDGES.map(({ id }) => id),
    ARCHITECTURE_EDGES.map(({ id }) => id),
  );
  assert.deepEqual(
    PLAIN_FLOWS.map(({ id }) => id),
    ARCHITECTURE_FLOWS.map(({ id }) => id),
  );

  for (const [systemIndex, system] of PLAIN_SUBSYSTEMS.entries()) {
    const technical = ARCHITECTURE_SUBSYSTEMS[systemIndex];
    assert.equal(system.label, technical.label, `${system.id} must retain its real system name`);
    assert.equal(system.shortLabel, technical.shortLabel, `${system.id} must retain its real map name`);
    assert.ok(system.plainLabel.length > 3, `${system.id} needs a plain role name`);
    assert.equal(system.sourceRoot, technical.sourceRoot, `${system.id} must retain source evidence`);
    assert.equal(system.category, technical.category, `${system.id} must retain its category`);
    assert.deepEqual(system.position, technical.position, `${system.id} must retain its map position`);
    assert.deepEqual(
      system.components.map(({ id }) => id),
      technical.components.map(({ id }) => id),
      `${system.id} must explain every component`,
    );
    for (const [componentIndex, component] of system.components.entries()) {
      assert.equal(
        component.label,
        technical.components[componentIndex].label,
        `${system.id}/${component.id} must retain its real component name`,
      );
      assert.ok(component.plainLabel.length > 3, `${system.id}/${component.id} needs a plain role name`);
      assert.deepEqual(
        component.paths,
        technical.components[componentIndex].paths,
        `${system.id}/${component.id} must retain source evidence`,
      );
    }
    assert.notEqual(system.summary, technical.summary, `${system.id} needs reader-friendly copy`);
  }

  for (const [edgeIndex, edge] of PLAIN_EDGES.entries()) {
    const technical = ARCHITECTURE_EDGES[edgeIndex];
    assert.deepEqual(
      { from: edge.from, to: edge.to, kind: edge.kind, security: edge.security },
      { from: technical.from, to: technical.to, kind: technical.kind, security: technical.security },
      `${edge.id} must retain its factual connection`,
    );
  }

  for (const [flowIndex, flow] of PLAIN_FLOWS.entries()) {
    const technical = ARCHITECTURE_FLOWS[flowIndex];
    assert.deepEqual(
      flow.steps.map(({ subsystemId, componentId }) => ({ subsystemId, componentId })),
      technical.steps.map(({ subsystemId, componentId }) => ({ subsystemId, componentId })),
      `${flow.id} must retain its factual route`,
    );
  }


  assert.ok(searchPlainLanguage("gateway").length <= 18, "search results must remain bounded");
  assert.ok(
    searchPlainLanguage("durable object").some(({ componentId }) => componentId === "kernel-do"),
    "search must find real component names",
  );
});

test("the main explanations avoid specialist vocabulary", () => {
  const copy = [];
  for (const system of PLAIN_SUBSYSTEMS) {
    copy.push(system.plainLabel, system.summary, ...system.owns, system.boundary, system.invariant);
    for (const component of system.components) {
      copy.push(component.plainLabel, component.summary, ...component.mechanics);
    }
  }
  for (const edge of PLAIN_EDGES) copy.push(edge.label);
  for (const flow of PLAIN_FLOWS) {
    copy.push(flow.label, flow.summary);
    for (const step of flow.steps) copy.push(step.label, step.detail);
  }
  for (const district of ATLAS_DISTRICTS) copy.push(district.label, district.shortLabel, district.summary);
  for (const archetype of Object.values(ATLAS_ARCHETYPES)) copy.push(archetype.label, archetype.summary);
  for (const lens of ATLAS_LENSES) copy.push(lens.label, lens.summary);
  for (const zone of ATLAS_ZONES) copy.push(zone.label, zone.summary);
  copy.push(...ATLAS_CONCEPTS);
  for (const detail of Object.values(ATLAS_SYSTEM_DETAIL)) {
    copy.push(
      detail.foundation,
      detail.gate,
      detail.scope,
      detail.runtime,
      detail.owner,
      detail.persistence,
      detail.admission,
      detail.completion,
      ...detail.security,
    );
  }
  for (const note of Object.values(ATLAS_TOUR_NOTES)) copy.push(note.thesis, note.warning);

  const specialistWords = /\b(?:admission|aperture|architecture|archetype|artifact|binary|binding|canonical|capability|catalog|command|component|control plane|credentials|dispatch|durable|durability|egress|fencing|fingerprint|frame|identity|ingress|interface|lifecycle|local|manifest|metadata|model|native|operator|persistence|principal|production|protocol|provisioning|release|repository|runtime|schema|self-hosted|storage|stream|subsystem|syscall|terminal|topology|transfer|versioned)\b|\b(?:Linux|MCP|PID|R2|RPC|SDK|SQLite|UID)\b/i;
  for (const value of copy.filter(Boolean)) {
    assert.doesNotMatch(value, specialistWords, `specialist wording leaked into: ${value}`);
  }
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
  assert.match(await index.text(), /How GSV Works/);

  const plainLanguage = await fetch(`${origin}/plain-language.mjs`);
  assert.equal(plainLanguage.status, 200);
  assert.match(plainLanguage.headers.get("content-type"), /text\/javascript/);

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
