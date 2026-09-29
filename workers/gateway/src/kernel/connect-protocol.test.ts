import { describe, expect, it } from "vitest";

import { handleConnect, PROTOCOL_VERSION } from "./connect";

/** The slice of a Kernel context the protocol check reads before anything else. */
// SAFETY: the protocol mismatch returns before auth, capabilities, or targets are touched.
const protocolOnlyContext = (): any => ({
  connection: { id: "connection-1" },
  serverVersion: "0.4.1",
});

describe("sys.connect protocol mismatch", () => {
  it("names the server version, release, and installer an outdated client needs", async () => {
    const outcome = await handleConnect(
      {
        protocol: PROTOCOL_VERSION - 1,
        peer: { id: "machine-1", version: "0.3.0", platform: "linux" },
      },
      protocolOnlyContext(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(102);
    expect(outcome.details).toEqual({
      requestedProtocol: PROTOCOL_VERSION - 1,
      supportedProtocol: PROTOCOL_VERSION,
      serverVersion: "0.4.1",
      serverRelease: "dev",
      installer: "https://install.gsv.space",
    });
    expect(outcome.message).toContain("https://install.gsv.space");
  });
});
