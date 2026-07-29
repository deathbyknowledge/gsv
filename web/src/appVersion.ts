import pkg from "../package.json";

/** App version, read from package.json at build time. */
export const APP_VERSION: string = pkg.version;
