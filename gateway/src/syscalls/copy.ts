export type FsCopyEndpoint = {
  target?: string;
  path: string;
};

export type FsCopyArgs = {
  source: FsCopyEndpoint;
  destination: FsCopyEndpoint;
};

export type FsCopyResult =
  | {
      ok: true;
      source: Required<FsCopyEndpoint>;
      destination: Required<FsCopyEndpoint>;
      size: number;
      contentType?: string;
    }
  | { ok: false; error: string };
