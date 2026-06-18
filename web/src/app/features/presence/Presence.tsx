import { useEffect, useState } from "preact/hooks";
import { statusKey } from "./display";
import type { PresenceController, PresenceSnapshot } from "./presenceController";
import type { PresenceLogStatus, PresenceMode } from "./types";

type PresenceProps = {
  controller: PresenceController;
};

function usePresenceSnapshot(controller: PresenceController): PresenceSnapshot {
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());

  useEffect(() => {
    setSnapshot(controller.getSnapshot());
    return controller.subscribe(() => setSnapshot(controller.getSnapshot()));
  }, [controller]);

  return snapshot;
}

function MicrophoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function PresenceTopbarToggle({ controller }: PresenceProps) {
  const snapshot = usePresenceSnapshot(controller);
  return (
    <button
      type="button"
      class="presence-toggle"
      data-state={snapshot.state}
      data-agent={snapshot.activeRunCount > 0 ? "active" : "idle"}
      title={snapshot.fullStatus}
      aria-label={`Mind: ${snapshot.compactStatus}`}
      aria-haspopup="dialog"
      aria-expanded={snapshot.panelOpen ? "true" : "false"}
      aria-controls="presence-panel"
      onClick={() => controller.togglePanel()}
    >
      <span class="topbar-icon" aria-hidden="true">
        <MicrophoneIcon />
      </span>
      <span class="presence-toggle-light" aria-hidden="true" />
      <span class="presence-toggle-copy">
        <span class="presence-toggle-label">Mind</span>
        <span class="presence-toggle-status">{snapshot.compactStatus}</span>
      </span>
    </button>
  );
}

export function PresenceMobileToggle({ controller }: PresenceProps) {
  const snapshot = usePresenceSnapshot(controller);
  return (
    <button
      type="button"
      class="mobile-home-action presence-toggle"
      data-state={snapshot.state}
      data-agent={snapshot.activeRunCount > 0 ? "active" : "idle"}
      title={snapshot.fullStatus}
      aria-label={`Mind: ${snapshot.compactStatus}`}
      aria-haspopup="dialog"
      aria-expanded={snapshot.panelOpen ? "true" : "false"}
      aria-controls="presence-panel"
      onClick={() => controller.togglePanel()}
    >
      <span aria-hidden="true">
        <MicrophoneIcon />
      </span>
    </button>
  );
}

export function PresenceActivity({ controller }: PresenceProps) {
  const snapshot = usePresenceSnapshot(controller);
  const activityClass = `presence-activity${snapshot.activity.compact ? " is-compact" : ""}${snapshot.panelOpen ? " is-expanded" : ""}`;
  return (
    <button
      type="button"
      class={activityClass}
      data-status={snapshot.activity.tone}
      aria-live="polite"
      aria-atomic="false"
      aria-controls="presence-panel"
      aria-expanded={snapshot.panelOpen ? "true" : "false"}
      title={`Mind: ${snapshot.activity.body}`}
      aria-label={`Mind: ${snapshot.activity.status}. ${snapshot.activity.body}`}
      onClick={() => controller.togglePanel()}
    >
      <span class="presence-activity-head">
        <span class="presence-activity-pulse" aria-hidden="true" />
        <span>
          <strong>Mind</strong>
          <small>{snapshot.activity.status}</small>
        </span>
      </span>
      <span class="presence-activity-body">{snapshot.activity.body}</span>
    </button>
  );
}

