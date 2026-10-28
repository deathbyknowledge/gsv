import { useEffect, useState } from "preact/hooks";
import { IconButton } from "../../../components/ui/IconButton";
import { useT } from "../../../i18n/locale";

export function SetupCommand({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { setStatus("idle"); }, [text]);
  return <div class="fleet-setup-command">
    <pre class="fleet-setup">{text}</pre>
    <div class="fleet-actions"><IconButton glyph="copy" title={label} onClick={() => {
      void navigator.clipboard.writeText(text).then(() => setStatus("copied"), () => setStatus("failed"));
    }} /><span role="status">{status === "copied" ? t("shell.copied") : status === "failed" ? t("shell.setup.copyFailed") : ""}</span></div>
  </div>;
}
