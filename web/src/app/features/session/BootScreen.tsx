type BootScreenProps = {
  visible: boolean;
  message: string | null;
};

export function BootScreen({
  visible,
  message,
}: BootScreenProps) {
  return (
    <div class="boot-screen" data-session-boot-view hidden={!visible} role="status" aria-live="polite" aria-busy={visible}>
      <div class="boot-mark" aria-hidden="true">GSV</div>
      <div class="boot-progress" aria-hidden="true">
        <span />
      </div>
      <p>{message ?? "Starting GSV..."}</p>
    </div>
  );
}
