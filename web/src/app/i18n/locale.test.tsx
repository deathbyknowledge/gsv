import { act } from "preact/test-utils";
import { useEffect } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../testing/testHarness";
import { en } from "./en";
import { es } from "./es";
import { ptBR } from "./pt-BR";
import { applyLanguagePreference, formatMessage, resolveLocale, rich, t, useT } from "./locale";

beforeEach(() => {
  vi.stubGlobal("document", { documentElement: {} });
});

afterEach(async () => {
  await applyLanguagePreference("en");
  vi.unstubAllGlobals();
});

type CatalogMessage = string | Readonly<Record<string, string>>;

function isPlain(message: CatalogMessage): message is string {
  return typeof message === "string";
}

/** A message's texts by plural form; a plain message is its own "other" form. */
function formsOf(message: CatalogMessage): [string, string][] {
  return Object.entries(isPlain(message) ? { other: message } : message);
}

/** The distinct sets of {slot} names across a message's forms. */
function slotSets(message: CatalogMessage): string[] {
  return [...new Set(formsOf(message).map(([, text]) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",")))];
}

describe("interface language", () => {
  it("chooses the preference, then the device's languages, then English", () => {
    expect(resolveLocale("en-XA", ["en-US"]).tag).toBe("en-XA");
    expect(resolveLocale("en-GB", ["en-XA"]).tag).toBe("en");
    expect(resolveLocale("fr", ["EN-xa"]).tag).toBe("en-XA");
    expect(resolveLocale(undefined, ["fr-FR", "de"]).tag).toBe("en");
    expect(resolveLocale("es-MX", ["en-US"]).tag).toBe("es");
    expect(resolveLocale(undefined, ["fr-FR", "es-419", "en"]).tag).toBe("es");
    expect(resolveLocale("pt", ["en-US"]).tag).toBe("pt-BR");
    expect(resolveLocale(undefined, ["pt-PT", "en"]).tag).toBe("pt-BR");
  });

  it("fills slots and chooses plural forms", () => {
    const english = new Intl.PluralRules("en");
    expect(formatMessage("Could not read logs: {error}", english, { error: "timeout" })).toBe("Could not read logs: timeout");
    expect(formatMessage("{known} and {unknown}", english, { known: "this" })).toBe("this and {unknown}");
    const tools = { one: "{count} tool", other: "{count} tools" };
    expect(formatMessage(tools, english, { count: 1 })).toBe("1 tool");
    expect(formatMessage(tools, english, { count: 2 })).toBe("2 tools");
    // Spanish selects "many" for a million; a message without that form answers with "other".
    expect(formatMessage({ one: "{count} herramienta", other: "{count} herramientas" }, new Intl.PluralRules("es"), { count: 1_000_000 }))
      .toBe("1000000 herramientas");
  });

  it.each([["es", es], ["pt-BR", ptBR]] as const)("keeps every English slot in %s and uses its plural forms", (tag, catalog) => {
    const translation = new Map(Object.entries(catalog));
    const pluralForms = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
    for (const [key, english] of Object.entries(en)) {
      const message = translation.get(key);
      if (message === undefined) throw new Error(`${tag} has no message for ${key}`);
      expect(slotSets(message), key).toEqual(slotSets(english));
      for (const [form] of formsOf(message)) expect(pluralForms, `${key} ${form}`).toContain(form);
    }
  });

  it("translates into Spanish", async () => {
    await applyLanguagePreference("es-ES");
    expect(document.documentElement.lang).toBe("es");
    expect(t("settings.mcp.tools", { count: 1 })).toBe("1 herramienta");
    expect(t("settings.mcp.tools", { count: 3 })).toBe("3 herramientas");
    expect(t("settings.logs.failed", { error: "timeout" })).toBe("No se han podido leer los registros: timeout");
  });

  it("keeps the newest choice when an earlier language arrives later", async () => {
    const spanish = applyLanguagePreference("es");
    await applyLanguagePreference("en");
    await spanish;
    expect(t("common.cancel")).toBe("cancel");
    expect(document.documentElement.lang).toBe("en");
  });

  it("places elements into a message", () => {
    const link = <a href="/chat/settings">language</a>;
    expect(rich("Uses your {link}.", { link })).toEqual(["Uses your ", link, "."]);
  });

  it("switches rendered text in place and marks the document", async () => {
    const root = createTestRoot("The interface language probe");
    const rendered: string[] = [];
    let mounts = 0;
    function Probe() {
      const translate = useT();
      useEffect(() => { mounts += 1; }, []);
      rendered.push(translate("common.cancel"));
      return null;
    }
    try {
      await root.render(<Probe />);
      expect(rendered.at(-1)).toBe("cancel");
      await act(() => applyLanguagePreference("en-XA"));
      expect(rendered.at(-1)).toBe("[çáñçél··]");
      expect(mounts).toBe(1);
      expect(document.documentElement.lang).toBe("en-XA");
      expect(document.documentElement.dir).toBe("ltr");
      expect(t("settings.logs.failed", { error: "timeout" })).toMatch(/^\[Çóúld ñót réád lógš: timeout·+\]$/);
      expect(t("settings.mcp.tools", { count: 1 })).toMatch(/^\[1 tóól·+\]$/);
      expect(t("settings.mcp.tools", { count: 2 })).toMatch(/^\[2 tóólš·+\]$/);
    } finally {
      await root.unmount();
    }
  });
});
