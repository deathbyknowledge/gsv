import type { SharedContextAssertion } from "@humansandmachines/gsv/protocol";

export const CONTEXT_KIND_LABELS = { connection: "Connection", recommendation: "Recommendation", advisory: "Advisory" } as const;
export const CONTEXT_KIND_EXPLANATIONS = {
  connection: "A relationship both people have agreed to disclose.",
  recommendation: "An endorsement attributed to the person who shared it.",
  advisory: "An experience or concern attributed to the person who shared it.",
} as const;

export function ContextStatement({ assertion }: { assertion: SharedContextAssertion }) {
  return <div class="people-context-statement">
    <div class="people-context-meta"><span>{CONTEXT_KIND_LABELS[assertion.kind]}</span>{assertion.category && <span>{assertion.category}</span>}</div>
    <h4>{assertion.label}</h4>
    {assertion.text && <p class="people-context-text">{assertion.text}</p>}
    {!!assertion.evidence.length && <div class="people-context-quotes"><p class="people-note">Selected quotes shared by the author</p>{assertion.evidence.map((quote, index) => <blockquote key={index}>{quote.text}</blockquote>)}</div>}
    <p class="people-note">Expires {new Date(assertion.expiresAtMs).toLocaleDateString(undefined, { dateStyle: "medium" })}</p>
    <details class="people-identity"><summary>Statement identity</summary><dl>
      <dt>Author</dt><dd>{assertion.issuer.shipId}<br />{assertion.issuer.subjectId}</dd>
      <dt>About</dt><dd>{assertion.subject.shipId}<br />{assertion.subject.subjectId}</dd>
      <dt>Statement</dt><dd>{assertion.id} · revision {assertion.revision}</dd>
    </dl></details>
  </div>;
}
