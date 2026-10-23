import type { JSX } from "preact";
import type { Distance } from "../Instrument";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useT, type TextKey } from "../../../i18n/locale";
import { shortcutLabel } from "../../../services/platform/shortcutKeys";
import { memoryLinkHref } from "../memory/memoryLinks";

export const HELP_MANUAL_PAGE = { db: "gsv-manual", path: "gsv-manual/index.md", fragment: "" };

type HelpContentProps = {
  distance: Distance;
  connected: boolean;
  onSearch: () => void;
  onNavigate: (href: string) => void;
};

function HelpIcon({ kind }: { kind: "talk" | "phone" | "memory" | "permissions" | "privacy" }) {
  const paths = {
    talk: "M3 3h14v10H8l-5 4V3Z",
    phone: "M6 2h8v16H6V2Zm3 13h2",
    memory: "M3 3h6l1 2 1-2h6v14h-6l-1 1-1-1H3V3Zm7 2v13",
    permissions: "M3 5h14M3 15h14M7 2v6M13 12v6",
    privacy: "M4 9h12v9H4V9Zm2 0V6a4 4 0 0 1 8 0v3",
  };
  return <svg class="instrument-help-icon" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

export function HelpContent({ distance, connected, onSearch, onNavigate }: HelpContentProps) {
  const t = useT();
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
    {shortcutsOpen ? <>
      <button type="button" class="instrument-help-back" ref={backButton} onClick={() => showShortcuts(false)}><span aria-hidden="true">← </span>{t("shell.help.label")}</button>
      <h2>{t("shell.help.shortcuts")}</h2>
      <button type="button" class="instrument-help-search" disabled={!connected} aria-keyshortcuts="Control+K" onClick={onSearch}>
        <span>{t("shell.help.search")}</span><kbd>{shortcutLabel("Ctrl+K", platform)}</kbd>
      </button>
          <h4>{t("shell.help.views")}</h4>
          <p>{t("shell.help.viewsHint")}</p>
          <dl>
            <dt>c</dt><dd>Chat</dd>
            <dt>w</dt><dd>{t("shell.help.work")}</dd>
            <dt>m</dt><dd>{t("shell.help.memory")}</dd>
            <dt>p</dt><dd>{t("shell.help.people")}</dd>
            <dt>s</dt><dd>{t("settings.title")}</dd>
            <dt>l</dt><dd>{t("shell.help.theme")}</dd>
            <dt>x</dt><dd>{t("shell.help.textSize")}</dd>
            <dt>?</dt><dd>{t("shell.help.toggle")}</dd>
            <dt>Esc</dt><dd>{t("shell.help.closePanel")}</dd>
          </dl>
          {distance === "zen" && <>
            <h4>{t("shell.help.chatBrowse")}</h4>
            <dl>
              <dt>j / k</dt><dd>{t("shell.help.nextPrevious")}</dd>
              <dt>gg / G</dt><dd>{t("shell.help.history")}</dd>
              <dt>o</dt><dd>{t("shell.help.activity")}</dd>
              <dt>/</dt><dd>{t("shell.help.browseSearch", { shortcut: findShortcut })}</dd>
              <dt>y / n</dt><dd>{t("shell.help.approve")}</dd>
              <dt>{t("shell.help.otherKeys")}</dt><dd>{t("shell.help.startWriting")}</dd>
            </dl>
            <h4>{t("shell.help.chatInput")}</h4>
            <dl>
              <dt>{t("shell.keys.enter")}</dt><dd>{t("shell.help.send")}</dd>
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
        <summary class="instrument-help-row">{row("talk", "shell.help.talking", "shell.help.talkingHint")}</summary>
        <div class="instrument-help-examples">
          <p>{t("shell.help.talkingExplanation")}</p>
          <ul><li>{t("shell.help.examplePlan")}</li><li>{t("shell.help.exampleFind")}</li><li>{t("shell.help.exampleFollowUp")}</li></ul>
        </div>
      </details>
      <a class="instrument-help-row" href="/chat/settings?section=messengers" onClick={navigate}>{row("phone", "shell.help.whatsapp", "shell.help.whatsappHint")}</a>
      <a class="instrument-help-row" href="/memory" onClick={navigate}>{row("memory", "shell.help.memory", "shell.help.memoryHint")}</a>
      <a class="instrument-help-row" href="/chat/settings?section=permissions" onClick={navigate}>{row("permissions", "shell.help.permissions", "shell.help.permissionsHint")}</a>
      <a class="instrument-help-row" href="https://ship.space/privacy" target="_blank" rel="noopener noreferrer">{row("privacy", "shell.help.privacy", "shell.help.privacyHint")}</a>
    </div>
    <button type="button" class="instrument-help-shortcuts" ref={shortcutsButton} onClick={() => showShortcuts(true)}>
      <span>{t("shell.help.shortcuts")}</span><span aria-hidden="true">›</span>
    </button>
    <footer class="instrument-help-footer">
      <h3>{t("shell.help.supportTitle")}</h3>
      <a href={memoryLinkHref(HELP_MANUAL_PAGE)} onClick={navigate}>{t("shell.help.manual")}</a>
      <a href="mailto:hello@humansandmachin.es">{t("shell.help.support")}</a>
      <a href="https://discord.gg/hy9ExJJFvn" target="_blank" rel="noopener noreferrer">{t("shell.help.discord")}</a>
    </footer>
    </>}
  </div>;
}
