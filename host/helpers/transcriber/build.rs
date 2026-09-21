use std::error::Error;
use std::path::PathBuf;
use std::process::Command;

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS")? != "macos" {
        return Ok(());
    }
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=SDKROOT");

    // Metal's Objective-C availability checks call __isPlatformVersionAtLeast.
    // Rust links with -nodefaultlibs, so include the selected Xcode runtime
    // explicitly instead of relying on Clang's implicit native link libraries.
    let output = Command::new("xcrun")
        .args(["--sdk", "macosx", "clang", "--print-resource-dir"])
        .output()
        .map_err(|error| format!("locate the Apple compiler runtime: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "locate the Apple compiler runtime: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let directory = PathBuf::from(String::from_utf8(output.stdout)?.trim()).join("lib/darwin");
    if !directory.join("libclang_rt.osx.a").is_file() {
        let message = format!("Apple compiler runtime is missing from {}", directory.display());
        return Err(message.into());
    }
    println!("cargo:rustc-link-search=native={}", directory.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
    Ok(())
}
