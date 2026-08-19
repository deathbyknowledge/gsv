pub(crate) fn run_version() -> Result<(), Box<dyn std::error::Error>> {
    println!("gsv {}", gsv::build_info::version_display());
    println!("package version: {}", gsv::build_info::PACKAGE_VERSION);
    if gsv::build_info::is_ci_build() {
        if !gsv::build_info::BUILD_CHANNEL.is_empty() {
            println!("channel: {}", gsv::build_info::BUILD_CHANNEL);
        }
        if !gsv::build_info::BUILD_SHA.is_empty() {
            println!("commit: {}", gsv::build_info::BUILD_SHA);
        }
        if !gsv::build_info::BUILD_RUN_NUMBER.is_empty() {
            println!("run: {}", gsv::build_info::BUILD_RUN_NUMBER);
        }
        if !gsv::build_info::BUILD_TAG.is_empty() {
            println!("release tag: {}", gsv::build_info::BUILD_TAG);
        }
    }
    println!("build timestamp: {}", gsv::build_info::BUILD_TIMESTAMP);
    Ok(())
}
