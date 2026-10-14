export const PEOPLE_IDEAS = [
  { title: "Make plans", request: "Find a time for dinner next week.",
    action: "Find a time for dinner with {name} next week. Ask them what works, then bring me the options.",
    exchange: "What evenings work for you?", outcome: "Two evenings work for both of you." },
  { title: "Plan a trip", request: "Let’s figure out a weekend away.",
    action: "Help {name} and me plan a weekend away. Ask what dates and places they have in mind, then make a shortlist.",
    exchange: "Any dates or places you have in mind?", outcome: "A shortlist you can decide on together." },
  { title: "Work together", request: "Help us get this project moving.",
    action: "Help me coordinate a project with {name}. Read our conversation, help us agree on next steps, and keep me posted.",
    exchange: "What needs to happen next?", outcome: "A shared plan, with clear next steps." },
] as const;

export function PeopleWelcome({ idea, onIdea, onConnect, disabled }: {
  idea: number; onIdea: (index: number) => void; onConnect: () => void; disabled: boolean;
}) {
  const selected = PEOPLE_IDEAS[idea];
  return <section class="people-welcome" aria-labelledby="people-welcome-title">
    <span class="people-kicker">YOUR PEOPLE. YOUR SHIPS.</span>
    <h2 id="people-welcome-title">Life happens<br />with other people.</h2>
    <p class="people-welcome-intro">Connect with someone on GSV. Talk directly, share things, or ask Ship to help you make something happen together.</p>
    <div class="people-examples" aria-label="Things to try together">
      <div class="people-example-tabs" role="tablist" aria-label="Examples">{PEOPLE_IDEAS.map((example, index) =>
        <button key={example.title} role="tab" id={`people-example-${index}`} aria-selected={idea === index} aria-controls="people-example" tabIndex={idea === index ? 0 : -1}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? PEOPLE_IDEAS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + PEOPLE_IDEAS.length) % PEOPLE_IDEAS.length;
            onIdea(next); document.getElementById(`people-example-${next}`)?.focus();
          }} onClick={() => onIdea(index)}>{example.title}</button>)}</div>
      <div id="people-example" class="people-example" role="tabpanel" aria-labelledby={`people-example-${idea}`}>
        <div class="people-example-line"><span>You</span><p>“{selected.request}”</p></div>
        <div class="people-example-line is-ship"><span>Your Ship → them</span><p>{selected.exchange}</p></div>
        <div class="people-example-result"><span aria-hidden="true">↳</span><p>{selected.outcome}</p></div>
      </div>
    </div>
    <div class="people-welcome-actions"><button class="ibtn is-primary" disabled={disabled} onClick={onConnect}>try this with someone <span aria-hidden="true">↗</span></button><span>Start with one person you know.</span></div>
    <p class="people-welcome-footnote">You can always message each other yourself. Ship joins in when you ask.</p>
  </section>;
}
