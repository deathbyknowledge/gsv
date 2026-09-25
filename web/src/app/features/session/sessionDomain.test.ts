import { describe, expect, it } from "vitest";
import { USERNAME_FORMAT_DESCRIPTION, validateSetupAccount } from "./sessionDomain";

describe("setup account validation", () => {
  it("accepts local credentials without optional configuration", () => {
    expect(validateSetupAccount({ username: "alice", password: "password123", passwordConfirm: "password123" })).toEqual({});
  });

  it.each(["Alice", " alice", "alice ", "1alice", "alice!", "a".repeat(33)])("explains invalid username %j", (username) => {
    expect(validateSetupAccount({ username, password: "password123", passwordConfirm: "password123" })).toEqual({ username: USERNAME_FORMAT_DESCRIPTION });
  });

  it("requires a username and reserves the Ship account name", () => {
    expect(validateSetupAccount({ username: "", password: "password123", passwordConfirm: "password123" })).toEqual({ username: "Username is required." });
    expect(validateSetupAccount({ username: "algo", password: "password123", passwordConfirm: "password123" })).toEqual({ username: "Choose a different username. This name belongs to your Ship." });
  });

  it("applies the setup service's password length after trimming", () => {
    expect(validateSetupAccount({ username: "alice", password: " short   ", passwordConfirm: " short   " })).toEqual({ password: "Password must be at least 8 characters." });
    expect(validateSetupAccount({ username: "alice", password: " password123 ", passwordConfirm: " password123 " })).toEqual({});
  });

  it("requires the confirmation to match the entered password", () => {
    expect(validateSetupAccount({ username: "alice", password: "password123", passwordConfirm: "" })).toEqual({ passwordConfirm: "Confirm your password." });
    expect(validateSetupAccount({ username: "alice", password: "password123", passwordConfirm: "password124" })).toEqual({ passwordConfirm: "Passwords do not match." });
    expect(validateSetupAccount({ username: "alice", password: " password123 ", passwordConfirm: "password123" })).toEqual({ passwordConfirm: "Passwords do not match." });
  });
});
