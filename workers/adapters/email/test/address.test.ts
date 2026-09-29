import { describe, expect, it, vi } from "vitest";
import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
} from "@humansandmachines/gsv/protocol";
import { mailAddressForHandle, resolveMailRecipient } from "../src/address";

function accounts(
  result: InstallationDirectoryResult,
): InstallationDirectoryService & { resolveHostname: ReturnType<typeof vi.fn> } {
  return {
    resolveHostname: vi.fn(async () => result),
    resolveInstallation: vi.fn(async (): Promise<InstallationDirectoryResult> => ({
      found: false,
    })),
  };
}

describe("managed mail address routing", () => {
  it("derives a canonical sender from the Accounts handle and mail domain", () => {
    expect(mailAddressForHandle("hank", "GSV.Space")).toBe("hank@gsv.space");
    expect(() => mailAddressForHandle("Hank", "gsv.space")).toThrow(
      "invalid mail handle",
    );
  });

  it("maps one configured mail address to an active installation hostname", async () => {
    const directory = accounts({
      found: true,
      state: "active",
      installationId: "installation_hank",
      handle: "hank",
      canonicalOrigin: "https://hank.gsv.space",
    });

    await expect(resolveMailRecipient(
      directory,
      "Hank@GSV.Space",
      "gsv.space",
      "gsv.space",
    )).resolves.toEqual({
      installation: { installationId: "installation_hank" },
      handle: "hank",
    });
    expect(directory.resolveHostname).toHaveBeenCalledOnce();
    expect(directory.resolveHostname).toHaveBeenCalledWith("hank.gsv.space");
  });

  it("does not query Accounts for another domain or a malformed handle", async () => {
    const directory = accounts({ found: false });

    await expect(resolveMailRecipient(
      directory,
      "hank@example.com",
      "gsv.space",
      "gsv.space",
    )).resolves.toBeNull();
    await expect(resolveMailRecipient(
      directory,
      "hank+tag@gsv.space",
      "gsv.space",
      "gsv.space",
    )).resolves.toBeNull();
    expect(directory.resolveHostname).not.toHaveBeenCalled();
  });

  it("does not admit an inactive installation", async () => {
    const directory = accounts({
      found: true,
      state: "restricted",
      installationId: "installation_hank",
      handle: "hank",
      canonicalOrigin: "https://hank.gsv.space",
    });

    await expect(resolveMailRecipient(
      directory,
      "hank@gsv.space",
      "gsv.space",
      "gsv.space",
    )).resolves.toBeNull();
  });
});
