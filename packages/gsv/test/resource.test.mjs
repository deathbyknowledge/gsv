import test from "node:test";
import assert from "node:assert/strict";
import {
  fileResourceReferenceSchema,
  resourceBlockSchema,
} from "../dist/protocol.js";

const reference = {
  type: "file",
  target: "laptop",
  path: "/workspace/image.png",
  revision: "revision-1",
  contentType: "image/png",
  size: 42,
};

test("resource references identify one byte revision without carrying bytes", () => {
  assert.deepEqual(fileResourceReferenceSchema.parse(reference), reference);
  assert.deepEqual(resourceBlockSchema.parse({ type: "resource", ref: reference }), {
    type: "resource",
    ref: reference,
  });
  assert.equal(fileResourceReferenceSchema.safeParse({
    ...reference,
    revision: "",
  }).success, false);
  assert.equal(resourceBlockSchema.safeParse({
    type: "resource",
    ref: reference,
    data: "base64-does-not-belong-here",
  }).success, false);
});
