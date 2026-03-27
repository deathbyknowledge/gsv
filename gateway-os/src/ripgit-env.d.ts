declare global {
  interface Env {
    RIPGIT?: {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
    RIPGIT_INTERNAL_KEY?: string;
  }
}

export {};
