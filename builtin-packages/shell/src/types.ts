export type FitAddonLike = {
  activate: (terminal: never) => void;
  dispose: () => void;
  fit: () => void;
};

export type TerminalLike = {
  loadAddon: (addon: FitAddonLike) => void;
  open: (element: HTMLElement) => void;
  focus: () => void;
  write: (value: string | Uint8Array) => void;
  reset: () => void;
  onData: (handler: (value: string) => void) => void;
};

export type TerminalOptions = Record<string, unknown>;

export type ShellDevice = {
  deviceId: string;
  label: string;
  online: boolean;
};

export type ShellState = {
  devices: ShellDevice[];
  defaultCwd: string;
};

export type TranscriptEntry = {
  id: string;
  target: string;
  command: string;
  stdout: string;
  stderr: string;
};

export type ShellBackend = {
  loadState(args: Record<string, never>): Promise<ShellState>;
  execCommand(args: {
    input: string;
    target: string;
    cwd?: string;
    timeoutMs?: string;
    yieldMs?: string;
    background?: boolean;
  }): Promise<{ entry: TranscriptEntry }>;
};

export type ShellRoute = {
  target: string | null;
  cwd: string | null;
};
