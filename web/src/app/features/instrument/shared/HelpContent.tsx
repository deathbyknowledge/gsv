import type { JSX } from "preact";
import type { Distance } from "../Instrument";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useT, type TextKey } from "../../../i18n/locale";
import { shortcutLabel } from "../../../services/platform/shortcutKeys";
import { memoryLinkHref } from "../memory/memoryLinks";
import { publicDeployment } from "../../../services/deployment";
import { LINE_ICONS, LineIcon } from "./lineIcons";
import { shellShortcutKeys, type ShellAction } from "./shellKeys";

export const HELP_MANUAL_PAGE = { db: "gsv-manual", path: "gsv-manual/index.md", fragment: "" };

type HelpContentProps = {
  distance: Distance;
  connected: boolean;
  onClose: () => void;
  onSearch: () => void;
  onFeedback?: () => void;
  onNavigate: (href: string) => void;
};

function HelpIcon({ kind }: { kind: "chat" | "phone" | "memory" | "settings" | "privacy" }) {
  return <LineIcon path={LINE_ICONS[kind]} class="instrument-help-icon" />;
}

export function HelpContent({ distance, connected, onClose, onSearch, onFeedback, onNavigate }: HelpContentProps) {
  const t = useT();
  const { privacyUrl } = publicDeployment();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const switchedView = useRef(false);
  const showShortcuts = (open: boolean) => {
    switchedView.current = true;
    setShortcutsOpen(open);
  };
  useLayoutEffect(() => {
    if (!switchedView.current) return;
    const button = shortcutsOpen ? backButton.current : shortcutsButton.current;
    const panel = button?.closest(".instrument-help");
    if (panel) panel.scrollTop = 0;
    button?.focus();
  }, [shortcutsOpen]);
  const platform = globalThis.navigator?.platform ?? "";
  const modifier = /mac/i.test(platform) ? "Meta" : "Ctrl";
  const saveShortcut = shortcutLabel(`${modifier}+Enter`, platform);
  const findShortcut = shortcutLabel(`${modifier}+F`, platform);
  const shell = (action: ShellAction) => shortcutLabel(shellShortcutKeys(action), platform);
  const navigate: JSX.MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(event.currentTarget.getAttribute("href")!);
  };
  const row = (kind: Parameters<typeof HelpIcon>[0]["kind"], title: TextKey, description: TextKey) => <>
    <HelpIcon kind={kind} /><span class="instrument-help-row-copy"><strong>{t(title)}</strong><small>{t(description)}</small></span><span class="instrument-help-chevron" aria-hidden="true">›</span>
  </>;
  return <div class="instrument-help-content" onKeyDown={(event) => {
    if (event.key === " " || event.key === "Enter") event.stopPropagation();
  }}>
    <button type="button" class="instrument-help-close" aria-label={t("shell.help.closePanel")} onClick={onClose}><span aria-hidden="true">×</span></button>
    {shortcutsOpen ? <>
      <button type="button" class="instrument-help-back" ref={backButton} onClick={() => showShortcuts(false)}><span aria-hidden="true">← </span>{t("shell.help.label")}</button>
      <h2>{t("shell.help.shortcuts")}</h2>
      <button type="button" class="instrument-help-search" disabled={!connected} aria-keyshortcuts="Control+K" onClick={onSearch}>
        <span>{t("shell.help.search")}</span><kbd>{shortcutLabel("Ctrl+K", platform)}</kbd>
      </button>
          <h4>{t("shell.help.views")}</h4>
          <p>{t("shell.help.viewsHint")}</p>
          <dl>
            <dt>{shell("zen")}</dt><dd>Chat</dd>
            <dt>{shell("fleet")}</dt><dd>{t("shell.help.work")}</dd>
            <dt>{shell("memory")}</dt><dd>{t("shell.help.memory")}</dd>
            <dt>{shell("people")}</dt><dd>{t("shell.help.people")}</dd>
            <dt>{shell("settings")}</dt><dd>{t("settings.title")}</dd>
            <dt>{shell("theme")}</dt><dd>{t("shell.help.theme")}</dd>
            <dt>{shell("help")}</dt><dd>{t("shell.help.toggle")}</dd>
            <dt>Esc</dt><dd>{t("shell.help.closePanel")}</dd>
          </dl>
          {distance === "zen" && <>
            <h4>{t("shell.help.chatBrowse")}</h4>
            <dl>
              <dt>↓ / ↑</dt><dd>{t("shell.help.nextPrevious")}</dd>
              <dt>Home / End</dt><dd>{t("shell.help.history")}</dd>
              <dt>{t("shell.keys.enter")}</dt><dd>{t("shell.help.activity")}</dd>
              <dt>{findShortcut}</dt><dd>{t("shell.help.conversationSearch")}</dd>
              <dt>{t("shell.help.anyCharacter")}</dt><dd>{t("shell.help.startWriting")}</dd>
            </dl>
            <h4>{t("shell.help.chatInput")}</h4>
            <dl>
              <dt>{t("shell.keys.enter")}</dt><dd>{t("shell.help.send")}</dd>
              <dt>{t("shell.keys.newLine")}</dt><dd>{t("shell.help.newLine")}</dd>
              <dt>Esc</dt><dd>{t("shell.help.returnToBrowse")}</dd>
              <dt>↑</dt><dd>{t("shell.help.recall")}</dd>
              <dt>{t("shell.help.placeSyntax")}</dt><dd>{t("shell.help.chooseTarget")}</dd>
              <dt>{t("shell.help.commandSyntax")}</dt><dd>{t("shell.help.runCommand")}</dd>
            </dl>
          </>}
          {distance === "memory" && <>
            <h4>{t("shell.help.memory")}</h4>
            <dl>
              <dt>j / ↓</dt><dd>{t("shell.help.nextItem")}</dd>
              <dt>k / ↑</dt><dd>{t("shell.help.previousItem")}</dd>
              <dt>{t("shell.keys.spaceOrEnter")}</dt><dd>{t("shell.help.openPage")}</dd>
              <dt>/</dt><dd>{t("shell.help.pageSearch")}</dd>
              <dt>e</dt><dd>{t("shell.help.editPage")}</dd>
              <dt>{saveShortcut}</dt><dd>{t("shell.help.savePage")}</dd>
              <dt>Esc</dt><dd>{t("shell.help.leaveSearch")}</dd>
            </dl>
          </>}
          {distance === "fleet" && <>
            <h4>{t("shell.help.work")}</h4>
            <dl>
              <dt>j / ↓</dt><dd>{t("shell.help.nextRow")}</dd>
              <dt>k / ↑</dt><dd>{t("shell.help.previousRow")}</dd>
              <dt>{t("shell.keys.spaceOrEnter")}</dt><dd>{t("shell.help.openItem")}</dd>
              <dt>Esc</dt><dd>{t("shell.help.closeInspector")}</dd>
              <dt>/</dt><dd>{t("shell.help.commandPrompt")}</dd>
            </dl>
            <h4>{t("shell.help.expandedFile")}</h4>
            <dl>
              <dt>{saveShortcut}</dt><dd>{t("shell.help.saveFile")}</dd>
              <dt>Esc</dt><dd>{t("shell.help.returnToFleet")}</dd>
            </dl>
          </>}
          {distance === "people" && <>
            <h4>{t("shell.help.contactMessages")}</h4>
            <dl>
              <dt>{t("shell.keys.enter")}</dt><dd>{t("shell.help.sendMessage")}</dd>
              <dt>{t("shell.keys.newLine")}</dt><dd>{t("shell.help.newLine")}</dd>
            </dl>
          </>}
          {distance === "settings" && <>
            <h4>{t("settings.title")}</h4>
            <dl>
              <dt>{t("shell.keys.tab")}</dt><dd>{t("shell.help.moveControls")}</dd>
              <dt>{t("shell.keys.enterOrSpace")}</dt><dd>{t("shell.help.activate")}</dd>
            </dl>
          </>}

    </> : <>
    <h2>{t("shell.help.introductionTitle")}</h2>
    <p class="instrument-help-introduction">{t("shell.help.introduction")}</p>
    <h3>{t("shell.help.gettingStarted")}</h3>
    <div class="instrument-help-topics">
      <details class="instrument-help-talking">
        <summary class="instrument-help-row">{row("chat", "shell.help.talking", "shell.help.talkingHint")}</summary>
        <div class="instrument-help-examples">
          <p>{t("shell.help.talkingExplanation")}</p>
          <ul><li>{t("shell.help.examplePlan")}</li><li>{t("shell.help.exampleFind")}</li><li>{t("shell.help.exampleFollowUp")}</li></ul>
        </div>
      </details>
      <a class="instrument-help-row" href="/chat/settings?section=messengers" onClick={navigate}>{row("phone", "shell.help.whatsapp", "shell.help.whatsappHint")}</a>
      <a class="instrument-help-row" href="/memory" onClick={navigate}>{row("memory", "shell.help.memory", "shell.help.memoryHint")}</a>
      <a class="instrument-help-row" href="/chat/settings?section=permissions" onClick={navigate}>{row("settings", "shell.help.permissions", "shell.help.permissionsHint")}</a>
      {privacyUrl && <a class="instrument-help-row" href={privacyUrl} target="_blank" rel="noopener noreferrer">{row("privacy", "shell.help.privacy", "shell.help.privacyHint")}</a>}
    </div>
    <button type="button" class="instrument-help-shortcuts" ref={shortcutsButton} onClick={() => showShortcuts(true)}>
      <span>{t("shell.help.shortcuts")}</span><span aria-hidden="true">›</span>
    </button>
    <footer class="instrument-help-footer">
      <h3>{t("shell.help.supportTitle")}</h3>
      {onFeedback && <button type="button" class="instrument-help-feedback" aria-haspopup="dialog" onClick={onFeedback}>{t("shell.help.feedback")}</button>}
      <a href={memoryLinkHref(HELP_MANUAL_PAGE)} onClick={navigate}>{t("shell.help.manual")}</a>
      <a href="mailto:support@humansandmachin.es">{t("shell.help.support")}</a>
      <a href="https://discord.gg/hy9ExJJFvn" target="_blank" rel="noopener noreferrer">{t("shell.help.discord")}</a>
    </footer>
    </>}
  </div>;
}
