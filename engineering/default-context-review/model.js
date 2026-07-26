(function registerContextReviewModel(globalScope) {
  "use strict";

  const TEXT_ENCODER = new TextEncoder();
  const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

  function todayInTimezone(timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const value = (type, fallback) => parts.find((part) => part.type === type)?.value || fallback;
      return `${value("year", "1970")}-${value("month", "01")}-${value("day", "01")}`;
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function normalizeScenario(snapshot, input) {
    const defaults = snapshot.defaultScenario || {};
    const scenario = { ...defaults, ...(input || {}) };
    const clean = (value, fallback) => {
      const normalized = typeof value === "string" ? value.trim() : "";
      return normalized || fallback;
    };
    const userUsername = clean(scenario.userUsername, "alex");
    const agentUsername = clean(scenario.agentUsername, "friday");
    const timezone = clean(scenario.timezone, "UTC");
    return {
      userUsername,
      agentUsername,
      userHome: `/home/${userUsername}`,
      programHome: `/home/${agentUsername}`,
      programCwd: `/home/${agentUsername}`,
      currentDate: clean(scenario.currentDate, todayInTimezone(timezone)),
      timezone,
      targets: clean(scenario.targets, "- gsv"),
      mcpServers: clean(scenario.mcpServers, "- (none)"),
      firstMessage: typeof scenario.firstMessage === "string" ? scenario.firstMessage : "Hello",
    };
  }

  function templateValues(scenario) {
    return new Map([
      ["current.date", scenario.currentDate],
      ["current.timezone", scenario.timezone],
      ["identity.username", scenario.agentUsername],
      ["identity.home", scenario.programHome],
      ["identity.cwd", scenario.programCwd],
      ["program.username", scenario.agentUsername],
      ["program.home", scenario.programHome],
      ["program.cwd", scenario.programCwd],
      ["owner.username", scenario.userUsername],
      ["owner.home", scenario.userHome],
      ["owner.cwd", scenario.userHome],
      ["user.username", scenario.userUsername],
      ["user.home", scenario.userHome],
      ["user.cwd", scenario.userHome],
      ["targets", scenario.targets],
      ["devices", scenario.targets],
      ["mcpServers", scenario.mcpServers],
    ]);
  }

  function renderTemplate(template, scenario) {
    const values = templateValues(scenario);
    return String(template || "").replace(TEMPLATE_PATTERN, (_match, key) => values.get(key) || "");
  }

  function normalizePromptPath(location) {
    const trimmed = location.trim();
    if (trimmed.startsWith("/") && !trimmed.endsWith("/")) return `${trimmed}/`;
    return trimmed;
  }

  function escapeAttribute(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function defaultBlockState(block) {
    return {
      template: block.template,
      included: block.defaultIncluded !== false,
    };
  }

  function resolvedBlockState(block, states) {
    const state = states?.[block.id];
    return {
      template: typeof state?.template === "string" ? state.template : block.template,
      included: typeof state?.included === "boolean"
        ? state.included
        : block.defaultIncluded !== false,
    };
  }

  function composePrompt(snapshot, states, scenarioInput) {
    const scenario = normalizeScenario(snapshot, scenarioInput);
    const blocksByGroup = new Map();
    for (const group of snapshot.groups) blocksByGroup.set(group.id, []);
    for (const block of snapshot.blocks) {
      if (!blocksByGroup.has(block.group)) blocksByGroup.set(block.group, []);
      blocksByGroup.get(block.group).push(block);
    }

    const parts = [];
    const contributions = [];
    for (const group of snapshot.groups.filter((item) => item.rootTag)) {
      const active = (blocksByGroup.get(group.id) || []).flatMap((block) => {
        const state = resolvedBlockState(block, states);
        const text = renderTemplate(state.template, scenario).trim();
        return state.included && text ? [{ block, text }] : [];
      });
      if (active.length === 0) continue;

      const pieces = [];
      const path = normalizePromptPath(renderTemplate(group.pathTemplate, scenario));
      pieces.push({
        text: `<${group.rootTag} path="${escapeAttribute(path)}">\n`,
        kind: "wrapper",
        groupId: group.id,
      });
      active.forEach(({ block, text }, index) => {
        pieces.push({
          text: `<${block.filename}>\n`,
          kind: "wrapper",
          groupId: group.id,
        });
        pieces.push({ text, kind: "content", groupId: group.id, blockId: block.id });
        pieces.push({
          text: `\n</${block.filename}>${index < active.length - 1 ? "\n\n" : "\n"}`,
          kind: "wrapper",
          groupId: group.id,
        });
        contributions.push({ blockId: block.id, groupId: group.id, text });
      });
      pieces.push({ text: `</${group.rootTag}>`, kind: "wrapper", groupId: group.id });
      parts.push(pieces);
    }

    for (const group of snapshot.groups.filter((item) => !item.rootTag)) {
      for (const block of blocksByGroup.get(group.id) || []) {
        const state = resolvedBlockState(block, states);
        const text = renderTemplate(state.template, scenario).trim();
        if (!state.included || !text) continue;
        parts.push([
          { text: `<${block.tagName}>\n`, kind: "wrapper", groupId: group.id },
          { text, kind: "content", groupId: group.id, blockId: block.id },
          { text: `\n</${block.tagName}>`, kind: "wrapper", groupId: group.id },
        ]);
        contributions.push({ blockId: block.id, groupId: group.id, text });
      }
    }

    const pieces = [];
    parts.forEach((part, index) => {
      if (index > 0) pieces.push({ text: "\n\n", kind: "wrapper", groupId: "wrapper" });
      pieces.push(...part);
    });
    const text = pieces.map((piece) => piece.text).join("");
    const contentCharacters = contributions.reduce((total, item) => total + item.text.length, 0);
    return {
      text,
      pieces,
      contributions,
      characters: text.length,
      bytes: TEXT_ENCODER.encode(text).length,
      estimatedTokens: Math.ceil(text.length / 4),
      wrapperCharacters: text.length - contentCharacters,
      activeBlocks: contributions.length,
      scenario,
    };
  }

  function firstUserMessage(snapshot, scenarioInput) {
    const scenario = normalizeScenario(snapshot, scenarioInput);
    return [
      "[From: GSV Web Desktop]",
      "[Reply destination: automatic to this GSV client.]",
      scenario.firstMessage,
    ].join("\n");
  }

  const api = {
    composePrompt,
    defaultBlockState,
    firstUserMessage,
    normalizeScenario,
    renderTemplate,
    resolvedBlockState,
    todayInTimezone,
  };

  globalScope.GsvContextReviewModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
