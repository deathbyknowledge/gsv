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
  for (const failedAction of ["page fill --label Locked changed", "set -o pipefail; page fill --label Locked changed | cat"]) {
    const chained = await run(`${failedAction} && page click --role button --name Plan --within ${form.ref}`);
    assert.equal(chained.exitCode, 1);
    const after = await run(`page snapshot --within ${form.ref}`);
    assert.equal(after.exitCode, 0);
    assert.ok(!after.output.includes("Journey ready"), "A failed fill must not run the chained Plan action");
  }
  const readable = await run(`page fill --label Notes --within ${form.ref} 'Readable snapshot' --snapshot`);
  assert.equal(readable.exitCode, 0, readable.error);
  assert.equal(JSON.parse(readable.output.split("\n")[0]).verified, true);
  assert.match(readable.output, /\n\s+textbox @\S+ "Notes" value="Readable snapshot"/);
  assert.ok(!readable.output.includes("Other trip"));
  assert.ok(!readable.output.includes("fixture-secret"));
  const clicked = await command(`page click --role button --name Plan --within ${form.ref} --snapshot --json`);
  assert.ok(JSON.stringify(clicked.snapshot).includes("Journey ready"));
  assert.ok(!JSON.stringify(clicked.snapshot).includes("Other trip"));
  const wait = await command("page wait --role textbox --name From --timeout 1000");
  assert.ok(wait.wait.ref);
  for (const input of ["page fill --label Locked 'changed'", "page fill --label Reverting 'changed'", "page fill --label 'Departure time' nonsense", "page type --label 'Departure time' '11:00'"]) {
    const failed = await run(input); assert.equal(failed.exitCode, 1, `Unexpected success: ${input}`);
  }
  await command(`page js 'const dialog = document.createElement("dialog"); dialog.setAttribute("aria-label", "Choose country"); dialog.innerHTML = "<p>Choose your country before continuing</p><button onclick=this.closest(\\\"dialog\\\").close()>Continue</button>"; document.body.append(dialog); dialog.showModal(); "opened"'`);
  const modal = await command("page snapshot --json");
  assert.equal(modal.dialogs.length, 1);
  assert.equal(modal.dialogs[0].name, "Choose country");
  assert.ok(modal.dialogs[0].ref);
  const outline = await run("page snapshot");
  assert.match(outline.output.split("\n")[3], /^visible-dialog @\S+ "Choose country"/);
  assert.ok(!flatten(modal.nodes).some(node => node.name === "From"), "A modal exposed the inert background form");
  const blocked = await run("page fill --label From 'Unreachable station'");
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.error ?? blocked.output, /Visible dialog: "Choose country"/);
  const afterDialog = await run(`page click --role button --name Continue --within ${modal.dialogs[0].ref} --snapshot`);
  assert.equal(afterDialog.exitCode, 0, afterDialog.error ?? afterDialog.output);
  assert.ok(!afterDialog.output.includes("visible-dialog"));
  assert.equal(JSON.parse(afterDialog.output).delivered.accepted, true);
  assert.match(JSON.parse(afterDialog.output).snapshotError, /scope is no longer present/);
  const unscoped = await run("page snapshot");
  assert.equal(unscoped.exitCode, 0, unscoped.error ?? unscoped.output);
  assert.match(unscoped.output, /textbox @\S+ "From"/);
  await command("page fill --label 'Sign-in email' tester@example.invalid");
  await command("page fill --label 'Sign-in password' fixture-secret");
  await command("page click '#signin-submit'");
  for (const key of ["Enter", "Return"]) {
    await command("page click '#signin-password'");
    await command(`page key ${key}`);
  }
  assert.equal((await command("page js 'window.signinSubmissions.length'")).js.result, 3);
  assert.equal((await command("page js 'window.signinSubmissions.every(event => event.trusted && event.submitter === \"signin-submit\")'")).js.result, true);
  await command("page key Ctrl+Enter");
  assert.equal((await command("page js 'window.signinSubmissions.length'")).js.result, 3);
  await command("page fill --label 'Sign-in password' ''");
  await command("page click '#signin-password'");
  await command("page key Enter");
  assert.equal((await command("page js 'window.signinSubmissions.length'")).js.result, 3, "Enter bypassed native required-field validation");
  await command("page fill --label Notes ''");
  await command("page click --label Notes");
  await command("page key Enter");
  await command("page key Shift+Enter");
  assert.equal((await command("page js 'document.querySelector(\"trip-form\").shadowRoot.querySelector(\"#notes\").value'")).js.result, "\n\n");
  console.log("PASS: form values, native dates/times, shadow labels, strict/scoped targeting, readable/JSON action snapshots, checked chaining/pipefail, select/check verification, password redaction, and rejected/reverted actions");
  console.log("PASS: visible dialog context, inaccessible background, scoped dismissal, and restored form content");
  console.log("PASS: native sign-in clicks, Enter/Return submission, required-field validation, shortcut isolation, and multiline Enter/Shift+Enter");
}
