import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentPresentation, deploymentPresentationScript, configuredDomainAliases } from "../dist/services/deployment.js";
import { operatorUpdateCatalogSchema } from "../dist/services/operator-updates.js";

test("operator presentation validates domains and safely embeds public metadata", () => {
  const config = deploymentPresentation(JSON.stringify({ primaryDomain: "fleet.example", legacyDomains: ["old.example"], operatorName: "</script><script>alert(1)</script>" }));
  const script = deploymentPresentationScript(config);
  assert.equal(script.match(/<script/g)?.length, 1);
  assert.equal(script.match(/<\/script>/g)?.length, 1);
  for (const value of ["https://fleet.example", "fleet.example/path", "fleet.example:443", "fleet.example?x=1", "FLEET.example"]) {
    assert.throws(() => deploymentPresentation(JSON.stringify({ primaryDomain: value })));
  }
  assert.deepEqual(configuredDomainAliases('["old.example"]'), ["old.example"]);
  assert.throws(() => deploymentPresentation('{"accountsOrigin":"https://fleet.example/path"}'));
  assert.throws(() => deploymentPresentation('{"installUrl":"javascript:alert(1)"}'));
});

test("operator update IDs are unique within a bounded publisher catalog", () => {
  const update = { id: "release-1", publishedAtMs: 1, title: "New feature", brief: "Explain this feature." };
  assert.throws(() => operatorUpdateCatalogSchema.parse({ publisher: { id: "operator", name: "Operator" }, updates: [update, update] }));
});

test("all operator domain fields reject edge dots that Accounts would normalize away", () => {
  for (const value of ["fleet.example.", ".fleet.example", "..fleet.example..", "."]) {
    for (const configuration of [{ primaryDomain: value }, { sitesDomain: value }, { legacyDomains: [value] }]) {
      assert.throws(() => deploymentPresentation(JSON.stringify(configuration)), /Expected a normalized domain name/);
    }
    assert.throws(() => configuredDomainAliases(JSON.stringify([value])), /Expected a normalized domain name/);
  }
});
