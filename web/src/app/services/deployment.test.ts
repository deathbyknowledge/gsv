import { afterEach, expect, it, vi } from "vitest";
import { bindSessionPresentation, publicDeployment } from "./deployment";
import type { PublicDeploymentConfig } from "@humansandmachines/gsv/services/deployment";

afterEach(() => vi.unstubAllGlobals());

it("uses the connected operator's settings and restores the host configuration on teardown", () => {
  vi.stubGlobal("document", { getElementById: () => ({ textContent: JSON.stringify({ primaryDomain: "host.example" }) }) });
  let current: PublicDeploymentConfig | undefined;
  const clear = bindSessionPresentation(() => current);
  try {
    expect(publicDeployment().primaryDomain).toBe("host.example");
    current = { primaryDomain: "operator.example", legacyDomains: ["old.example"] };
    expect(publicDeployment()).toEqual(current);
    current = { legacyDomains: [] };
    expect(publicDeployment().primaryDomain).toBeUndefined();
  } finally { clear(); }
  expect(publicDeployment().primaryDomain).toBe("host.example");
});
