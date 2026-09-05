export type FirstDayProps = {
  /** Back to Zen. There is nothing to finish: the read state is this manifest with rows lit. */
  onZen: () => void;
};

/** Placeholder until the first-day distance lands. */
export function FirstDay({ onZen }: FirstDayProps) {
  return (
    <main class="firstday" aria-label="First day">
      <div class="instrument-top">
        <span class="wordmark">GSV</span>
        <span>your ship · first day</span>
        <span class="keys">
          <button type="button" onClick={onZen}>
            <kbd>n</kbd>back
          </button>
        </span>
      </div>
    </main>
  );
}
