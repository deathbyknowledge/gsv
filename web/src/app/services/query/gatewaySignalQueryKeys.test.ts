import { describe, expect, it } from "vitest";
import { ADAPTER_STATUS_QUERY_KEYS } from "./gatewaySignalQueryKeys";

describe("gateway signal query invalidation", () => {
  it("refreshes every adapter-backed console surface after a status signal", () => {
    expect(ADAPTER_STATUS_QUERY_KEYS).toEqual([
      ["adapters"],
      ["adapter-inventory"],
      ["gsv-console", "overview"],
    ]);
  });
});
