import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Surface } from "../../../components/ui/Surface";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
import type { ConsoleIdentityLink } from "../domain/consoleModels";
import { useConsumeIdentityLinkCode } from "../hooks/useConsoleData";
import { useUnsavedGuard } from "../../gsv-shell/unsaved/unsavedGuard";
import { adapterName } from "./messengerPresentation";
import "./MessengerIdentity.css";

type Notice = {
  label: string;
  text: string;
  tone: TagTone;
};

export type MessengerLinkCodeDependencies = {
  Surface: (props: Parameters<typeof Surface>[0]) => ComponentChildren;
  useConsumeIdentityLinkCode: () => Pick<ReturnType<typeof useConsumeIdentityLinkCode>, "isPending" | "mutateAsync">;
  useUnsavedGuard: typeof useUnsavedGuard;
};

const defaultDependencies: MessengerLinkCodeDependencies = {
  Surface: (props) => <Surface {...props} />,
  useConsumeIdentityLinkCode: () => useConsumeIdentityLinkCode(),
  useUnsavedGuard: (...args) => useUnsavedGuard(...args),
};

function errorText<T>(error: T): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function linkNotice(link: ConsoleIdentityLink | null): Notice {
  return {
    label: "LINKED",
    text: link
      ? `${adapterName(link.adapter)} identity linked to the signed-in GSV user.`
      : "Identity linked",
    tone: "online",
  };
}

export function MessengerLinkCodePanel({
  errorText: linkErrorText,
  linkCount,
  refreshing,
  dependencies,
}: {
  errorText?: string;
  linkCount: number;
  refreshing: boolean;
  dependencies?: MessengerLinkCodeDependencies;
}) {
  const resolvedDependencies = dependencies ?? defaultDependencies;
  const SurfaceComponent = resolvedDependencies.Surface;
  const consumeCode = resolvedDependencies.useConsumeIdentityLinkCode();
  const [code, setCode] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);

  resolvedDependencies.useUnsavedGuard(() => code.trim() !== "");

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
    <SurfaceComponent class="gsv-messenger-link-code-panel" level={2}>
      <SectionHeader
        title="LINK MESSENGER IDENTITY"
        meta={refreshing ? "SYNCING" : `${linkCount} ${linkCount === 1 ? "LINK" : "LINKS"}`}
        divider
      />
      <div class="gsv-messenger-link-code-body">
        <TextInput
          key={`messenger-link-code-${resetKey}`}
          label="AUTHORIZATION CODE"
          description="Message a connected messenger to receive a code. It identifies the messenger automatically and links its sender to the signed-in GSV user."
          requirement="required"
          placeholder="ABCD-EFGH"
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
          label={consumeCode.isPending ? "LINKING" : "LINK IDENTITY"}
          disabled={!canSubmit}
          onClick={submit}
        />
      </div>
      {notice || linkErrorText ? (
        <div class="gsv-messenger-link-code-notice gsv-prose">
          <Tag tone={notice?.tone ?? "error"} label={notice?.label ?? "ERROR"} boxed dot />
          <span>{notice?.text ?? linkErrorText}</span>
        </div>
      ) : null}
    </SurfaceComponent>
  );
}
