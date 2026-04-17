export type ProcessEntry = {
  pid: string;
  label?: string | null;
  state?: string | null;
  profile?: string | null;
  uid?: number | string | null;
  parentPid?: string | number | null;
  workspaceId?: string | null;
  cwd?: string | null;
  createdAt?: number | string | null;
};

export type ProcessesState = {
  processes: ProcessEntry[];
  errorText: string;
};

export type ProcessesRoute = {
  q: string;
};

export type KillProcessArgs = {
  pid: string;
};

export type KillProcessResult = {
  ok: boolean;
  errorText: string;
};

export interface ProcessesBackend {
  loadState(): Promise<ProcessesState>;
  killProcess(args: KillProcessArgs): Promise<KillProcessResult>;
}
