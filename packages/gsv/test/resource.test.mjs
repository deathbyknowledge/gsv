import test from "node:test";
import assert from "node:assert/strict";
import {
  federationResourceDescriptorSchema,
  federationDeliveryPayloadSchema,
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

test("federation resource descriptors require a routable opaque id", () => {
  const descriptor = {
    id: "resource:550e8400-e29b-41d4-a716-446655440000",
    revision: "revision-1",
    contentType: "image/png",
    size: 42,
  };
  assert.deepEqual(federationResourceDescriptorSchema.parse(descriptor), descriptor);
  assert.equal(federationResourceDescriptorSchema.safeParse({
    ...descriptor,
    id: "invalid",
  }).success, false);
});

test("federation messages are complete and byte-bounded before delivery admission", () => {
  const message = {
    kind: "message",
    messageId: "message:remote",
    threadId: "thread:shared",
    text: "Hello",
  };
  const resource = {
    id: "resource:remote",
    revision: "revision-1",
    contentType: "image/png",
    size: 42,
  };

  assert.equal(federationDeliveryPayloadSchema.safeParse(message).success, true);
  assert.equal(federationDeliveryPayloadSchema.safeParse({
    ...message,
    text: " \t ",
  }).success, false);
  assert.equal(federationDeliveryPayloadSchema.safeParse({
    ...message,
    text: " \t ",
    resources: [resource],
  }).success, true);
  assert.equal(federationDeliveryPayloadSchema.safeParse({
    ...message,
    text: "🛸".repeat(8_193),
  }).success, false);
});

test("federation request details are bounded before delivery admission", () => {
  const request = {
    kind: "request",
    request: {
      id: "request:remote",
      kind: "task",
      title: "A bounded request",
      details: { text: "x".repeat(33 * 1024) },
      state: "offered",
      revision: 1,
    },
  };
  assert.equal(federationDeliveryPayloadSchema.safeParse(request).success, false);
});

test("federation request metadata is valid before delivery admission", () => {
  const request = {
    kind: "request",
    request: {
      id: "request:remote",
      kind: "task",
      title: "A bounded request",
      state: "offered",
      revision: 1,
    },
  };
  assert.equal(federationDeliveryPayloadSchema.safeParse(request).success, true);
  assert.equal(federationDeliveryPayloadSchema.safeParse({
    ...request,
    request: { ...request.request, kind: "not valid" },
  }).success, false);
  assert.equal(federationDeliveryPayloadSchema.safeParse({
    ...request,
    request: { ...request.request, title: " \t " },
  }).success, false);
  assert.equal(federationDeliveryPayloadSchema.safeParse({
    ...request,
    request: { ...request.request, title: "🛸".repeat(300) },
  }).success, false);
});
