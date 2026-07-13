declare const __GSV_RELEASE__: string;

export const SERVER_VERSION = "0.4.0";
export const SERVER_RELEASE = typeof __GSV_RELEASE__ === "string" ? __GSV_RELEASE__ : "dev";
