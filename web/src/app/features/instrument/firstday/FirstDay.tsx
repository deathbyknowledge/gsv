import type { FleetReference } from "../fleet/fleetModel";
import "./firstday.css";

export function FirstDay({ places, onFleet, onSettings }: {
  places: readonly { id: string; label: string }[];
  onFleet: (reference?: FleetReference) => void;
  onSettings: () => void;
}) {
  return <div class="zen-empty zen-first-day">
    <p class="fd-hello">Ask anything. I can reach <span class="place">your cloud home</span>
      {places.map((place) => <span key={place.id}>, <span class="place">{place.label}</span></span>)}.
    </p>
    <p class="fd-intro">Connect more of your world whenever you’re ready.</p>
    <div class="fd-suggestions">
      <button class="fd-suggestion" type="button" onClick={() => onFleet({ kind: "connect", to: "place" })}>
        <span>Connect a computer or browser</span><small>Work with your files, commands, and websites.</small><span aria-hidden="true">↗</span>
      </button>
      <button class="fd-suggestion" type="button" onClick={() => onFleet({ kind: "connect", to: "contact" })}>
        <span>Add a contact</span><small>Connect with someone who has their own Ship.</small><span aria-hidden="true">↗</span>
      </button>
      <button class="fd-suggestion" type="button" onClick={onSettings}>
        <span>Make it yours</span><small>Choose your models, permissions, and integrations.</small><span aria-hidden="true">↗</span>
      </button>
    </div>
    <p class="fd-later">You can always add more in Fleet and Settings.</p>
  </div>;
}
