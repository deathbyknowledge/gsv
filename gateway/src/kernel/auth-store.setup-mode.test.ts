import { describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store";

function rows<T>(values: T[]) {
  return { toArray: () => values };
}

describe("AuthStore setup mode", () => {
  it("keeps an interrupted setup in setup mode after user auth is committed", () => {
    let recoveryCount = 0;
    const sql = {
      exec<T>(query: string) {
        const normalized = query.trim().replace(/\s+/g, " ");
        if (normalized.startsWith("SELECT COUNT(*) as c FROM setup_recovery")) {
          return rows([{ c: recoveryCount }] as T[]);
        }
        if (normalized.includes("FROM shadow WHERE username")) {
          return rows([{
            username: "root",
            hash: "$argon2id$committed",
            lastchanged: "",
            min: "0",
            max: "99999",
            warn: "7",
            inactive: "",
            expire: "",
            reserved: "",
          }] as T[]);
        }
        if (normalized.includes("FROM passwd ORDER BY uid")) {
          return rows([
            { username: "root", uid: 0, gid: 0, gecos: "root", home: "/root", shell: "/bin/init" },
            { username: "alice", uid: 1000, gid: 1000, gecos: "alice", home: "/home/alice", shell: "/bin/init" },
          ] as T[]);
        }
        throw new Error(`Unexpected SQL: ${normalized}`);
      },
    };
    const auth = new AuthStore(sql as unknown as SqlStorage);

    expect(auth.isSetupMode()).toBe(false);
    recoveryCount = 1;
    expect(auth.isSetupMode()).toBe(true);
    recoveryCount = 0;
    expect(auth.isSetupMode()).toBe(false);
  });
});
