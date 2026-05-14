export type TerminalOptions = Record<string, unknown>;

export type TerminalAddon = {
  activate(terminal: unknown): void;
  dispose(): void;
};

export declare class FitAddon implements TerminalAddon {
  activate(terminal: unknown): void;
  dispose(): void;
  fit(): void;
}

export declare class Terminal {
  constructor(options?: TerminalOptions);
  loadAddon(addon: TerminalAddon): void;
  open(element: HTMLElement): void;
  focus(): void;
  write(value: string | Uint8Array): void;
  reset(): void;
  onData(handler: (value: string) => void): void;
}

export declare function init(): Promise<void>;
