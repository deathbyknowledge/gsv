import { describe, expect, it } from "vitest";
import { OwnerWelcome, type WelcomeSnapshot } from "../app/services/session/ownerWelcome";
import { captureInvite } from "./invitation";

const origin = "https://accounts.example.com";
describe("signup invitation handoff", () => {
  it("restores the invitation after browser restart while retaining the signup operation", async () => {
    let snapshot: WelcomeSnapshot = { revision: "initial", value: null };
    const storage = { save: async (_revision: string, value: WelcomeSnapshot["value"]) => snapshot = { revision: "saved", value } };
    const first = new OwnerWelcome(snapshot, storage, origin);
    await captureInvite(first, "esteve");
    await first.save({ operationId: "signup-operation" });
    const reopened = new OwnerWelcome(snapshot, storage, origin);
    expect(await captureInvite(reopened, null)).toBe("esteve");
    expect(reopened.state.operationId).toBe("signup-operation");
    // A link's own invitation replaces the one kept.
    expect(await captureInvite(reopened, "ada")).toBe("ada");
    expect(reopened.state.invite).toBe("ada");
  });
  it("keeps browser invitation state out of an ordinary Desktop welcome record", async () => {
    const client = new OwnerWelcome({ revision: "initial", value: null }, {
      save: async (_revision, value) => ({ revision: "saved", value }),
    }, origin);
    await client.save({ flow: "create", operationId: "signup-operation" });
    await client.completeCreation();
    expect(client.state).not.toHaveProperty("invite");
  });
});
