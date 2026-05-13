export type RuntimeConfig = {
  dev: boolean;
};

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const response = await fetch("/runtime/config.json", { cache: "no-store" });
    if (!response.ok) {
      return { dev: false };
    }
    const value = await response.json() as Partial<RuntimeConfig>;
    return {
      dev: value.dev === true,
    };
  } catch {
    return { dev: false };
  }
}
