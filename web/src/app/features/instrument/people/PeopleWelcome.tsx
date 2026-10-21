import { rich, useT, type TextKey } from "../../../i18n/locale";

/** Each idea's `action` is the request prepared for Ship, so it stays English. */
export const PEOPLE_IDEAS: ReadonlyArray<{ title: TextKey; request: TextKey; exchange: TextKey; outcome: TextKey; next: TextKey; action: string }> = [
  { title: "people.idea.plans.title", request: "people.idea.plans.request",
    action: "Find a time for dinner with {name} next week. Ask them what works, then bring me the options.",
    exchange: "people.idea.plans.exchange", outcome: "people.idea.plans.outcome", next: "people.idea.plans.next" },
  { title: "people.idea.trip.title", request: "people.idea.trip.request",
    action: "Help {name} and me plan a weekend away. Ask what dates and places they have in mind, then make a shortlist.",
    exchange: "people.idea.trip.exchange", outcome: "people.idea.trip.outcome", next: "people.idea.trip.next" },
  { title: "people.idea.together.title", request: "people.idea.together.request",
    action: "Help me coordinate a project with {name}. Read our conversation, help us agree on next steps, and keep me posted.",
    exchange: "people.idea.together.exchange", outcome: "people.idea.together.outcome", next: "people.idea.together.next" },
];

export function PeopleWelcome({ idea, onIdea, onConnect, disabled }: {
  idea: number; onIdea: (index: number) => void; onConnect: () => void; disabled: boolean;
}) {
  const t = useT();
  const selected = PEOPLE_IDEAS[idea];
  return <section class="people-welcome" aria-labelledby="people-welcome-title">
    <span class="people-kicker">{t("people.welcome.kicker")}</span>
    <h2 id="people-welcome-title">{rich(t("people.welcome.title"), { br: <br /> })}</h2>
    <p class="people-welcome-intro">{t("people.welcome.intro")}</p>
    <div class="people-examples" aria-label={t("people.welcome.examples")}>
      <div class="people-example-tabs" role="tablist" aria-label={t("people.welcome.tabs")}>{PEOPLE_IDEAS.map((example, index) =>
        <button key={example.title} role="tab" id={`people-example-${index}`} aria-selected={idea === index} aria-controls="people-example" tabIndex={idea === index ? 0 : -1}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? PEOPLE_IDEAS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + PEOPLE_IDEAS.length) % PEOPLE_IDEAS.length;
            onIdea(next); document.getElementById(`people-example-${next}`)?.focus();
          }} onClick={() => onIdea(index)}>{t(example.title)}</button>)}</div>
      <div id="people-example" class="people-example" role="tabpanel" aria-labelledby={`people-example-${idea}`}>
        <div class="people-example-line"><span>{t("people.welcome.you")}</span><p>{t(selected.request)}</p></div>
        <div class="people-example-line is-ship"><span>{t("people.welcome.shipToThem")}</span><p>{t(selected.exchange)}</p></div>
        <div class="people-example-result"><span aria-hidden="true">↳</span><p>{t(selected.outcome)}</p></div>
      </div>
    </div>
    <div class="people-welcome-actions"><button class="ibtn is-primary" disabled={disabled} onClick={onConnect}>{t("people.welcome.try")} <span aria-hidden="true">↗</span></button><span>{t("people.welcome.start")}</span></div>
    <p class="people-welcome-footnote">{t("people.welcome.footnote")}</p>
  </section>;
}
