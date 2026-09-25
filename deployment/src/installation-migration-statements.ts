// SQLite's statement-completion rules keep a trigger's ; END; together without
// treating CASE ... END) as an unclosed compound statement.
// https://github.com/sqlite/sqlite/blob/master/src/complete.c (public domain)
const transitions = [
  // ;, other, EXPLAIN, CREATE, TEMP, TRIGGER, END
  [0, 1, 2, 3, 1, 1, 1], // statement start
  [0, 1, 1, 1, 1, 1, 1], // ordinary statement
  [0, 2, 1, 3, 1, 1, 1], // EXPLAIN
  [0, 1, 1, 1, 3, 4, 1], // CREATE [TEMP]
  [5, 4, 4, 4, 4, 4, 4], // trigger body
  [5, 4, 4, 4, 4, 4, 6], // trigger statement's semicolon
  [0, 4, 4, 4, 4, 4, 4], // trigger's END
] as const;
const keywords = new Map<string, number>([["EXPLAIN", 2], ["CREATE", 3], ["TEMP", 4], ["TEMPORARY", 4], ["TRIGGER", 5], ["END", 6]]);

/** One executable SQLite statement per D1 batch entry, including trigger bodies. */
export function splitInstallationMigrationSql(sql: string): string[] {
  const statements: string[] = [];
  let state: number = 0;
  let start = 0;
  let cursor = 0;
  let hasSql = false;
  while (cursor < sql.length) {
    const char = sql[cursor];
    if (/\s/.test(char)) { cursor++; continue; }
    if (sql.startsWith("--", cursor)) {
      const end = sql.indexOf("\n", cursor + 2);
      cursor = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", cursor)) {
      const end = sql.indexOf("*/", cursor + 2);
      if (end === -1) throw new Error("Migration contains an unclosed SQL comment");
      cursor = end + 2;
      continue;
    }
    let token = 1;
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const closing = char === "[" ? "]" : char;
      cursor++;
      for (;;) {
        if (cursor >= sql.length) throw new Error("Migration contains an unclosed SQL quote");
        if (sql[cursor++] !== closing) continue;
        if (char !== "[" && sql[cursor] === closing) { cursor++; continue; }
        break;
      }
    } else if (/[a-zA-Z0-9_$\u0080-\uffff]/.test(char)) {
      const begin = cursor++;
      while (cursor < sql.length && /[a-zA-Z0-9_$\u0080-\uffff]/.test(sql[cursor])) cursor++;
      token = keywords.get(sql.slice(begin, cursor).toUpperCase()) ?? 1;
    } else {
      if (char === ";") token = 0;
      cursor++;
    }
    if (token !== 0) hasSql = true;
    state = transitions[state][token];
    if (state === 0) {
      if (hasSql) statements.push(sql.slice(start, cursor).trim());
      start = cursor;
      hasSql = false;
    }
  }
  if (state >= 4) throw new Error("Migration contains an incomplete SQL trigger");
  if (hasSql) statements.push(sql.slice(start).trim());
  return statements;
}