export function PresencePanel({ controller }: PresenceProps) {
  const snapshot = usePresenceSnapshot(controller);
  const hasTranscript = snapshot.transcript.trim().length > 0;
  const busy = snapshot.state === "sending" || snapshot.state === "transcribing";
  const listenDisabled = snapshot.mode === "ambient"
    ? !snapshot.connected || !snapshot.ambientAvailable || (!snapshot.ambientActive && busy)
    : busy || !snapshot.connected || !snapshot.recorderAvailable;
  const sendDisabled = busy || !snapshot.connected || !hasTranscript;
  const clearDisabled = busy || (!hasTranscript && !snapshot.note && !snapshot.lastSentText);
  const transcriptPlaceholder = snapshot.mode === "ambient"
    ? "Ambient is on. Type here when you want to send manually."
    : snapshot.recorderAvailable ? "Type to Mind" : "Type a message to Mind";

  return (
    <section
      class="presence-panel"
      id="presence-panel"
      role="dialog"
      aria-label="Mind"
      hidden={!snapshot.panelOpen}
      data-state={snapshot.state}
      data-agent={snapshot.activeRunCount > 0 ? "active" : "idle"}
      data-mode={snapshot.mode}
    >
      <header class="presence-panel-head">
        <div class="presence-panel-brand">
          <span class="presence-panel-mark" aria-hidden="true">GSV</span>
          <span class="presence-panel-copy">
            <strong>Mind</strong>
          </span>
        </div>
        <button type="button" class="presence-panel-close" aria-label="Close Mind" onClick={() => controller.closePanel()}>
          <CloseIcon />
        </button>
      </header>
      <section class="presence-current" aria-live="polite">
        <span class="presence-current-orb" aria-hidden="true" />
        <div>
          <strong>{snapshot.fullStatus}</strong>
          <span class="presence-interim">{snapshot.note}</span>
        </div>
      </section>
      <div class="presence-actions presence-actions-main">
        <button type="button" class="presence-primary" disabled={listenDisabled} onClick={() => void controller.listen()}>
          {snapshot.listenButtonText}
        </button>
      </div>
      <PresenceLog rows={snapshot.logRows} />
      <details class="presence-section presence-manual">
        <summary>Manual</summary>
        <div class="presence-mode" role="group" aria-label="Mind input mode">
          <PresenceModeButton controller={controller} snapshot={snapshot} mode="ambient">Ambient</PresenceModeButton>
          <PresenceModeButton controller={controller} snapshot={snapshot} mode="push">Manual</PresenceModeButton>
        </div>
        <textarea
          class="presence-transcript"
          rows={4}
          autoComplete="off"
          spellcheck={true}
          aria-label="Message to Mind"
          placeholder={transcriptPlaceholder}
          value={snapshot.transcript}
          onInput={(event) => controller.setTranscript(event.currentTarget.value)}
        />
        <div class="presence-actions">
          <button type="button" class="presence-secondary" disabled={sendDisabled} onClick={() => void controller.sendManualTextToPersonalAgent()}>
            Send
          </button>
          <button type="button" class="presence-secondary" disabled={clearDisabled} onClick={() => controller.clearTranscript()}>
            Clear
          </button>
        </div>
      </details>
      <details class="presence-section presence-voice">
        <summary>Voice</summary>
        <div class="presence-speech-controls">
          <label class="presence-speech-toggle">
            <span>Read replies</span>
            <input
              type="checkbox"
              checked={snapshot.speakReplies}
              disabled={!snapshot.connected}
              onChange={(event) => controller.setSpeakReplies(event.currentTarget.checked)}
            />
          </label>
          <button type="button" disabled={!snapshot.connected} onClick={() => controller.previewSpeech()}>
            Preview voice
          </button>
        </div>
        <div class="presence-speech-status">{snapshot.speechStatus}</div>
      </details>
    </section>
  );
}

function PresenceModeButton({
  controller,
  snapshot,
  mode,
  children,
}: {
  controller: PresenceController;
  snapshot: PresenceSnapshot;
  mode: PresenceMode;
  children: string;
}) {
  const selected = snapshot.mode === mode;
  const disabled = (mode === "ambient" && !snapshot.ambientAvailable)
    || snapshot.state === "recording"
    || snapshot.state === "capturing";
  return (
    <button
      type="button"
      class={selected ? "is-selected" : ""}
      aria-pressed={selected ? "true" : "false"}
      disabled={disabled}
      onClick={() => controller.setMode(mode)}
    >
      {children}
    </button>
  );
}

function PresenceLog({ rows }: { rows: PresenceSnapshot["logRows"] }) {
  return (
    <div class="presence-log" hidden={rows.length === 0}>
      {rows.map((row) => (
        <div key={row.id} class="presence-log-row" data-status={statusKey(row.status)}>
          <span class="presence-log-meta">{formatClock(row.timestamp)} {row.status}</span>
          <p>{row.text}</p>
        </div>
      ))}
    </div>
  );
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
