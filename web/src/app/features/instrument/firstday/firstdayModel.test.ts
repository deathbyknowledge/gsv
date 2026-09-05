import { describe, expect, it } from "vitest";
import {
  connectedCount,
  derivePlaces,
  joinNames,
  nextToConnect,
  promptIntent,
  reachablePlaces,
  uniqueDeviceId,
} from "./firstdayModel";

describe("derivePlaces", () => {
  it("lights nothing on an empty installation", () => {
    const rows = derivePlaces({ targets: [], identityLinks: [], contacts: [] });
    expect(rows.map((row) => row.id)).toEqual(["computer", "telegram", "browser", "person"]);
    expect(rows.every((row) => row.lit === null)).toBe(true);
    expect(connectedCount(rows)).toBe(0);
    expect(nextToConnect(rows)).toBe("computer");
    expect(reachablePlaces(rows)).toEqual(["your cloud home"]);
  });

  it("lights a computer only when a machine is online, and names it", () => {
    const offline = derivePlaces({
      targets: [{ kind: "native-device", online: false, label: "MacBook 16" }],
      identityLinks: [],
      contacts: [],
    });
    expect(offline[0].lit).toBeNull();
    const online = derivePlaces({
      targets: [{ kind: "native-device", online: true, label: "MacBook 16" }],
      identityLinks: [],
      contacts: [],
    });
    expect(online[0].lit).toBe("MacBook 16");
    expect(nextToConnect(online)).toBe("telegram");
  });

  it("lights telegram from an identity link, the browser from its target, and people from active contacts", () => {
    const rows = derivePlaces({
      targets: [{ kind: "browser", online: false, label: "Chrome" }],
      identityLinks: [{ adapter: "telegram" }, { adapter: "slack" }],
      contacts: [
        { state: "active", alias: "Ana" },
        { state: "revoked", alias: null },
      ],
    });
    expect(rows[1].lit).toBe("Telegram");
    expect(rows[2].lit).toBe("Chrome");
    expect(rows[3].lit).toBe("Ana");
    expect(connectedCount(rows)).toBe(3);
    expect(reachablePlaces(rows)).toEqual(["your cloud home", "Telegram", "Chrome", "Ana"]);
  });

  it("counts several people instead of naming them", () => {
    const rows = derivePlaces({
      targets: [],
      identityLinks: [],
      contacts: [
        { state: "active", alias: "Ana" },
        { state: "active", alias: null },
      ],
    });
    expect(rows[3].lit).toBe("2 people");
  });
});

describe("joinNames", () => {
  it("reads like a sentence", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["a"])).toBe("a");
    expect(joinNames(["a", "b"])).toBe("a and b");
    expect(joinNames(["a", "b", "c"])).toBe("a, b, and c");
  });
});

describe("promptIntent", () => {
  it("recognises what a sentence asks to connect", () => {
    expect(promptIntent("connect my laptop")).toBe("computer");
    expect(promptIntent("hook up telegram")).toBe("telegram");
    expect(promptIntent("add chrome")).toBe("browser");
    expect(promptIntent("invite ana")).toBe("person");
    expect(promptIntent("what can you do?")).toBeNull();
    expect(promptIntent("   ")).toBeNull();
  });
});

describe("uniqueDeviceId", () => {
  it("keeps a free id and suffixes a taken one", () => {
    expect(uniqueDeviceId("mac-workstation", [])).toBe("mac-workstation");
    expect(uniqueDeviceId("mac-workstation", ["mac-workstation"])).toBe("mac-workstation-2");
    expect(uniqueDeviceId("mac-workstation", ["mac-workstation", "mac-workstation-2"])).toBe("mac-workstation-3");
  });
});
