import assert from "node:assert/strict";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function evaluate(shell, instance, source) {
  await shell(instance, `page js ${quote(`window.__gsvStorageCheck = null; (${source}).then(value => { window.__gsvStorageCheck = { value }; }, error => { window.__gsvStorageCheck = { error: String(error) }; }); "started"`)}`);
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = JSON.parse(JSON.parse(await shell(instance, "page js 'JSON.stringify(window.__gsvStorageCheck)'")).js.result);
    if (result) { assert.equal(result.error, undefined); return result.value; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Storage fixture did not finish");
}

export async function seedBrowserStorage(shell, client, instance) {
  const run = source => evaluate(shell, instance, source);
  assert.equal(await run(`(async () => {
    const open = indexedDB.open("gsv-fidelity", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("records");
    const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const tx = db.transaction("records", "readwrite"), store = tx.objectStore("records");
    const cycle = { label: "cycle" }; cycle.self = cycle;
    const values = { big: "x".repeat(8 * 1024 * 1024), bytes: new Uint8Array([0, 4, 255]), buffer: new Uint8Array([7, 8]).buffer,
      view: new DataView(new Uint8Array([9, 10]).buffer), map: new Map([["answer", 42]]), set: new Set(["one", "two"]),
      date: new Date("2026-01-01T00:00:00Z"), bigint: 12345678901234567890n, cycle, empty: "", zero: 0, no: false, nothing: null,
      numbers: { positive: Infinity, negative: -Infinity, nan: NaN, zero: -0 }, infinity: Infinity };
    for (const [key, value] of Object.entries(values)) store.put(value, key);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close(); return "seeded";
  })()`), "seeded");
  for (let attempt = 0; attempt < 3; attempt++) {
    const { profile } = await client.sys.browser.profile.save({ instanceId: instance.instanceId });
    assert.equal(profile.saveStatus, "saved", profile.error);
    assert.ok(profile.bytes > 8 * 1024 * 1024);
    assert.ok(profile.storedBytes < 64 * 1024);
    assert.equal(await run(`(async () => {
      const open = indexedDB.open("gsv-fidelity", ${attempt + 2});
      return await new Promise((resolve, reject) => { open.onblocked = () => reject(new Error("Exporter retained a database connection")); open.onerror = () => reject(open.error); open.onsuccess = () => { open.result.close(); resolve("upgraded"); }; });
    })()`), "upgraded");
  }
  const tabs = JSON.parse(await shell(instance, "tabs list"));
  const summaries = await client.sys.browser.profile.list({ offset: 0 });
  assert.equal(summaries.total, 1);
  assert.equal(summaries.profiles[0].profileId, instance.profileId);
  assert.equal(summaries.profiles[0].usage, undefined);
  assert.equal(summaries.profiles[0].issues, undefined);
  assert.equal(summaries.nextOffset, undefined);
  assert.deepEqual(JSON.parse(await shell({ targetId: "gsv" }, "browser profile list --offset 1")), { profiles: [], total: 1 });
  assert.ok(!JSON.stringify(tabs).includes("Browser storage"), "The storage page leaked into the user's tabs");
  const lastGood = (await client.sys.browser.profile.get({ profileId: instance.profileId })).profile.savedAt;
  await run(`(async () => {
    const open = indexedDB.open("gsv-fidelity");
    const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
    const tx = db.transaction("records", "readwrite"); tx.objectStore("records").put("z".repeat(9 * 1024 * 1024), "overflow");
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close(); return "oversized";
  })()`);
  const failed = (await client.sys.browser.profile.save({ instanceId: instance.instanceId })).profile;
  assert.equal(failed.saveStatus, "failed"); assert.equal(failed.savedAt, lastGood);
  assert.ok(failed.usage.bytes > 16 * 1024 * 1024);
  await assert.rejects(client.sys.instance.stop({ instanceId: instance.instanceId }), /still running/);
  assert.equal((await client.sys.instance.get({ instanceId: instance.instanceId })).instance.state, "ready");
  await run(`(async () => {
    const open = indexedDB.open("gsv-fidelity");
    const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
    const tx = db.transaction("records", "readwrite"); tx.objectStore("records").delete("overflow");
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close(); return "recovered";
  })()`);
  assert.equal((await client.sys.browser.profile.save({ instanceId: instance.instanceId })).profile.saveStatus, "saved");
  await run(`(async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, ["encrypt"]);
    const open = indexedDB.open("gsv-fidelity");
    const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
    const tx = db.transaction("records", "readwrite"); tx.objectStore("records").put(key, "unsupported");
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close(); return "key stored";
  })()`);
  const unsupported = (await client.sys.browser.profile.save({ instanceId: instance.instanceId })).profile;
  assert.equal(unsupported.saveStatus, "partial");
  assert.match(unsupported.issues[0].message, /CryptoKey/);
  assert.ok(unsupported.issues[0].retainedAt);
  await run(`(async () => {
    const open = indexedDB.open("gsv-fidelity");
    const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
    const tx = db.transaction("records", "readwrite"); tx.objectStore("records").delete("unsupported");
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close(); return "recovered";
  })()`);
  assert.equal((await client.sys.browser.profile.save({ instanceId: instance.instanceId })).profile.saveStatus, "saved");
  console.log("PASS: repeated 8 MiB saves, compression, no leaked IndexedDB connections, and hidden export pages");
  console.log("PASS: oversized saves retain the previous snapshot, report measured usage, leave the browser running, and recover after retry");
  console.log("PASS: unsupported website keys retain the site's earlier snapshot and clear their warning after recovery");
  for (const kind of ["object", "map"]) {
    const before = (await client.sys.browser.profile.get({ profileId: instance.profileId })).profile;
    await run(`(async () => {
      const open = indexedDB.open("gsv-fidelity");
      const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
      const tx = db.transaction("records", "readwrite");
      const pairs = Array.from({ length: 40000 }, (_, i) => [String(i), 0]);
      tx.objectStore("records").put(${kind === "map" ? "new Map(pairs)" : "Object.fromEntries(pairs)"}, "complex");
      await new Promise(resolve => { tx.oncomplete = resolve; }); db.close(); return "stored";
    })()`);
    const partial = (await client.sys.browser.profile.save({ instanceId: instance.instanceId })).profile;
    assert.equal(partial.saveStatus, "partial");
    assert.match(partial.issues[0].message, /too complex/);
    assert.equal(partial.issues[0].retainedAt, before.savedAt);
    await run(`(async () => {
      const open = indexedDB.open("gsv-fidelity");
      const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
      const tx = db.transaction("records", "readwrite"); tx.objectStore("records").delete("complex");
      await new Promise(resolve => { tx.oncomplete = resolve; }); db.close(); return "recovered";
    })()`);
    assert.equal((await client.sys.browser.profile.save({ instanceId: instance.instanceId })).profile.saveStatus, "saved");
  }
  console.log("PASS: wide objects and maps stop before codec expansion, retain saved state, and recover after cleanup");
}

export async function seedPartialBrowserStorage(shell, client, instance, website) {
  const other = new URL(website); other.hostname = "localhost";
  await shell(instance, `tabs open --active ${other.origin}/empty`);
  await evaluate(shell, instance, `(async () => {
    localStorage.setItem("retained", "before"); document.cookie = "partial_session=before; Path=/";
    const open = indexedDB.open("unsupported-site", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("records");
    const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); }); db.close(); return true;
  })()`);
  const before = (await client.sys.browser.profile.save({ instanceId: instance.instanceId })).profile;
  assert.equal(before.saveStatus, "saved");
  await evaluate(shell, instance, `(async () => {
    localStorage.setItem("retained", "after"); document.cookie = "partial_session=after; Path=/";
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, ["encrypt"]);
    const open = indexedDB.open("unsupported-site");
    const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
    const tx = db.transaction("records", "readwrite"); tx.objectStore("records").put(key, "key");
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close(); return true;
  })()`);
  await shell(instance, `tabs open --active ${website}/empty`);
  await evaluate(shell, instance, `(async () => { localStorage.setItem("healthy-after-failure", "saved"); document.cookie = "healthy_session=new; Path=/"; return true; })()`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const saved = (await client.sys.browser.profile.save({ instanceId: instance.instanceId })).profile;
    assert.equal(saved.saveStatus, "partial");
    assert.equal(saved.issues.length, 1);
    assert.equal(saved.issues[0].origin, other.origin);
    assert.equal(saved.issues[0].retainedAt, before.savedAt);
    assert.ok(saved.issues[0].diagnosticRef);
  }
  const { profile: status } = JSON.parse(await shell({ targetId: "gsv" }, `browser profile get ${instance.profileId}`));
  assert.equal(status.saveStatus, "partial");
  assert.equal(status.issues[0].origin, other.origin);
  console.log("PASS: one unsupported site leaves another site's updated state saving and reports a stable retained-save time");
}

export async function checkBrowserStorageSummaryBounds(shell, client, instance, website) {
  await evaluate(shell, instance, `(async () => {
    await Promise.all(Array.from({ length: 48 }, (_, index) => new Promise((resolve, reject) => {
      const open = indexedDB.open("gsv-summary-" + index + "🙂".repeat(1024), 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => { open.result.close(); resolve(); };
    }))); return true;
  })()`);
  const { profile } = await client.sys.browser.profile.save({ instanceId: instance.instanceId });
  assert.equal(profile.saveStatus, "saved", profile.error);
  const site = profile.usage.sites.find(site => site.origin === new URL(website).origin);
  assert.ok(site.databases >= 48);
  assert.equal(site.databaseUsageTruncated, true);
  assert.ok(site.databaseUsage.length <= 32);
  assert.ok(new TextEncoder().encode(JSON.stringify(site)).byteLength <= 4096 + 24, "Database details exceeded their metadata allowance");
  assert.ok(site.databaseUsage.some(db => db.name.endsWith("…")));
  await evaluate(shell, instance, `(async () => {
    await Promise.all((await indexedDB.databases()).filter(db => db.name.startsWith("gsv-summary-")).map(db => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(db.name);
      request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Summary export retained a connection"));
    }))); return true;
  })()`);
  const cleared = (await client.sys.browser.profile.save({ instanceId: instance.instanceId })).profile;
  assert.equal(cleared.saveStatus, "saved", cleared.error);
  assert.equal(cleared.usage.sites.find(site => site.origin === new URL(website).origin).databaseUsageTruncated, false);
  console.log("PASS: many long database names keep exact storage totals with bounded, visibly truncated details, and normal details return after cleanup");
}

export async function checkPartialBrowserStorage(shell, instance, website) {
  const healthy = JSON.parse(await shell(instance, `page js 'JSON.stringify({local:localStorage.getItem("healthy-after-failure"),cookie:document.cookie.includes("healthy_session=new")})'`));
  assert.deepEqual(JSON.parse(healthy.js.result), { local: "saved", cookie: true });
  const other = new URL(website); other.hostname = "localhost";
  await shell(instance, `tabs open --active ${other.origin}/empty`);
  const retained = await evaluate(shell, instance, `(async () => {
    const open = indexedDB.open("unsupported-site");
    const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
    const request = db.transaction("records").objectStore("records").count();
    const count = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); }); db.close();
    return { local: localStorage.getItem("retained"), before: document.cookie.includes("partial_session=before"), after: document.cookie.includes("partial_session=after"), count };
  })()`);
  assert.deepEqual(retained, { local: "before", before: true, after: false, count: 0 });
  await shell(instance, `tabs open --active ${website}/probe && page wait '#restored'`);
  console.log("PASS: normal stop/restart restores the healthy site's new login state and the unsupported site's previous storage and cookies");
}

export async function checkRestoredBrowserStorage(shell, client, instance) {
  const result = await evaluate(shell, instance, `(async () => {
    const open = indexedDB.open("gsv-fidelity");
    const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const tx = db.transaction("records"), store = tx.objectStore("records");
    const read = key => new Promise((resolve, reject) => { const request = store.get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const [big, bytes, buffer, view, map, set, date, bigint, cycle, empty, zero, no, nothing, numbers, infinity] = await Promise.all(["big", "bytes", "buffer", "view", "map", "set", "date", "bigint", "cycle", "empty", "zero", "no", "nothing", "numbers", "infinity"].map(read));
    db.close();
    return { big: big.length, bytes: [...bytes], buffer: [...new Uint8Array(buffer)], view: view.getUint8(1), map: map.get("answer"), set: [...set], date: date.toISOString(), bigint: String(bigint), cycle: cycle.self === cycle, empty, zero, no, nothing,
      specialNumbers: infinity === Infinity && numbers.positive === Infinity && numbers.negative === -Infinity && Number.isNaN(numbers.nan) && Object.is(numbers.zero, -0) };
  })()`);
  assert.deepEqual(result, { big: 8 * 1024 * 1024, bytes: [0, 4, 255], buffer: [7, 8], view: 10, map: 42, set: ["one", "two"], date: "2026-01-01T00:00:00.000Z", bigint: "12345678901234567890", cycle: true, empty: "", zero: 0, no: false, nothing: null, specialNumbers: true });
  const { profile: metadata } = await client.sys.browser.profile.get({ profileId: instance.profileId });
  assert.equal(metadata.saveStatus, "saved");
  assert.ok(metadata.usage.sites.some(site => site.indexedDBBytes > 8 * 1024 * 1024));
  console.log("PASS: restored binary values, maps, sets, dates, bigints, cycles, special numbers, false/zero/null, and saved-profile usage");
}

export async function checkForgettingBrowserStorage(shell, client, instance, start, wait, website) {
  const { profile: explicit } = await client.sys.browser.profile.create({ requestId: crypto.randomUUID(), label: "Explicit browser state" });
  try {
    await shell({ targetId: "gsv" }, `browser profile delete ${instance.profileId}`);
    await wait(instance.instanceId, "terminal");
    assert.equal((await client.sys.browser.profile.get({ profileId: instance.profileId })).profile.state, "deleted");
    const fresh = await start();
    assert.notEqual(fresh.profileId, instance.profileId);
    assert.notEqual(fresh.profileId, explicit.profileId);
    assert.equal((await client.sys.browser.profile.get({ profileId: explicit.profileId })).profile.state, "active");
    const probe = await shell(fresh, `tabs open --active ${website}/probe && page wait '#restored' && page text`);
    assert.match(probe, /cookie=missing;local=null;indexed=undefined/);
    await client.sys.browser.profile.delete({ profileId: fresh.profileId });
    await wait(fresh.instanceId, "terminal");
    assert.equal((await client.sys.browser.profile.get({ profileId: fresh.profileId })).profile.state, "deleted");
    console.log("PASS: profile deletion stops the active browser, erases saved state, and the next start is fresh despite another saved profile");
  } finally { await client.sys.browser.profile.delete({ profileId: explicit.profileId }); }
}
