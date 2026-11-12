import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import type { Ref } from "preact";
import { InfoTip } from "../../../components/ui/InfoTip";
import { Hint } from "../../../components/ui/Tooltip";
import { ruleCapabilityLabel } from "../../../components/ui/agentToolApprovalOptions";
import { rich, useT, type TextKey } from "../../../i18n/locale";
import { useMediaObjectUrl } from "../../../services/chat/hooks/useChatMediaSource";
import { usePublishedFile } from "../../../services/chat/hooks/useChatProcesses";
import {
  hilDetailLabel,
  hilPublication,
  hilRequestLine,
  hilRequestSentence,
  type HilPublication,
  type HilPublishedFile,
} from "../../../services/chat/domain/hil";
import { commandLine } from "./commandLine";
import "./approvalCard.css";

const CHANGE_LABELS = {
  create: "shell.approval.publishCreate",
  put: "shell.approval.publishPut",
  delete: "shell.approval.publishDelete",
} satisfies Record<HilPublication["changes"][number]["action"], TextKey>;

export type ApprovalCardProps = {
  request: ProcHilRequest;
  /** The account the action would run as, shown in the folded request line. */
  who: string;
  /** The place's label, as the person knows it. */
  place: string;
  label?: string;
  disabled?: boolean;
  shortcuts?: boolean;
  approveRef?: Ref<HTMLButtonElement>;
  onInspect?: () => void;
  onDecide: (decision: "approve" | "deny", remember?: boolean) => void;
};

/**
 * Ship's pending approval: what it wants to do in the person's words, the raw request folded beneath.
 * A publish also names who it speaks as, every change it makes, and the files its records carry.
 * Secondary notes (where to inspect it, that nothing runs yet) live in tooltips to keep the card short.
 */
export function ApprovalCard({ request, who, place, label, disabled = false, shortcuts = true, approveRef, onInspect, onDecide }: ApprovalCardProps) {
  const t = useT();
  const line = hilRequestLine(request);
  const publication = hilPublication(request);
  const heading = <>{label ?? t("shell.approval.label")} · {place}</>;
  const exactDetails = <pre class="approval-exact">{JSON.stringify({ syscall: request.syscall, target: request.target, args: request.args }, null, 2)}</pre>;
  return (
    <div class="zen-approval">
      <div class="q">
        {onInspect ? <Hint text={t("shell.approval.inspect")} position="top-start">
          <button type="button" onClick={onInspect}>{heading}</button>
        </Hint> : <span>{heading}</span>}
        <InfoTip text={t("shell.approval.waiting")} label={t("shell.approval.about")} />
      </div>
      <p class="ask">{hilRequestSentence(request, place)}</p>
      {publication ? <div class="approval-publish">
        <p>{rich(t("shell.approval.publishAs"), {
          handle: <Hint text={publication.address}><span class="approval-handle" tabIndex={0}>{`@${publication.handle}`}</span></Hint>,
        })}</p>
        <ul>
          {publication.changes.map((change, index) => <li key={index}>{t(CHANGE_LABELS[change.action], { record: change.record })}</li>)}
        </ul>
        {publication.files.length > 0 ? <div class="approval-files">
          {publication.files.map((file) => <PublishedFile key={file.cid} file={file} />)}
        </div> : null}
      </div> : null}
      <details class="fold">
        <summary>{hilDetailLabel(request)}</summary>
        {line ? <>
          <div class="machine-rail">
            {line.lead === "prompt" ? commandLine(who, request.target, line.text) : <span class="cmd">
              {line.lead === "place" ? <><span class="where">{request.target}</span> · </> : null}
              {line.text}
            </span>}
          </div>
          <details class="fold">
            <summary>{t("shell.approval.fullRequest")}</summary>
            {exactDetails}
          </details>
        </> : exactDetails}
      </details>
      <div class="keys">
        <button ref={approveRef} type="button" class="ibtn is-primary" disabled={disabled} onClick={() => { if (!disabled) onDecide("approve"); }}>
          {shortcuts ? <kbd>y</kbd> : null} {t("shell.approval.run")}
        </button>
        <button type="button" class="ibtn" disabled={disabled} onClick={() => { if (!disabled) onDecide("deny"); }}>
          {shortcuts ? <kbd>n</kbd> : null} {t("shell.approval.deny")}
        </button>
        {!["*", "any", "device", "devices/*", "targets/*"].includes(request.target) ? (
          <Hint text={t("shell.approval.alwaysAllowHint", { capability: ruleCapabilityLabel(request.syscall), place })}>
            <button type="button" class="remember" disabled={disabled} onClick={() => { if (!disabled) onDecide("approve", true); }}>{t("shell.approval.alwaysAllow")}</button>
          </Hint>
        ) : null}
      </div>
    </div>
  );
}

/** A picture shows as itself; any other file, or a picture that cannot load, by its type and size. */
function PublishedFile({ file }: { file: HilPublishedFile }) {
  const t = useT();
  const picture = usePublishedFile(file.mimeType.startsWith("image/") ? file : null);
  const source = useMediaObjectUrl(picture.data);
  const megabytes = file.size >= 1024 * 1024;
  const size = (file.size / (megabytes ? 1024 * 1024 : 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const label = t(megabytes ? "shell.approval.fileMegabytes" : "shell.approval.fileKilobytes", { type: file.mimeType, size });
  return source
    ? <figure class="approval-file"><img src={source} alt={t("shell.approval.publishPicture")} /><figcaption>{label}</figcaption></figure>
    : <span class="approval-file">{label}</span>;
}
