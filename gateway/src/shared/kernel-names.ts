import { canonicalizeLoginUsername } from "../auth/login";

export const SHIP_KERNEL_NAME = "singleton";
export const USER_KERNEL_LOGIN_SOURCE_HEADER = "x-gsv-login-source-scope";
export const USER_KERNEL_GENERATION_HEADER = "x-gsv-kernel-generation";
export const USER_KERNEL_NAME_PREFIX = "user:";

export function userKernelName(username: string): string {
  const canonical = canonicalizeLoginUsername(username);
  if (!canonical) {
    throw new Error("Invalid canonical username");
  }
  return `${USER_KERNEL_NAME_PREFIX}${canonical}`;
}

export function userKernelUsername(kernelName: string): string | null {
  if (!kernelName.startsWith(USER_KERNEL_NAME_PREFIX)) {
    return null;
  }
  const username = kernelName.slice(USER_KERNEL_NAME_PREFIX.length);
  const canonical = canonicalizeLoginUsername(username);
  return canonical === username ? canonical : null;
}

export function isMasterKernelName(kernelName: string): boolean {
  return kernelName === SHIP_KERNEL_NAME;
}

export function matchUserKernelWebSocketPath(pathname: string): string | null {
  const prefix = "/ws/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return canonicalizeLoginUsername(decoded);
}
