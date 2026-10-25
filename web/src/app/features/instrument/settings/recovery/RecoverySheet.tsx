import type { AtprotoRecoveryGetResult } from "@humansandmachines/gsv/protocol";
import { useQueryClient } from "@tanstack/preact-query";
import { useEffect, useReducer, useState } from "preact/hooks";
import { useT } from "../../../../i18n/locale";
import { publicDeployment } from "../../../../services/deployment";
import { useGateway } from "../../../../services/gateway/GatewayProvider";
import { CHECKED_WORDS, changeRecoverySheet, recoverySheetFlow, type RecoverySheetRefusal } from "./recoverySheetFlow";
import type { RecoverySheetDraft } from "./recoverySheetKeys";
import "./recovery-sheet.css";

export const RECOVERY_SHEET_QUERY = ["atproto", "recovery-sheet"] as const;
/** GSV's own docs explain using a sheet, so the page outlives any operator. */
const SHEET_GUIDE = "https://docs.gsv.space/how-to/recovery-sheet";

type Translate = ReturnType<typeof useT>;
type Ready = AtprotoRecoveryGetResult & { identity: NonNullable<AtprotoRecoveryGetResult["identity"]> };

/** Making, replacing and removing the recovery sheet, for a Ship whose identity exists. */
export function RecoverySheet({ status, active }: { status: Ready; active: boolean }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [flow, dispatch] = useReducer(recoverySheetFlow, { step: "idle" });
  const [confirming, setConfirming] = useState<"replace" | "remove" | null>(null);
  const [typed, setTyped] = useState(["", "", ""]);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operator = publicDeployment().operatorName;
  const clear = () => { setTyped(["", "", ""]); setPassword(""); setCode(""); setError(null); setConfirming(null); };
  // Leaving the section drops the sheet's words, the password and the code.
  useEffect(() => { if (!active) { dispatch({ type: "close" }); clear(); } }, [active]);

  const show = async () => {
    setBusy(true); setError(null);
    try {
      const { makeRecoverySheet } = await import("./recoverySheetKeys");
      dispatch({ type: "show", draft: await makeRecoverySheet() });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("settings.recoverySheet.failed")); }
    finally { setBusy(false); }
  };
  const finish = async (event: Event) => {
    event.preventDefault();
    if (flow.step !== "finish" || busy || !connected || !password) return;
    setBusy(true); setError(null);
    try {
      const result = await changeRecoverySheet(client, flow.draft?.key ?? null, flow.codeTo ? { password, code } : { password });
      dispatch({ type: "answer", result });
      if (result.status === "done") {
        clear();
        cache.setQueryData<AtprotoRecoveryGetResult>(RECOVERY_SHEET_QUERY, { ...status, sheet: result.sheet });
      } else if (result.status === "refused" && result.reason === "code-expired") setCode("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("settings.recoverySheet.failed")); }
    finally { setBusy(false); }
  };
  const close = () => { dispatch({ type: "close" }); clear(); };
  const failure = error && <p class="settings-error" role="alert">{error}</p>;

  if (flow.step === "before") return <section class="settings-form recovery-sheet">
    <h1>{t("settings.recoverySheet.before")}</h1>
    <ul class="recovery-sheet-rules">
      <li>{t("settings.recoverySheet.beforePassport")}</li>
      <li>{t("settings.recoverySheet.beforePrint")}</li>
      <li>{t("settings.recoverySheet.beforeNoCopies")}</li>
      <li>{operator ? t("settings.recoverySheet.beforeNeverAsk", { operator }) : t("settings.recoverySheet.beforeNeverAskDefault")}</li>
    </ul>
    {failure}
    <div class="settings-actions">
      <button class="ibtn" type="button" disabled={busy} onClick={() => void show()}>{t("settings.recoverySheet.show")}</button>
      <button class="settings-text-action" type="button" onClick={close}>{t("settings.recoverySheet.notNow")}</button>
    </div>
  </section>;

  if (flow.step === "sheet") return <section class="settings-form recovery-sheet">
    <SheetPaper draft={flow.draft} identity={status.identity} t={t} />
    <div class="settings-actions">
      <button class="ibtn" type="button" onClick={() => printSheet()}>{t("settings.recoverySheet.print")}</button>
      <button class="ibtn" type="button" onClick={() => dispatch({ type: "written" })}>{t("settings.recoverySheet.written")}</button>
      <button class="settings-text-action" type="button" onClick={close}>{t("common.cancel")}</button>
    </div>
  </section>;

  if (flow.step === "check") return <form class="settings-form recovery-sheet" onSubmit={(event) => { event.preventDefault(); dispatch({ type: "check", typed }); }}>
    <h1>{t("settings.recoverySheet.checkTitle")}</h1>
    <p>{t("settings.recoverySheet.checkHint")}</p>
    {CHECKED_WORDS.map((position, at) => <label key={position}>{t("settings.recoverySheet.word", { number: String(position) })}
      <input autoComplete="off" autoCapitalize="none" spellcheck={false} value={typed[at]}
        onInput={(event) => { const value = event.currentTarget.value; setTyped((old) => old.map((word, index) => index === at ? value : word)); }} />
    </label>)}
    {flow.mismatch !== null && <p class="settings-error" role="alert">{t("settings.recoverySheet.wordMismatch", { number: String(flow.mismatch) })}</p>}
    <div class="settings-actions">
      <button class="ibtn" type="submit" disabled={typed.some((word) => !word.trim())}>{t("settings.recoverySheet.check")}</button>
      <button class="settings-text-action" type="button" onClick={() => dispatch({ type: "back" })}>{t("settings.recoverySheet.backToSheet")}</button>
    </div>
  </form>;

  if (flow.step === "finish") return <form class="settings-form recovery-sheet" onSubmit={(event) => void finish(event)}>
    <h1>{t(flow.draft ? "settings.recoverySheet.title" : "settings.recoverySheet.removeTitle")}</h1>
    <p>{flow.codeTo ? t("settings.recoverySheet.codeHint", { address: flow.codeTo }) : t("settings.recoverySheet.passwordHint")}</p>
    <label>{t("settings.recoverySheet.password")}<input type="password" autoComplete="current-password" maxLength={1024} value={password} disabled={busy} onInput={(event) => setPassword(event.currentTarget.value)} /></label>
    {flow.codeTo && <label>{t("settings.recoverySheet.code")}<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} disabled={busy} onInput={(event) => setCode(event.currentTarget.value.replace(/\D/g, ""))} /></label>}
    {flow.refusal && <p class="settings-error" role="alert">{refusalText(t, flow.refusal)}</p>}
    {failure}
    <div class="settings-actions">
      <button class="ibtn" type="submit" disabled={busy || !connected || !password || (flow.codeTo !== null && code.length !== 6)}>{t(busy ? "settings.recoverySheet.working" : flow.codeTo ? "settings.recoverySheet.finish" : "settings.recoverySheet.continue")}</button>
      <button class="settings-text-action" type="button" disabled={busy} onClick={close}>{t("common.cancel")}</button>
    </div>
  </form>;

  const sheet = status.sheet;
  if (!sheet) return <section class="settings-form recovery-sheet">
    <h1>{t("settings.recoverySheet.title")}</h1>
    <p class="settings-intro">{t("settings.recoverySheet.intro")}</p>
    <p>{operator ? t("settings.recoverySheet.introMove", { operator }) : t("settings.recoverySheet.introMoveDefault")}</p>
    <p>{t("settings.recoverySheet.introUndo")}</p>
    <p class="settings-muted">{t("settings.recoverySheet.time")}</p>
    <button class="ibtn" type="button" disabled={!connected} onClick={() => dispatch({ type: "start", replacing: false })}>{t("settings.recoverySheet.make")}</button>
  </section>;

  return <section class="settings-form recovery-sheet">
    <h1>{t("settings.recoverySheet.readyTitle")}</h1>
    <p><span class="settings-muted">{t("settings.recoverySheet.sheetCode")}</span> <strong class="recovery-sheet-code">{sheet.code}</strong>{sheet.madeAt !== null && <span class="settings-muted"> · {t("settings.recoverySheet.madeOn", { date: longDate(sheet.madeAt) })}</span>}</p>
    {sheet.pending && <p class="settings-muted" role="status">{t("settings.recoverySheet.pending")}</p>}
    <p>{t("settings.recoverySheet.codeSafe")}</p>
    <p class="settings-muted">{t("settings.recoverySheet.emailed")}</p>
    {confirming === "replace" && <div class="recovery-sheet-confirm" role="group" aria-label={t("settings.recoverySheet.replaceTitle")}>
      <h2>{t("settings.recoverySheet.replaceTitle")}</h2>
      <p>{t("settings.recoverySheet.replaceBody")}</p>
      <div class="settings-actions">
        <button class="ibtn" type="button" onClick={() => { setConfirming(null); dispatch({ type: "start", replacing: true }); }}>{t("settings.recoverySheet.replace")}</button>
        <button class="settings-text-action" type="button" onClick={() => setConfirming(null)}>{t("common.cancel")}</button>
      </div>
    </div>}
    {confirming === "remove" && <div class="recovery-sheet-confirm" role="group" aria-label={t("settings.recoverySheet.removeTitle")}>
      <h2>{t("settings.recoverySheet.removeTitle")}</h2>
      <p>{operator ? t("settings.recoverySheet.removeBody", { operator }) : t("settings.recoverySheet.removeBodyDefault")}</p>
      <div class="settings-actions">
        <button class="ibtn" type="button" onClick={() => { setConfirming(null); dispatch({ type: "remove" }); }}>{t("settings.recoverySheet.remove")}</button>
        <button class="settings-text-action" type="button" onClick={() => setConfirming(null)}>{t("settings.recoverySheet.keep")}</button>
      </div>
    </div>}
    {confirming === null && <div class="settings-actions">
      <button class="ibtn" type="button" disabled={!connected} onClick={() => setConfirming("replace")}>{t("settings.recoverySheet.replace")}</button>
      <button class="settings-text-action" type="button" disabled={!connected} onClick={() => setConfirming("remove")}>{t("settings.recoverySheet.remove")}</button>
    </div>}
  </section>;
}

