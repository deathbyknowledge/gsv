import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeManagedProviderIds,
  validateManagedObjectDescriptor,
} from "../dist/protocol/managed-objects.js";

test("managed provider IDs are bounded, exact, and unique", () => {
  assert.deepEqual(normalizeManagedProviderIds(["abc", "def"]), ["abc", "def"]);
  assert.throws(() => normalizeManagedProviderIds([" abc"]), /invalid/);
  assert.throws(() => normalizeManagedProviderIds(["abc", "abc"]), /unique/);
  assert.throws(() => normalizeManagedProviderIds(new Array(501).fill("abc")), /at most/);
});

test("managed descriptors distinguish unknown and erased objects", () => {
  assert.equal(validateManagedObjectDescriptor({
    schemaVersion: 1,
    kind: "process",
    providerId: "abc",
    logicalName: null,
    classification: "uninitialized",
    lifecycle: { status: "uninitialized", epoch: 0 },
  }, "process", "abc").classification, "uninitialized");

  assert.equal(validateManagedObjectDescriptor({
    schemaVersion: 1,
    kind: "process",
    providerId: "abc",
    logicalName: null,
    classification: "erased",
    lifecycle: { status: "erased", epoch: 2 },
  }, "process", "abc").classification, "erased");
});

test("managed descriptor kinds cover repository state owned by ripgit", () => {
  assert.equal(validateManagedObjectDescriptor({
    schemaVersion: 1,
    kind: "repository",
    providerId: "abc",
    logicalName: "7:notes",
    classification: "initialized",
    lifecycle: { status: "active", epoch: 0 },
  }, "repository", "abc").kind, "repository");

  assert.equal(validateManagedObjectDescriptor({
    schemaVersion: 1,
    kind: "repository_registry",
    providerId: "def",
    logicalName: "singleton",
    classification: "initialized",
    lifecycle: { status: "active", epoch: 0 },
  }, "repository_registry", "def").kind, "repository_registry");
});
