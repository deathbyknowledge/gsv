import { REQUEST_REPORT_CATEGORIES, type ApproachSummary, type RequestReportCategory } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useId, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useT, type TextKey } from "../../../i18n/locale";
import { INSTRUMENT_APPROACHES_KEY } from "../wire/queryKeys";

const CATEGORY_TEXT = {
  spam: "people.report.spam",
  harassment: "people.report.harassment",
  impersonation: "people.report.impersonation",
  sexual: "people.report.sexual",
  other: "people.report.other",
} as const satisfies Record<RequestReportCategory, TextKey>;

/**
 * Reports a stranger's request to the person's operator, which declines it.
 * Their name and message go only when the person includes them; blocking is
 * left to the request, which shows its own outcome.
 */
export function ReportRequest({ request, canBlock, onReported, onClose }: {
  request: ApproachSummary; canBlock: boolean; onReported: (block: boolean) => void; onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [category, setCategory] = useState<RequestReportCategory | null>(null);
  const [includeMessage, setIncludeMessage] = useState(false);
  const [block, setBlock] = useState(false);
  const report = useMutation({
    mutationFn: (chosen: RequestReportCategory) => client.approach.report({ approachId: request.id, category: chosen, includeMessage }),
    onSuccess: () => onReported(block),
    onSettled: () => cache.invalidateQueries({ queryKey: INSTRUMENT_APPROACHES_KEY }),
  });
  return <form class="people-decision people-report" aria-labelledby={`${id}-title`} onSubmit={(event) => {
    event.preventDefault();
    if (category) report.mutate(category);
  }}>
    <h2 id={`${id}-title`}>{t("people.report.title")}</h2>
    <fieldset class="people-handling-choice" disabled={report.isPending}>
      <legend>{t("people.report.category")}</legend>
      {REQUEST_REPORT_CATEGORIES.map((value) => <label key={value}>
        <input type="radio" name={`${id}-category`} value={value} checked={category === value} required onChange={() => setCategory(value)} />
        <span>{t(CATEGORY_TEXT[value])}</span>
      </label>)}
    </fieldset>
    <label class="people-report-option"><input type="checkbox" checked={includeMessage} disabled={report.isPending} onChange={(event) => setIncludeMessage(event.currentTarget.checked)} />
      <span>{t("people.report.includeMessage")}<small>{t("people.report.includeMessageHint")}</small></span>
    </label>
    {canBlock && <label class="people-report-option"><input type="checkbox" checked={block} disabled={report.isPending} onChange={(event) => setBlock(event.currentTarget.checked)} />
      <span>{t("people.report.block")}</span>
    </label>}
    <p class="people-note">{t("people.report.declines", { name: request.displayName })}</p>
    <div class="people-actions">
      <button type="submit" class="people-action is-danger" disabled={!connected || !category || report.isPending}>{t(report.isPending ? "people.report.sending" : "people.report.send")}</button>
      <button type="button" class="people-action" disabled={report.isPending} onClick={onClose}>{t("common.cancel")}</button>
    </div>
    {report.error && <p class="people-error" role="alert">{report.error.message}</p>}
  </form>;
}
