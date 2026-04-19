/**
 * Axios shim for Cloudflare Workers
 * 
 * Baileys uses Axios with responseType: 'stream' which isn't supported in Workers.
 * This shim wraps fetch to provide Axios-compatible interface.
 */

export interface AxiosRequestConfig {
  url?: string;
  method?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: unknown;
  timeout?: number;
  responseType?: 'arraybuffer' | 'json' | 'text' | 'stream';
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface AxiosResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: AxiosRequestConfig;
}

export class AxiosError extends Error {
  config?: AxiosRequestConfig;
  code?: string;
  request?: unknown;
  response?: AxiosResponse;
  isAxiosError = true;

  constructor(message: string, code?: string, config?: AxiosRequestConfig, response?: AxiosResponse) {
    super(message);
    this.name = "AxiosError";
    this.code = code;
    this.config = config;
    this.response = response;
  }

  static from(error: Error, code?: string, config?: AxiosRequestConfig): AxiosError {
    const axiosError = new AxiosError(error.message, code, config);
    axiosError.stack = error.stack;
    return axiosError;
  }
}

async function request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  const url = new URL(config.url || "", config.baseURL);
  
  if (config.params) {
    for (const [key, value] of Object.entries(config.params)) {
      url.searchParams.set(key, value);
    }
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  
  if (config.timeout) {
    timeoutId = setTimeout(() => controller.abort(), config.timeout);
  }

  try {
    const response = await fetch(url.toString(), {
      method: config.method || "GET",
      headers: config.headers,
      body: config.data ? JSON.stringify(config.data) : undefined,
      signal: config.signal || controller.signal,
      redirect: config.maxRedirects === 0 ? "manual" : "follow",
    });

    if (timeoutId) clearTimeout(timeoutId);

    // Convert response based on responseType
    let data: unknown;
    const responseType = config.responseType || "json";
    
    // Workers don't support 'stream' - convert to arraybuffer instead
    if (responseType === "stream") {
      // Return arraybuffer and let Baileys handle it
      // We wrap it in an object that mimics a readable stream
      const buffer = await response.arrayBuffer();
      data = {
        // Mimic Node.js readable stream interface minimally
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(buffer);
        },
        pipe: () => { throw new Error("pipe not supported"); },
        read: () => Buffer.from(buffer),
      };
    } else if (responseType === "arraybuffer") {
      data = await response.arrayBuffer();
    } else if (responseType === "text") {
      data = await response.text();
    } else {
      try {
        data = await response.json();
      } catch {
        data = await response.text();
      }
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    if (!response.ok) {
      throw new AxiosError(
        `Request failed with status ${response.status}`,
        "ERR_BAD_REQUEST",
        config,
        { data, status: response.status, statusText: response.statusText, headers, config }
      );
    }

    return {
      data: data as T,
      status: response.status,
      statusText: response.statusText,
      headers,
      config,
    };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    
    if (error instanceof AxiosError) throw error;
    
    throw AxiosError.from(
      error instanceof Error ? error : new Error(String(error)),
      "ERR_NETWORK",
      config
    );
  }
}

// Axios instance with methods
const axios = {
  request,
  get: <T = unknown>(url: string, config?: AxiosRequestConfig) => 
    request<T>({ ...config, url, method: "GET" }),
  post: <T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    request<T>({ ...config, url, method: "POST", data }),
  put: <T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    request<T>({ ...config, url, method: "PUT", data }),
  delete: <T = unknown>(url: string, config?: AxiosRequestConfig) =>
    request<T>({ ...config, url, method: "DELETE" }),
  head: <T = unknown>(url: string, config?: AxiosRequestConfig) =>
    request<T>({ ...config, url, method: "HEAD" }),
  
  // Create instance (returns same interface for simplicity)
  create: (defaultConfig?: AxiosRequestConfig) => {
    return {
      request: <T = unknown>(config: AxiosRequestConfig) => 
        request<T>({ ...defaultConfig, ...config }),
      get: <T = unknown>(url: string, config?: AxiosRequestConfig) =>
        request<T>({ ...defaultConfig, ...config, url, method: "GET" }),
      post: <T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
        request<T>({ ...defaultConfig, ...config, url, method: "POST", data }),
    };
  },
  
  defaults: {
    headers: {
      common: {},
      get: {},
      post: {},
    },
  },
  
  isAxiosError: (error: unknown): error is AxiosError => {
    return error instanceof AxiosError || (error as AxiosError)?.isAxiosError === true;
  },
  
  AxiosError,
};

export default axios;
export { axios };
