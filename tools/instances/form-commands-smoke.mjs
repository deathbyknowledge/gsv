import assert from "node:assert/strict";

export async function checkFormCommands(run) {
  const command = async input => {
    const result = await run(input);
    assert.equal(result.exitCode, 0, result.error ?? result.output);
    return JSON.parse(result.output);
  };
  const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children ?? [])]);
  const first = await command("page snapshot --json");
  const form = flatten(first.nodes).find(node => node.role === "form" && node.name === "Journey");
  assert.ok(form?.ref);
  const scoped = await command(`page snapshot --within ${form.ref} --json`);
  assert.equal(flatten(scoped.nodes).filter(node => node.name === "Plan").length, 1);
  const expected = [["From", "Amsterdam Centraal"], ["Departure time", "10:00"], ["Departure date", "2026-10-10"], ["Passengers", "3"], ["Notes", "New notes"], ["Draft", "New draft"]];
  for (const [label, value] of expected) {
    const result = await command(`page fill --label '${label}' '${value}'`);
    assert.equal(result.verified, true);
    assert.equal(result.state.value, value);
  }
  assert.equal((await command("page fill --label Notes ''")).state.value, "");
  const password = await command("page fill --label Password 'fixture-secret'");
  assert.equal(password.state.valueLength, 14);
  assert.ok(!JSON.stringify(password).includes("fixture-secret"));
  const selected = await command("page select --label Class --option-label First");
  assert.deepEqual(selected.state.selected, [{ value: "1", label: "First" }]);
  await command("page check --label 'Direct only'");
  assert.equal((await command("page check --label 'Direct only'")).skipped, "already-in-state");
  await command("page check --label 'Direct only' --unchecked");
  assert.equal((await command("page js 'window.checkboxClicks'")).js.result, 2);
  const ambiguous = await run("page click --role button --name Plan");
  assert.equal(ambiguous.exitCode, 1);
  assert.match(ambiguous.error ?? ambiguous.output, /matches 2 elements/);
  const clicked = await command(`page click --role button --name Plan --within ${form.ref} --snapshot`);
  assert.ok(JSON.stringify(clicked.snapshot).includes("Journey ready"));
  assert.ok(!JSON.stringify(clicked.snapshot).includes("Other trip"));
  const wait = await command("page wait --role textbox --name From --timeout 1000");
  assert.ok(wait.wait.ref);
  for (const input of ["page fill --label Locked 'changed'", "page fill --label Reverting 'changed'", "page fill --label 'Departure time' nonsense", "page type --label 'Departure time' '11:00'"]) {
    const failed = await run(input); assert.equal(failed.exitCode, 1, `Unexpected success: ${input}`);
  }
  console.log("PASS: form values, native dates/times, shadow labels, strict/scoped targeting, select/check verification, password redaction, and rejected/reverted actions");
}
