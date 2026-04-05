export type HostStatus = {
  connected: boolean;
};

export type HostSignalHandler = (signal: string, payload: unknown) => void;
export type HostStatusHandler = (status: HostStatus) => void;

export type HostClient = {
  getStatus(): HostStatus;
  onSignal(listener: HostSignalHandler): () => void;
  onStatus(listener: HostStatusHandler): () => void;
  request<T = unknown>(call: string, args?: unknown): Promise<T>;
  spawnProcess(args: unknown): Promise<unknown>;
  sendMessage(message: string, pid?: string): Promise<unknown>;
  getHistory(limit: number, pid?: string, offset?: number): Promise<unknown>;
};

export async function connectHost(): Promise<HostClient> {
  throw new Error("HOST runtime is not wired in this local package yet");
}
