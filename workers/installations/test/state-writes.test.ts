import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** SQL that writes an installation's state: an UPDATE or an upsert that sets it, or a REPLACE of the row. */
const STATE_WRITES = [
  /\bUPDATE\s+installations\s+SET\b(?:(?!\bWHERE\b)[\s\S])*?(?<![\w.])state\s*=/i,
  /\bINTO\s+installations\b[\s\S]*?\bDO\s+UPDATE\s+SET\b(?:(?!\bWHERE\b)[\s\S])*?(?<![\w.])state\s*=/i,
  /\b(?:REPLACE|INSERT\s+OR\s+REPLACE)\s+INTO\s+installations\b/i,
];

/** Each place a source writes an installation's state outside `changeInstallationState`, as path:line. */
function bareStateWrites(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const sql = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("?") : node.text;
      if (STATE_WRITES.some((pattern) => pattern.test(sql)) && !withinStateChange(node)) {
        found.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function withinStateChange(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "changeInstallationState") return true;
  }
  return false;
}

/** Accounts' source files, apart from its tests, by their path in `src`. */
async function sources(): Promise<Array<[string, string]>> {
  const names = (await readdir(SOURCE_ROOT, { recursive: true }))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  return await Promise.all(names.map(async (name): Promise<[string, string]> => [name, await readFile(path.join(SOURCE_ROOT, name), "utf8")]));
}

describe("every write of an installation's state", () => {
  it("goes through changeInstallationState, which adds the change's notice to its batch", async () => {
    const files = await sources();
    expect(files.map(([name]) => name)).toEqual(expect.arrayContaining(["store.ts", "administration.ts", "deletion-runtime.ts"]));
    expect(files.flatMap(([name, source]) => bareStateWrites(name, source))).toEqual([]);
  });

  it("is found however its SQL is written, and only outside changeInstallationState", () => {
    expect(bareStateWrites("bare.ts", `db.prepare("UPDATE installations SET state = ? WHERE id = ?")`)).toEqual(["bare.ts:1"]);
    expect(bareStateWrites("upsert.ts", "db.prepare(`INSERT INTO installations (id, state) VALUES (?, ?)\n  ON CONFLICT (id) DO UPDATE SET state = excluded.state`)"))
      .toEqual(["upsert.ts:1"]);
    expect(bareStateWrites("replace.ts", "const sql = 'REPLACE INTO installations (id, state) VALUES (?, ?)';")).toEqual(["replace.ts:1"]);
    expect(bareStateWrites("other.ts", "db.prepare(`UPDATE installations SET owner_principal_id = ?\n  WHERE id = ? AND state = 'active'`)")).toEqual([]);
    expect(bareStateWrites("routed.ts", "db.batch(changeInstallationState(db, id, [db.prepare(`UPDATE installations\n  SET state = ? WHERE id = ?`).bind(state, id)]))"))
      .toEqual([]);
  });
});
