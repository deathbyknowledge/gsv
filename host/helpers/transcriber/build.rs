use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=build.rs");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS")?;
    stage_runtime(&target_os)?;
    if target_os == "linux" {
        // Ubuntu's static OpenBLAS uses .ctors/.dtors. GNU ld folds them into
        // the startup/shutdown arrays; lld leaves them uncalled, so the first
        // matrix multiplication dereferences an uninitialized dispatch table.
        println!("cargo:rustc-link-arg=-fuse-ld=bfd");
    }
    if target_os != "macos" {
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
        let message = format!(
            "Apple compiler runtime is missing from {}",
            directory.display()
        );
        return Err(message.into());
    }
    println!("cargo:rustc-link-search=native={}", directory.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
    Ok(())
}

fn stage_runtime(target_os: &str) -> Result<(), Box<dyn Error>> {
    let out = PathBuf::from(std::env::var_os("OUT_DIR").ok_or("missing OUT_DIR")?);
    let profile = out
        .ancestors()
        .find(|path| path.file_name().is_some_and(|name| name == "build"))
        .and_then(Path::parent)
        .ok_or("could not locate Cargo's output directory")?;
    let runtime = profile.join("gsv-transcribe-runtime");
    let test_runtime = out.join("gsv-transcribe-runtime");
    for directory in [&runtime, &test_runtime] {
        if directory.exists() {
            std::fs::remove_dir_all(directory)?;
        }
        std::fs::create_dir_all(directory)?;
    }
    for key in [
        "DEP_TRANSCRIBE_CPP_RUNTIME_DIR",
        "DEP_TRANSCRIBE_CPP_MODULE_DIR",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
        let directory =
            PathBuf::from(std::env::var_os(key).ok_or("missing transcription runtime")?);
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry.file_name();
            let filename = name.to_string_lossy();
            if !(filename.ends_with(".dll")
                || filename.ends_with(".dylib")
                || filename.contains(".so"))
                || !entry.path().is_file()
            {
                continue;
            }
            std::fs::copy(entry.path(), runtime.join(&name))?;
            std::fs::copy(entry.path(), test_runtime.join(&name))?;
        }
    }
    if target_os != "windows" {
        let origin = if target_os == "macos" {
            "@loader_path"
        } else {
            "$ORIGIN"
        };
        println!("cargo:rustc-link-arg=-Wl,-rpath,{origin}/gsv-transcribe-runtime");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{origin}/../gsv-transcribe-runtime");
    }
    Ok(())
}
