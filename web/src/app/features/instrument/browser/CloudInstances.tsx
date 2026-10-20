import { useState } from "preact/hooks";
import { useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { useBrowserControl, useCloudInstances } from "./BrowserControl";
import { INSTANCE_QUERY_KEY } from "../wire/queryKeys";
import { useT } from "../../../i18n/locale";

export function StartCloudBrowser({ allowed }: { allowed: boolean }) {
  const t = useT();
  const { available, open } = useBrowserControl();
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!available) return null;
  const launch = async () => {
    setBusy(true); setError("");
    try {
      const key = `gsv:browser-open:${snapshot.username}`;
      const requestId = sessionStorage.getItem(key) ?? crypto.randomUUID();
      sessionStorage.setItem(key, requestId);
      const result = await client.sys.instance.start({ requestId, templateId: "browser" });
      sessionStorage.removeItem(key);
      open({ instanceId: result.instance.instanceId });
      await queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY });
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" class="fleet-heading-action" disabled={!allowed || !connected || busy} onClick={() => void launch()}>{busy ? t("browser.launching") : t("browser.launch")}</button>
    {error && <span class="error" role="alert">{error}</span>}
  </>;
}

export function CloudBrowserActions({ targetId, allowed }: { targetId: string; allowed: boolean }) {
  const t = useT();
  const { open } = useBrowserControl();
  const inventory = useCloudInstances();
  const instance = inventory.data?.instances.find(item => item.targetId === targetId && item.kind === "browser");
  return <section class="browser-actions">
    {instance && <button type="button" class="fleet-text-action" disabled={!allowed || !["ready", "starting"].includes(instance.state)} onClick={() => open({ instanceId: instance.instanceId })}>{t("browser.open")}</button>}
  </section>;
}
