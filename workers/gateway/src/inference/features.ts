export function isWorkersAiProvider(provider: string): boolean {
  return ["workers-ai", "workersai", "cloudflare-workers-ai"].includes(provider.trim().toLowerCase());
}
