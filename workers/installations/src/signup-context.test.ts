import { describe, expect, it } from "vitest";
import { signupContextFromRequest } from "./signup-context";

describe("signup request context", () => {
  it("uses edge location and retains only the web origin", () => {
    const request = new Request("https://accounts.example/owner/api/spaces", {
      headers: { origin: "https://signup.example/path?secret=private", "cf-ipcountry": "US" },
    });
    Object.defineProperty(request, "cf", { value: { country: "CH", city: " Zürich ", region: "Zurich", latitude: "47.37" } });
    expect(signupContextFromRequest(request)).toEqual({ country: "CH", city: "Zürich", region: "Zurich", origin: "https://signup.example" });
  });

  it.each(["XX", "T1", "", undefined])("leaves missing or unknown location unrecorded (%s)", (country) => {
    const request = new Request("https://accounts.example/owner/api/spaces", {
      headers: { origin: "null", "cf-ipcountry": "CH" },
    });
    Object.defineProperty(request, "cf", { value: { country } });
    expect(signupContextFromRequest(request)).toEqual({ country: null, city: null, region: null, origin: null });
  });
});
