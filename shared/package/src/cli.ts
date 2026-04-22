import type {
  KernelClientLike,
  PackageMetaBinding,
  PackageViewerBinding,
} from "./context";

export type PackageCommandContext = {
  meta: PackageMetaBinding;
  viewer: PackageViewerBinding;
  kernel: KernelClientLike;
  argv: string[];
  stdin: {
    text(): Promise<string>;
  };
  stdout: {
    write(text: string): Promise<void>;
  };
  stderr: {
    write(text: string): Promise<void>;
  };
};

export type PackageCommandHandler = (
  ctx: PackageCommandContext,
) => Promise<void> | void;

export function defineCommand<const T extends PackageCommandHandler>(handler: T): T {
  return handler;
}

export type {
  KernelClientLike,
  PackageMetaBinding,
  PackageViewerBinding,
} from "./context";
