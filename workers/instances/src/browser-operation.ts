/** Bounds provider waits without replaying an operation whose outcome is unknown. */
export async function within<T>(work: Promise<T>, timeoutMs: number, operation = "Browser provider operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
