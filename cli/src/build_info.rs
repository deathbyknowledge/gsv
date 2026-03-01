pub const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const BUILD_VERSION: &str = env!("GSV_BUILD_VERSION");
pub const BUILD_CHANNEL: &str = env!("GSV_BUILD_CHANNEL");
pub const BUILD_SHA: &str = env!("GSV_BUILD_SHA");
pub const BUILD_RUN_NUMBER: &str = env!("GSV_BUILD_RUN_NUMBER");
pub const BUILD_TAG: &str = env!("GSV_BUILD_TAG");
pub const BUILD_TIMESTAMP: &str = env!("GSV_BUILD_TIMESTAMP");

pub fn is_ci_build() -> bool {
    !BUILD_CHANNEL.is_empty() || !BUILD_SHA.is_empty() || !BUILD_RUN_NUMBER.is_empty()
}

pub fn version_display() -> &'static str {
    BUILD_VERSION
}
