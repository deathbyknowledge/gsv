import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Surface } from "../../../components/ui/Surface";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
import type { ConsoleIdentityLink } from "../domain/consoleModels";
import { useConsumeIdentityLinkCode } from "../hooks/useConsoleData";
import { adapterName } from "./messengerPresentation";
import "./MessengerIdentity.css";

type Notice = {
  label: string;
  text: string;
  tone: TagTone;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function linkNotice(link: ConsoleIdentityLink | null): Notice {
  return {
    label: "LINKED",
    text: link
      ? `${adapterName(link.adapter)} / ${link.actorId}`
      : "Identity linked",
    tone: "online",
  };
}

export function MessengerLinkCodePanel({
  errorText: linkErrorText,
  linkCount,
  refreshing,
}: {
  errorText?: string;
  linkCount: number;
  refreshing: boolean;
}) {
  const consumeCode = useConsumeIdentityLinkCode();
  const [code, setCode] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const canSubmit = code.trim().length > 0 && !consumeCode.isPending;

  const submit = async () => {
    if (!canSubmit) {
      return;
    }
    setNotice(null);
    try {
      const result = await consumeCode.mutateAsync({ code });
      setCode("");
      setResetKey((current) => current + 1);
      setNotice(linkNotice(result.link));
    } catch (error) {
      setNotice({ label: "ERROR", text: errorText(error), tone: "error" });
    }
  };

  return (
    <Surface class="gsv-messenger-link-code-panel" level={2}>
      <SectionHeader
        title="IDENTITY LINK"
        meta={refreshing ? "SYNCING" : `${linkCount} ${linkCount === 1 ? "LINK" : "LINKS"}`}
        divider
      />
      <div class="gsv-messenger-link-code-body">
        <TextInput
          key={`messenger-link-code-${resetKey}`}
          label="LINK CODE"
          description="Adapter-issued authorization code."
          requirement="required"
          placeholder="ABC123"
          value={code}
          clearable
          onChange={setCode}
          inputProps={{
            autoComplete: "one-time-code",
            name: "messengerIdentityLinkCode",
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            },
          }}
        />
        <Button
          variant="success"
          label={consumeCode.isPending ? "REDEEMING" : "REDEEM"}
          disabled={!canSubmit}
          onClick={submit}
        />
      </div>
      {notice || linkErrorText ? (
        <div class="gsv-messenger-link-code-notice">
          <Tag tone={notice?.tone ?? "error"} label={notice?.label ?? "ERROR"} boxed dot />
          <span>{notice?.text ?? linkErrorText}</span>
        </div>
      ) : null}
    </Surface>
  );
}
