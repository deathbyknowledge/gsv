import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bodyFromBytes, bodyFromText, bodyToText } from "@humansandmachines/gsv/protocol";

import { WearableFilesystem } from "../src/filesystem.mjs";
import { WearableShell } from "../src/shell.mjs";

async function makeFilesystem() {
  const directory = await mkdtemp(path.join(tmpdir(), "gsv-hdzero-device-"));
  const rootPath = path.join(directory, "root");
  const firmwareAppRoot = path.join(directory, "firmware-app");
  await mkdir(firmwareAppRoot, { recursive: true });
  await writeFile(path.join(firmwareAppRoot, "setting.ini"), "[fans]\nauto=true\n");
  const filesystem = new WearableFilesystem({
    rootPath,
    firmwareAppRoot,
    deviceId: "goggles-test",
    getState: () => ({
      clientConnection: "online",
      driverConnection: "online",
      phase: "idle",
    }),
  });
  await filesystem.initialize();
  return { directory, filesystem };
}

test("provides full filesystem operations inside the wearable root", async () => {
  const { directory, filesystem } = await makeFilesystem();
  try {
    const root = await filesystem.read({ path: "/" });
    assert.equal(root.data.ok, true);
    assert.ok(root.data.directories.includes("home"));
    assert.ok(root.data.directories.includes("mnt"));

    const written = await filesystem.write({ path: "/home/gsv/note.txt", content: "hello wearable" });
    assert.deepEqual(written.data, { ok: true, path: "/home/gsv/note.txt", size: 14 });

    const edited = await filesystem.edit({
      path: "/home/gsv/note.txt",
      oldString: "wearable",
      newString: "goggles",
    });
    assert.equal(edited.data.replacements, 1);

    const file = await filesystem.read({ path: "/home/gsv/note.txt" });
    assert.equal(await bodyToText(file.body), "hello goggles");

    const searched = await filesystem.search({ query: "goggles", path: "/home" });
    assert.equal(searched.data.count, 1);

    const copied = await filesystem.copy({
      source: { path: "/home/gsv/note.txt" },
      destination: { path: "/tmp/copied.txt" },
    });
    assert.equal(copied.data.ok, true);
    assert.equal((await filesystem.delete({ path: "/tmp/copied.txt" })).data.ok, true);

    const sent = await filesystem.transferSend({ path: "/home/gsv/note.txt" });
    assert.equal(await bodyToText(sent.body), "hello goggles");
    const received = await filesystem.transferReceive(
      { path: "/home/gsv/from-gateway.txt", contentType: "text/plain" },
      bodyFromText("binary body transfer"),
    );
    assert.equal(received.data.bytesWritten, 20);
    assert.equal((await filesystem.transferStat({ path: "/home/gsv/from-gateway.txt" })).data.isFile, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mounts the upstream app read-only and protects device metadata", async () => {
  const { directory, filesystem } = await makeFilesystem();
  try {
    const appFile = await filesystem.read({ path: "/mnt/app/setting.ini" });
    assert.match(await bodyToText(appFile.body), /auto=true/);
    assert.equal((await filesystem.write({
      path: "/mnt/app/setting.ini",
      content: "changed",
    })).data.ok, false);
    assert.equal((await filesystem.delete({ path: "/sys/gsv/device.json" })).data.ok, false);

    const device = await filesystem.read({ path: "/sys/gsv/device.json" });
    assert.match(await bodyToText(device.body), /"deviceId": "goggles-test"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs a composable pseudo-shell and presents text through gsv-show", async () => {
  const { directory, filesystem } = await makeFilesystem();
  const presentations = [];
  try {
    const shell = new WearableShell({
      filesystem,
      onPresent: (presentation) => presentations.push(presentation),
      getPresentation: () => presentations.at(-1) || { kind: "none" },
    });

    const pipeline = await shell.execute({
      input: "printf 'alpha\\nbeta\\n' | grep beta > result.txt && cat result.txt",
    });
    assert.equal(pipeline.status, "completed");
    assert.equal(pipeline.output, "beta\n");

    const shown = await shell.execute({
      input: "cat result.txt | gsv-show text --title Result",
    });
    assert.equal(shown.status, "completed");
    assert.deepEqual(presentations.at(-1), {
      kind: "text",
      title: "Result",
      body: "beta\n",
      path: "",
    });

    await filesystem.transferReceive(
      { path: "/home/gsv/card.png", contentType: "image/png" },
      bodyFromBytes(Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      )),
    );
    const image = await shell.execute({
      input: "gsv-show image --title Card /home/gsv/card.png",
    });
    assert.equal(image.status, "completed");
    assert.equal(presentations.at(-1).kind, "image");
    assert.equal(presentations.at(-1).body, "/home/gsv/card.png");
    assert.match(presentations.at(-1).path, /\/root\/home\/gsv\/card\.png$/);

    await shell.execute({ input: "rm -rf /sys/gsv" });
    assert.equal((await filesystem.read({ path: "/sys/gsv/device.json" })).data.ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
