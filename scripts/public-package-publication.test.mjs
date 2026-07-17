import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  PUBLIC_PACKAGE_DIRECTORIES,
  publicPackageCommandPlan,
} from "./public-package-publication.mjs";

const root = path.resolve(import.meta.dirname, "..");
const destination = path.join(root, ".local-packages");

test("runs pack and publish inside each public package without a package specifier", () => {
  for (const directory of PUBLIC_PACKAGE_DIRECTORIES) {
    const plan = publicPackageCommandPlan(root, directory, destination);
    for (const command of [plan.pack, plan.publishDryRun, plan.publish]) {
      assert.equal(command.command, "npm");
      assert.equal(command.cwd, path.resolve(root, directory));
      assert.match(command.arguments[0], /^(?:pack|publish)$/u);
      assert.match(command.arguments[1], /^--/u);
      assert.equal(command.arguments.includes(directory), false);
      assert.equal(command.arguments.includes(`./${directory}`), false);
    }
  }
});

test("rejects directories outside the fixed public package inventory", () => {
  assert.throws(
    () => publicPackageCommandPlan(root, "../private-package", destination),
    /Unknown public package directory/u,
  );
});
