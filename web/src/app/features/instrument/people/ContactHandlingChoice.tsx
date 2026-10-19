import { useId } from "preact/hooks";

export function ContactHandlingChoice({ value, onChange, disabled }: {
  value: boolean | null;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return <fieldset class="people-handling-choice" disabled={disabled} aria-describedby={`${id}-help`}>
    <legend>Who should handle new messages from this person?</legend>
    <label><input type="radio" name={id} value="human" checked={value === false} required onChange={() => onChange(false)} />
      <span>I’ll handle them<small>Read and reply yourself. Ask Ship whenever you want help.</small></span>
    </label>
    <label><input type="radio" name={id} value="ship" checked={value === true} required onChange={() => onChange(true)} />
      <span>Let Ship handle them<small>Your Ship can read and respond to new messages for you.</small></span>
    </label>
    <p class="people-note" id={`${id}-help`}>This only controls your Ship, and you can change it later. With either choice, replies to tasks you give Ship can reach it until the task is finished.</p>
  </fieldset>;
}
