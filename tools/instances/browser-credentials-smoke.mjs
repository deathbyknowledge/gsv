import assert from "node:assert/strict";
import { bodyFromText, bodyToBytes } from "../../packages/gsv/dist/protocol.js";

export async function checkBrowserCredentials(shell, client, instance, website) {
  const js = async (tabId, expression) => JSON.parse(await shell(instance, `page js --tab ${tabId} '${expression}'`)).js.result;
  const verify = async tabId => {
    await shell(instance, `page wait --tab ${tabId} 'body[data-authentication=done]' --timeout 5000`);
    const authentication = JSON.parse(await js(tabId, "JSON.stringify(window.authenticationResult)"));
    assert.deepEqual(authentication, {
      get: "NotAllowedError", create: "NotAllowedError", platform: false, conditional: false,
      capabilities: authentication.capabilities, password: true, silent: true,
    });
    assert.ok(Object.values(authentication.capabilities).every(value => value === false));
    await shell(instance, `page fill --tab ${tabId} '#password' public-fixture >/dev/null && page click --tab ${tabId} '#signin' >/dev/null`);
    await shell(instance, `page click --tab ${tabId} '#password' >/dev/null && page key --tab ${tabId} Enter >/dev/null`);
    assert.equal(await js(tabId, "window.submissions.length"), 2);
    assert.equal(await js(tabId, "window.submissions.every(event => event.trusted && event.submitter === \"signin\")"), true);
    return authentication;
  };
  await shell(instance, `tabs open --active ${website}/passkeys >/dev/null`);
  const listing = JSON.parse(await shell(instance, "tabs list"));
  const main = listing.tabs.find(tab => tab.url === `${website}/passkeys`);
  assert.ok(main);
  const authentication = await verify(main.id);
  const iframe = JSON.parse(await js(main.id, "JSON.stringify(await document.getElementById(\"authentication-frame\").contentWindow.authentication)"));
  // Chrome disallows silent password retrieval in a frame; preserve that restriction.
  assert.deepEqual(iframe, { ...authentication, silent: "NotSupportedError" });

  const frame = await client.request("sys.browser.frame", { instanceId: instance.instanceId, tabId: main.id });
  await bodyToBytes(frame.body);
  const input = value => client.request("sys.browser.input", { instanceId: instance.instanceId, tabId: main.id, documentId: frame.data.documentId }, {
    body: bodyFromText(JSON.stringify(value)),
  });
  const point = JSON.parse(await js(main.id, "JSON.stringify((() => { const r = document.getElementById(\"signin\").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })())"));
  await input({ kind: "click", ...point });
  await input({ kind: "key", key: "Enter" });
  assert.equal(await js(main.id, "window.submissions.length"), 4);
  assert.equal(await js(main.id, "window.submissions.every(event => event.trusted)"), true);

  await shell(instance, `page click --tab ${main.id} '#popup' >/dev/null`);
  const opened = JSON.parse(await shell(instance, "tabs list"));
  const popup = opened.tabs.find(tab => tab.url === `${website}/passkeys?popup`);
  assert.ok(popup, "The sign-in popup did not open");
  await verify(popup.id);
  await shell(instance, `tabs reload ${main.id}`);
  await verify(main.id);
  for (const tab of [popup, main]) await shell(instance, `tabs close ${tab.id}`);
  console.log("PASS: unavailable passkeys cannot block password clicks/Enter for Ship or human input, including initial popup/frame scripts and reload; other Credential APIs retain native behavior");
}
