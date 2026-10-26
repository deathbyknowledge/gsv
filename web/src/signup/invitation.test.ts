import { describe, expect, it } from "vitest";
import { OwnerWelcome, type WelcomeSnapshot } from "../app/services/session/ownerWelcome";
import { captureContactInvitation } from "./invitation";
import { encodeContactInvitation } from "@humansandmachines/gsv/protocol";
import { signupDestination } from "./navigation";

const origin = "https://accounts.example.com";
describe("signup contact handoff", () => {
  it("restores the contact after browser restart while retaining the signup operation", async () => {
    let snapshot: WelcomeSnapshot = { revision: "initial", value: null };
    const storage = { save: async (_revision: string, value: WelcomeSnapshot["value"]) => snapshot = { revision: "saved", value } };
    const contact = encodeContactInvitation({ version: 2, did: "did:plc:sponsoraaaaaaaaaaaaaaaaa", handle: "sponsor.example",
      name: "Sponsor", token: "x".repeat(43), expiresAtMs: Date.now() + 60_000 });
    const first = new OwnerWelcome(snapshot, storage, origin);
    await captureContactInvitation(first, contact);
    await first.save({ operationId: "signup-operation" });
    const reopened = new OwnerWelcome(snapshot, storage, origin);
    const restored = await captureContactInvitation(reopened, null);
    const destination = new URL(signupDestination("https://friend.example", `onboard_${"x".repeat(43)}`, restored));
    expect(new URLSearchParams(destination.hash.slice(1)).get("contact")).toBe(contact);
    expect(reopened.state.operationId).toBe("signup-operation");
  });
  it("keeps browser contact state out of an ordinary Desktop welcome record", async () => {
    const client = new OwnerWelcome({ revision: "initial", value: null }, {
      save: async (_revision, value) => ({ revision: "saved", value }),
    }, origin);
    await client.save({ flow: "create", operationId: "signup-operation" });
    await client.completeCreation();
    expect(client.state).not.toHaveProperty("contactInvite");
  });
});
