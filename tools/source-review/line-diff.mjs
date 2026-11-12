// Prompt texts are a few hundred lines, so a plain longest-common-subsequence table is fast enough.
export function diffLines(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i], oldLine: ++i, newLine: ++j });
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      lines.push({ kind: "del", text: a[i], oldLine: ++i });
    } else {
      lines.push({ kind: "add", text: b[j], newLine: ++j });
    }
  }
  return lines;
}

// Groups changed lines with their surrounding context, merging nearby changes like `diff -u`.
export function unifiedHunks(before, after, context = 3) {
  const lines = diffLines(before, after);
  const ranges = [];
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length, index + context + 1);
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  });
  return {
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "del").length,
    hunks: ranges.map(({ start, end }) => {
      const hunkLines = lines.slice(start, end);
      return {
        oldStart: hunkLines.find((line) => line.oldLine)?.oldLine ?? 0,
        newStart: hunkLines.find((line) => line.newLine)?.newLine ?? 0,
        lines: hunkLines.map(({ kind, text }) => ({ kind, text })),
      };
    }),
  };
}

function splitLines(text) {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}
