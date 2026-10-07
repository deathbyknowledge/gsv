import { describe, expect, it } from "vitest";
import { USERNAME_FORMAT_DESCRIPTION, handleUsernameProblem, validateSetupAccount } from "./sessionDomain";

describe("handle as username", () => {
  const next = "Change your handle, or choose a different username on the next screen.";

  it.each(["alice", "my-space", "a".repeat(32), "x1"])("accepts %j", (handle) => {
    expect(handleUsernameProblem(handle)).toBeNull();
  });

  it.each([
    ["42labs", "Usernames can't start with a number."],
    ["a".repeat(33), "Usernames can't be longer than 32 characters."],
    ["ship", "This name belongs to your Ship."],
    ["root", "This name is reserved inside your space."],
    ["users", "This name is reserved inside your space."],
  ])("explains why %j cannot be a username and what to do next", (handle, reason) => {
    expect(handleUsernameProblem(handle)).toBe(`${reason} ${next}`);
  });
});

describe("setup account validation", () => {
  it("accepts underscores in the account username", () => {
    expect(validateSetupAccount({ username: "sample_user", password: "password123", passwordConfirm: "password123" })).toEqual({});
  });
  it("accepts local credentials without optional configuration", () => {
    expect(validateSetupAccount({ username: "alice", password: "password123", passwordConfirm: "password123" })).toEqual({});
  });

  it.each(["Alice", " alice", "alice ", "1alice", "alice!", "a".repeat(33)])("explains invalid username %j", (username) => {
    expect(validateSetupAccount({ username, password: "password123", passwordConfirm: "password123" })).toEqual({ username: USERNAME_FORMAT_DESCRIPTION });
  });

  it("requires a username and reserves the Ship account name", () => {
    expect(validateSetupAccount({ username: "", password: "password123", passwordConfirm: "password123" })).toEqual({ username: "Username is required." });
    expect(validateSetupAccount({ username: "ship", password: "password123", passwordConfirm: "password123" })).toEqual({ username: "Choose a different username. This name belongs to your Ship." });
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
