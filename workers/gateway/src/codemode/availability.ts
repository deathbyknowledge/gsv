export type CodeModeEnvironment = {
  LOADER?: WorkerLoader;
};

export const CODE_MODE_UNAVAILABLE_ERROR =
  "CodeMode is unavailable on this deployment. Redeploy on a Workers Paid account with --codemode auto or --codemode on.";

export function isCodeModeAvailable(env: CodeModeEnvironment): boolean {
  return env.LOADER !== undefined;
}
