export function CompactDialog(props: {
  value: string;
  messageCount: number;
  compactBusy: boolean;
  onChange(value: string): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <div class="modal-backdrop" role="presentation">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="compact-title">
        <header>
          <h2 id="compact-title">Compact Conversation</h2>
          <p>Archive older messages and keep the newest messages live in context.</p>
        </header>
        <label class="field-row">
          <span>Newest messages to keep</span>
          <input type="number" min="0" value={props.value} disabled={props.compactBusy} onInput={(event) => props.onChange((event.currentTarget as HTMLInputElement).value)} />
        </label>
        <p class="modal-note">Current live message count: {props.messageCount}</p>
        <footer>
          <button type="button" class="secondary-button" disabled={props.compactBusy} onClick={props.onCancel}>Cancel</button>
          <button type="button" class="primary-button" disabled={props.compactBusy} onClick={props.onConfirm}>
            {props.compactBusy ? "Compacting..." : "Compact"}
          </button>
        </footer>
      </section>
    </div>
  );
}
