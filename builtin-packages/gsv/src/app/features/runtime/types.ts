export type ProcessEntry = {
  pid: string;
  label?: string | null;
  state?: string | null;
  profile?: string | null;
  uid?: number | string | null;
  parentPid?: string | number | null;
  cwd?: string | null;
  createdAt?: number | string | null;
};

export type RuntimeState = {
  processes: ProcessEntry[];
  errorText: string;
};

export type KillRuntimeProcessArgs = {
  pid: string;
};

export type KillRuntimeProcessResult = {
  ok: boolean;
  errorText: string;
};
