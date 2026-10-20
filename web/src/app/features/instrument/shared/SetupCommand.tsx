import { useEffect, useState } from "preact/hooks";
import { useT } from "../../../i18n/locale";

export function SetupCommand({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { setStatus("idle"); }, [text]);
  return <div class="fleet-setup-command">
    <pre class="fleet-setup">{text}</pre>
    <div class="fleet-actions"><button class="ibtn fleet-copy-command" type="button" onClick={() => {
      void navigator.clipboard.writeText(text).then(() => setStatus("copied"), () => setStatus("failed"));
    }}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true" focusable="false">
        <rect x="5" y="5" width="8" height="9" rx="1" />
        <path d="M10 3V2H2v9h1" />
      </svg>
      {label}
    </button><span role="status">{status === "copied" ? t("shell.copied") : status === "failed" ? t("shell.setup.copyFailed") : ""}</span></div>
  </div>;
}
