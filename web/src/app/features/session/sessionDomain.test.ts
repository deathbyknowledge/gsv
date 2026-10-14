import { describe, expect, it } from "vitest";
import { validateSetupAccount } from "./sessionDomain";

describe("setup account validation", () => {
  it("accepts a personal password without another username", () => {
    expect(validateSetupAccount({ password: "password123", passwordConfirm: "password123" })).toEqual({});
  });

  it("applies the setup service's password length after trimming", () => {
    expect(validateSetupAccount({ password: " short   ", passwordConfirm: " short   " })).toEqual({ password: "Password must be at least 8 characters." });
    expect(validateSetupAccount({ password: " password123 ", passwordConfirm: " password123 " })).toEqual({});
  });

  it("requires the confirmation to match the entered password", () => {
    expect(validateSetupAccount({ password: "password123", passwordConfirm: "" })).toEqual({ passwordConfirm: "Confirm your password." });
    expect(validateSetupAccount({ password: "password123", passwordConfirm: "password124" })).toEqual({ passwordConfirm: "Passwords do not match." });
    expect(validateSetupAccount({ password: " password123 ", passwordConfirm: "password123" })).toEqual({ passwordConfirm: "Passwords do not match." });
  });
});