/** The sheet as it prints: who it belongs to, its words, its QR code and what it's for. */
function SheetPaper({ draft, identity, t }: { draft: RecoverySheetDraft; identity: Ready["identity"]; t: Translate }) {
  return <article class="recovery-sheet-paper" aria-label={t("settings.recoverySheet.title")}>
    <h2>{t("settings.recoverySheet.title")}</h2>
    <p class="recovery-sheet-identity">@{identity.handle}<br />{identity.did}</p>
    <p>{t("settings.recoverySheet.paperMade", { code: draft.code, date: longDate(Date.now()) })}</p>
    <p>{t("settings.recoverySheet.paperWarning")}</p>
    <ol class="recovery-sheet-words">{draft.words.map((word, index) => <li key={index}><span>{index + 1}</span>{word}</li>)}</ol>
    <div class="recovery-sheet-qr">
      <QrCode modules={draft.qr} label={t("settings.recoverySheet.paperQr")} />
      <small>{t("settings.recoverySheet.paperQr")}</small>
    </div>
    <p class="recovery-sheet-use">{t("settings.recoverySheet.paperUse", { guide: SHEET_GUIDE })}</p>
  </article>;
}

/** Draws the QR code's modules, with the quiet zone readers need around them. */
function QrCode({ modules, label }: { modules: boolean[][]; label: string }) {
  const size = modules.length + 8;
  const path = modules.flatMap((row, y) => row.map((on, x) => on ? `M${x + 4} ${y + 4}h1v1h-1z` : "")).join("");
  return <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}><rect width={size} height={size} fill="#fff" /><path d={path} fill="#000" /></svg>;
}

/** Prints only the sheet, from the page in memory; nothing is fetched or stored. */
function printSheet(): void {
  document.body.classList.add("recovery-sheet-printing");
  const after = () => { document.body.classList.remove("recovery-sheet-printing"); window.removeEventListener("afterprint", after); };
  window.addEventListener("afterprint", after);
  window.print();
}

function refusalText(t: Translate, refusal: RecoverySheetRefusal): string {
  switch (refusal.reason) {
    case "password": return t("settings.recoverySheet.refused.password");
    case "attempts": return t("settings.recoverySheet.refused.attempts", { time: clockTime(refusal.retryAt) });
    case "code": return t("settings.recoverySheet.refused.code", { count: refusal.attemptsLeft });
    case "code-expired": return t("settings.recoverySheet.refused.codeExpired");
    case "wait": return t("settings.recoverySheet.refused.wait", { time: clockTime(refusal.retryAt) });
    case "no-address": return t("settings.recoverySheet.refused.noAddress");
  }
}

function longDate(at: number): string {
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { day: "numeric", month: "long", year: "numeric" }).format(at);
}

function clockTime(at: number): string {
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { hour: "2-digit", minute: "2-digit" }).format(at);
}
