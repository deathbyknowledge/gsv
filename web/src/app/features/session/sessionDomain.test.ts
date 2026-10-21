import { describe, expect, it } from "vitest";
import { validateSetupAccount } from "./sessionDomain";

describe("setup account validation", () => {
  it("accepts a personal password without another username", () => {
    expect(validateSetupAccount({ password: "password123", passwordConfirm: "password123" })).toEqual({});
  });

  it("applies the setup service's password length after trimming", () => {
    expect(validateSetupAccount({ password: " short   ", passwordConfirm: " short   " })).toEqual({ password: "session.setup.passwordTooShort" });
    expect(validateSetupAccount({ password: " password123 ", passwordConfirm: " password123 " })).toEqual({});
  });

  it("requires the confirmation to match the entered password", () => {
    expect(validateSetupAccount({ password: "password123", passwordConfirm: "" })).toEqual({ passwordConfirm: "session.setup.confirmRequired" });
    expect(validateSetupAccount({ password: "password123", passwordConfirm: "password124" })).toEqual({ passwordConfirm: "session.setup.mismatch" });
    expect(validateSetupAccount({ password: " password123 ", passwordConfirm: "password123" })).toEqual({ passwordConfirm: "session.setup.mismatch" });
  });
});
