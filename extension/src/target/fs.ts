export { BrowserFsDriver } from "@humansandmachines/gsv-browser/fs";
import { BrowserTargetFileSystem as TargetFileSystemCore } from "@humansandmachines/gsv-browser/fs";
import type { TargetFileSystem } from "./types";
import { openFilePersistence } from "./fs-persistence";

export class BrowserTargetFileSystem extends TargetFileSystemCore {
  constructor(runtime: TargetFileSystem) {
    super(runtime, openFilePersistence);
  }
}
