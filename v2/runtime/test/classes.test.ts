import { DurableObject } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { DURABLE_OBJECTS } from "../src/classes.ts";
import * as runtime from "../src/index.ts";

it("lists exactly the Durable Object classes the runtime exports, each bound", () => {
  const exported = Object.entries(runtime)
    .filter(([, value]) => value instanceof Function && value.prototype instanceof DurableObject)
    .map(([name]) => name);
  expect(DURABLE_OBJECTS.map(object => object.className).sort()).toEqual(exported.sort());
  for (const { binding } of DURABLE_OBJECTS) expect(env[binding], binding).toBeDefined();
});
