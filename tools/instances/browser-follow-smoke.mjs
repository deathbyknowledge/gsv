import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { decodeBrowserViewStream } from "../../packages/gsv/dist/protocol.js";

export async function checkBrowserFollowing(client, instance, website) {
  const shell = async input => {
    const result = await client.shell.exec({ target: instance.targetId, input });
    assert.equal(result.status, "completed", result.error ?? result.output);
    assert.equal(result.exitCode, 0, result.error ?? result.output);
    return result.output;
  };
  const watch = async tabId => {
    const controller = new AbortController();
    const result = await client.request("sys.browser.watch", { instanceId: instance.instanceId, tabId }, { signal: controller.signal });
    const view = { state: undefined, frame: undefined, error: undefined };
    const reading = (async () => {
      for await (const { metadata, image } of decodeBrowserViewStream(result.body, controller.signal)) {
        if (metadata.kind === "state") view.state = metadata;
        else { assert.ok(image.byteLength > 1000); view.frame = metadata; }
      }
    })().catch(error => { if (!controller.signal.aborted) view.error = error; });
    return { view, close: async () => { controller.abort(); await reading; } };
  };
  const shown = async (watcher, active, displayed = active) => {
    const deadline = Date.now() + 5000;
    while (true) {
      if (watcher.view.error) throw watcher.view.error;
      if (watcher.view.state?.activeTabId === active && watcher.view.frame?.tabId === displayed) return;
      assert.ok(Date.now() < deadline, `Expected active tab ${active}, displayed ${displayed}; got ${watcher.view.state?.activeTabId}, ${watcher.view.frame?.tabId}`);
      await delay(25);
    }
  };
  const open = async active => {
    const output = await shell(`tabs open ${active ? "--active " : ""}${website}/login`);
    return JSON.parse(output.slice(output.indexOf("\n") + 1)).tab.id;
  };
  const tabs = [];
  let following, pinned;
  let step = "open viewers";
  try {
    const first = await open(true); tabs.push(first);
    const second = await open(false); tabs.push(second);
    following = await watch();
    pinned = await watch(first);
    await shown(following, first);
    await shown(pinned, first);
    step = "oversized website title and address";
    await shell(`page js --tab ${first} 'document.title = "界".repeat(20000); history.replaceState(null, "", "/login?long=" + "x".repeat(20000)); "updated"'`);
    const metadataDeadline = Date.now() + 5000;
    while (!following.view.state?.tabs.find(tab => tab.id === first)?.title.endsWith("…")) {
      if (following.view.error) throw following.view.error;
      assert.ok(Date.now() < metadataDeadline, "Oversized tab metadata did not reach the live viewer");
      await delay(25);
    }
    const displayed = following.view.state.tabs.find(tab => tab.id === first);
    assert.ok(displayed.title.length <= 1024);
    assert.ok(displayed.url.length <= 8192 && displayed.url.endsWith("…"));
    for (const command of [`tabs get ${first}`, "tabs active", `tabs focus ${first}`]) {
      const output = await shell(command);
      const summary = JSON.parse(output.slice(output.indexOf("{"))).tab;
      assert.ok(summary.title.length <= 1024 && summary.url.length <= 8192, `${command} returned unbounded metadata`);
    }
    const listed = JSON.parse(await shell("tabs list"));
    assert.ok(listed.tabs.find(tab => tab.id === first).url.length <= 8192);
    const remaining = JSON.parse(await shell("tabs list --offset 1"));
    assert.deepEqual(remaining.tabs.map(tab => tab.id), listed.tabs.slice(1).map(tab => tab.id));
    const proc = JSON.parse(await shell("cat /proc/tabs.json"));
    assert.equal(proc.total, listed.total);
    assert.ok(proc.tabs.find(tab => tab.id === first).url.length <= 8192);
    await shown(pinned, first);
    await shell(`page js --tab ${first} 'document.title = "GSV sign-in fixture"; history.replaceState(null, "", "/login"); "restored"'`);
    console.log("PASS: oversized page titles and URLs stay bounded without interrupting live or pinned views");
    for (const [command, active] of [
      [`page text --tab ${second}`, second],
      [`page screenshot --tab ${first}`, first],
      [`page snapshot --dom --tab ${second}`, second],
      [`page wait --tab ${first} h1`, first],
      [`tabs reload ${second}`, second],
      [`page snapshot --tab ${first}`, first],
      [`page js --tab ${second} 'document.title'`, second],
    ]) {
      step = command;
      await shell(command);
      await shown(following, active);
      await shown(pinned, active, first);
    }
    step = "list tabs with two viewers";
    await shell("tabs list");
    await shown(following, second);
    step = "close pinned viewer and switch tabs rapidly";
    await pinned.close(); pinned = undefined;
    await shell(`page text --tab ${first} && page text --tab ${second} && page text --tab ${first}`);
    await shown(following, first);
    step = "close the followed tab";
    await shell(`tabs close ${first} && page text --tab ${second}`);
    tabs.splice(tabs.indexOf(first), 1);
    await shown(following, second);
    console.log("PASS: live streams follow text, screenshots, DOM/semantic snapshots, waits, reloads and JS; pinned views and metadata reads do not steal selection; rapid changes and tab closure recover");
  } catch (cause) {
    throw new Error(`Browser following failed during: ${step}`, { cause });
  } finally {
    await following?.close(); await pinned?.close();
    for (const id of tabs) await shell(`tabs close ${id}`);
  }
}
