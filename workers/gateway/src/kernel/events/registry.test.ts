import { describe, expect, it } from "vitest";
import { CENSUS_EVENT_TYPES } from "../../../test-integration/census-types";
import { EVENT_REGISTRY } from "./registry";

describe("event registry", () => {
  it("registers exactly the types the census fires, so a new type can't skip it", () => {
    expect(Object.keys(EVENT_REGISTRY).sort()).toEqual([...CENSUS_EVENT_TYPES].sort());
  });
});
