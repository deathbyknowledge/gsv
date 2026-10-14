import { describe, expect, it } from "vitest";
import { classifyClientPlatform } from "./clientPlatform";

const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPAD_LEGACY = "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const base = {
  tauri: false,
  userAgentDataMobile: undefined,
  navigatorPlatform: "",
  maxTouchPoints: 0,
};

describe("classifyClientPlatform", () => {
  it("reports the desktop app whenever the Tauri bridge is present", () => {
    expect(classifyClientPlatform({ ...base, tauri: true, userAgent: MAC_SAFARI, navigatorPlatform: "MacIntel" })).toBe("desktop");
    expect(classifyClientPlatform({ ...base, tauri: true, userAgent: IPHONE_SAFARI })).toBe("desktop");
  });

  it("reports phones from client hints or the user agent", () => {
    expect(classifyClientPlatform({ ...base, userAgent: WINDOWS_CHROME, userAgentDataMobile: true })).toBe("phone");
    expect(classifyClientPlatform({ ...base, userAgent: IPHONE_SAFARI, navigatorPlatform: "iPhone", maxTouchPoints: 5 })).toBe("phone");
    expect(classifyClientPlatform({ ...base, userAgent: ANDROID_PHONE, navigatorPlatform: "Linux armv8l", maxTouchPoints: 5 })).toBe("phone");
  });

  it("reports tablets, including iPadOS Safari behind a Mac user agent", () => {
    expect(classifyClientPlatform({ ...base, userAgent: IPAD_LEGACY, navigatorPlatform: "iPad", maxTouchPoints: 5 })).toBe("tablet");
    expect(classifyClientPlatform({ ...base, userAgent: ANDROID_TABLET, navigatorPlatform: "Linux armv8l", maxTouchPoints: 5 })).toBe("tablet");
    expect(classifyClientPlatform({ ...base, userAgent: MAC_SAFARI, navigatorPlatform: "MacIntel", maxTouchPoints: 5 })).toBe("tablet");
  });

  it("reports an ordinary browser as web", () => {
    expect(classifyClientPlatform({ ...base, userAgent: MAC_SAFARI, navigatorPlatform: "MacIntel", maxTouchPoints: 0 })).toBe("web");
    expect(classifyClientPlatform({ ...base, userAgent: WINDOWS_CHROME, navigatorPlatform: "Win32", userAgentDataMobile: false })).toBe("web");
    expect(classifyClientPlatform({ ...base, userAgent: "" })).toBe("web");
  });
});
