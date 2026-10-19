import assert from "node:assert/strict";

export async function checkBrowserCommands(run) {
  const shell = async (command) => {
    const result = await run(command);
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.exitCode, 0, result.error ?? result.output);
    return JSON.parse(result.output);
  };
  const find = (nodes, role, name) => {
    for (const node of nodes) {
      if (node.role === role && node.name === name) return node;
      const child = find(node.children ?? [], role, name);
      if (child) return child;
    }
  };
  const ref = (snapshot, role, name) => {
    const node = find(snapshot.nodes, role, name);
    assert.ok(node?.ref, `Missing ${role} reference: ${name}`);
    return node.ref;
  };
  const initial = await shell("page snapshot --json");
  await shell(`page click ${ref(initial, "button", "Dismiss overlay")}`);
  const typed = await shell(`page type ${ref(initial, "combobox", "From")} Amsterdam`);
  assert.equal(typed.observed.focus.tag, "input");
  const spaced = await shell("page key ' '");
  assert.equal(spaced.delivered.receiver.name, "From");
  assert.equal(spaced.observed.targetStateChanged, true);
  const option = await shell(`page click ${ref(initial, "option", "Amsterdam Centraal")}`);
  assert.ok(option.observed.mutationCount > 0, "Changes inside a shadow root were not observed");
  await shell(`page click ${ref(initial, "button", "Choose date")}`);
  const calendar = await shell("page snapshot --json");
  const day = await shell(`page click ${ref(calendar, "button", "October 10")}`);
  assert.ok(day.observed.mutationCount > 0);
  const before = await shell(`page js '({ ...window.testState, value: document.querySelector("trip-planner").shadowRoot.querySelector("trip-fields").shadowRoot.querySelector("input").value })'`);
  assert.deepEqual(before.js.result, { selected: 1, day: "10", value: "Amsterdam " });
  await shell(`page click ${ref(initial, "button", "Open anchored calendar")}`);
  const anchored = await shell("page snapshot --json");
  await shell(`page click ${ref(anchored, "button", "Pick anchored day")}`);
  assert.equal((await shell("page js 'window.anchoredDaySelected'")).js.result, true);
  await shell("page click '#block'");
  const blocked = await run(`page click ${ref(calendar, "button", "October 11")}`);
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.error ?? blocked.output, /occluded by dialog.*Blocking dialog/);
  assert.deepEqual((await shell("page js 'window.testState'")).js.result, { selected: 1, day: "10" });
  console.log("PASS: nested/slotted controls, calendar day references, anchored popovers, shadow focus/mutations, Space, transient overlay wait, and blocked input");
}
