import type { JsonValue } from "@humansandmachines/gsv/protocol";

export function RequestDetails({ value }: { value: JsonValue }) {
  if (value === null) return <span>—</span>;
  if (Array.isArray(value)) return <ul>{value.map((entry, index) => <li key={index}><RequestDetails value={entry} /></li>)}</ul>;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JsonValue is the parsed recursive protocol union; objects contain request detail fields.
  if (typeof value === "object") return <dl>{Object.entries(value).map(([key, entry]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd><RequestDetails value={entry} /></dd></div>)}</dl>;
  return <span>{String(value)}</span>;
}

