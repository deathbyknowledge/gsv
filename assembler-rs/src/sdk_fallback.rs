pub const GSV_APP_LINK_NAME: &str = "@gsv/app-link";
pub const GSV_PACKAGE_SDK_NAME: &str = "@gsv/package";

pub const GSV_APP_LINK_FALLBACK_FILES: [(&str, &str); 2] = [
    (
        "__gsv_sdk/@gsv/app-link/package.json",
        include_str!("../../shared/app-link/package.json"),
    ),
    (
        "__gsv_sdk/@gsv/app-link/src/index.ts",
        include_str!("../../shared/app-link/src/index.ts"),
    ),
];

pub const GSV_PACKAGE_SDK_FALLBACK_FILES: [(&str, &str); 8] = [
    (
        "__gsv_sdk/@gsv/package/package.json",
        include_str!("../../shared/package/package.json"),
    ),
    (
        "__gsv_sdk/@gsv/package/src/manifest.ts",
        include_str!("../../shared/package/src/manifest.ts"),
    ),
    (
        "__gsv_sdk/@gsv/package/src/context.ts",
        include_str!("../../shared/package/src/context.ts"),
    ),
    (
        "__gsv_sdk/@gsv/package/src/backend.ts",
        include_str!("../../shared/package/src/backend.ts"),
    ),
    (
        "__gsv_sdk/@gsv/package/src/cli.ts",
        include_str!("../../shared/package/src/cli.ts"),
    ),
    (
        "__gsv_sdk/@gsv/package/src/host.ts",
        include_str!("../../shared/package/src/host.ts"),
    ),
    (
        "__gsv_sdk/@gsv/package/src/browser.ts",
        include_str!("../../shared/package/src/browser.ts"),
    ),
    (
        "__gsv_sdk/@gsv/package/src/index.ts",
        include_str!("../../shared/package/src/index.ts"),
    ),
];
