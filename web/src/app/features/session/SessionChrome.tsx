import { Alert } from "../../components/ui/Alert";

/** Inline form-level error, rendered as a design-system error Alert. Returns
 *  nothing when there is no message. The optional className is a layout hook on
 *  the wrapper (spacing differs per screen). */
export function SessionError({
  className,
  message,
}: {
  className?: string;
  message: string | null;
}) {
  if (!message) {
    return null;
  }
  return (
    <div class={className} role="alert">
      <Alert variant="error" text={message} />
    </div>
  );
}
