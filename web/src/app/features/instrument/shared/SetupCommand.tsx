import { useEffect, useState } from "preact/hooks";

export function SetupCommand({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState("");
  useEffect(() => { setStatus(""); }, [text]);
  return <div class="fleet-setup-command">
    <pre class="fleet-setup">{text}</pre>
    <div class="fleet-actions"><button class="fleet-text-action" type="button" onClick={() => {
      void navigator.clipboard.writeText(text).then(() => setStatus("copied"), () => setStatus("Select and copy the text above."));
    }}>{label}</button><span role="status">{status}</span></div>
  </div>;
}
