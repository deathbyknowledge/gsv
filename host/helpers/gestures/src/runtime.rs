use std::collections::HashSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, BufReader, Read};
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

const RUNTIME_SCHEMA: u16 = 1;
const MEDIAPIPE_VERSION: &str = "1.0.0";
const MEDIAPIPE_COMMIT: &str = "6d31f1ebc3284db74d211d62bdc4f0a0c29ea120";
const MODEL_PATH: &str = "model/gesture_recognizer.task";
const MODEL_BYTES: u64 = 8_373_440;
const MODEL_SHA256: &str = "97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_RUNTIME_FILES: usize = 32;
const REQUIRED_SYMBOLS: [&str; 7] = [
    "MpErrorFree",
    "MpGestureRecognizerClose",
    "MpGestureRecognizerCloseResult",
    "MpGestureRecognizerCreate",
    "MpGestureRecognizerRecognizeForVideo",
    "MpImageCreateFromUint8Data",
    "MpImageFree",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Error {
    AssetsUnavailable,
    InvalidRuntime,
    InvalidRuntimeOverride,
    InvalidLibraryOverride,
    InvalidModelOverride,
    InvalidModel,
}

pub(crate) struct AssetPaths {
    pub(crate) library: PathBuf,
    pub(crate) model: PathBuf,
}

#[derive(Clone, Copy)]
struct RuntimeContract {
    platform: &'static str,
    library_name: &'static str,
    model_bytes: u64,
    model_sha256: &'static str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeManifest {
    schema: u16,
    platform: String,
    mediapipe_version: String,
    mediapipe_commit: String,
    abi_version: u16,
    library: String,
    required_symbols: Vec<String>,
    model: ModelManifest,
    files: Vec<FileManifest>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelManifest {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileManifest {
    path: String,
    bytes: u64,
    sha256: String,
}

pub(crate) fn resolve_assets(
    runtime_override: Option<OsString>,
    library_override: Option<OsString>,
    model_override: Option<OsString>,
    current_executable: Option<PathBuf>,
    manifest_dir: &Path,
) -> Result<AssetPaths, Error> {
    let contract = runtime_contract().ok_or(Error::AssetsUnavailable)?;
    if runtime_override.is_none() {
        if let (Some(library), Some(model)) =
            (library_override.as_deref(), model_override.as_deref())
        {
            return resolve_developer_overrides(library, model, contract);
        }
    }
    let explicit_runtime = runtime_override.is_some();
    let root = if let Some(explicit) = runtime_override {
        let root = PathBuf::from(explicit);
        is_directory(&root)
            .then_some(root)
            .ok_or(Error::InvalidRuntimeOverride)?
    } else {
        runtime_candidates(current_executable, manifest_dir)
            .into_iter()
            .find(|candidate| is_regular_file(&candidate.join("runtime.json")))
            .ok_or(Error::AssetsUnavailable)?
    };
    let mut assets = verify_runtime(&root, contract).map_err(|_| {
        if explicit_runtime {
            Error::InvalidRuntimeOverride
        } else {
            Error::InvalidRuntime
        }
    })?;

    if let Some(explicit) = library_override {
        let path = PathBuf::from(explicit);
        if !is_regular_file(&path) {
            return Err(Error::InvalidLibraryOverride);
        }
        assets.library = path;
    }
    if let Some(explicit) = model_override {
        let path = PathBuf::from(explicit);
        if !is_regular_file(&path) {
            return Err(Error::InvalidModelOverride);
        }
        verify_model(&path, contract).map_err(|_| Error::InvalidModel)?;
        assets.model = path;
    }
    Ok(assets)
}

fn resolve_developer_overrides(
    library: &OsStr,
    model: &OsStr,
    contract: RuntimeContract,
) -> Result<AssetPaths, Error> {
    let library = PathBuf::from(library);
    if !is_regular_file(&library) {
        return Err(Error::InvalidLibraryOverride);
    }
    let model = PathBuf::from(model);
    if !is_regular_file(&model) {
        return Err(Error::InvalidModelOverride);
    }
    verify_model(&model, contract).map_err(|_| Error::InvalidModel)?;
    Ok(AssetPaths { library, model })
}

fn runtime_contract() -> Option<RuntimeContract> {
    let (platform, library_name) = match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => ("linux-x86_64", "libgesture_recognizer.so"),
        ("macos", "aarch64") => ("macos-aarch64", "libgesture_recognizer.dylib"),
        _ => return None,
    };
    Some(RuntimeContract {
        platform,
        library_name,
        model_bytes: MODEL_BYTES,
        model_sha256: MODEL_SHA256,
    })
}

fn runtime_candidates(current_executable: Option<PathBuf>, manifest_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(parent) = current_executable.as_deref().and_then(Path::parent) {
        candidates.push(parent.join("vision-runtime"));
    }
    if let Some(workspace_root) = manifest_dir.ancestors().nth(2) {
        if let Some(artifact_name) = development_artifact_name() {
            candidates.push(
                workspace_root
                    .join("target/vision-mediapipe/artifact")
                    .join(artifact_name),
            );
        }
    }
    candidates
}

fn development_artifact_name() -> Option<&'static str> {
    match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x86_64-mediapipe-1.0.0"),
        ("macos", "aarch64") => Some("macos-aarch64-mediapipe-1.0.0"),
        _ => None,
    }
}

fn verify_runtime(root: &Path, contract: RuntimeContract) -> Result<AssetPaths, ()> {
    if !is_directory(root) {
        return Err(());
    }
    let manifest_path = root.join("runtime.json");
    let manifest_metadata = fs::symlink_metadata(&manifest_path).map_err(|_| ())?;
    if !manifest_metadata.file_type().is_file() || manifest_metadata.len() > MAX_MANIFEST_BYTES {
        return Err(());
    }
    let manifest_bytes = fs::read(&manifest_path).map_err(|_| ())?;
    let manifest: RuntimeManifest = serde_json::from_slice(&manifest_bytes).map_err(|_| ())?;
    let expected_library = format!("lib/{}", contract.library_name);
    if manifest.schema != RUNTIME_SCHEMA
        || manifest.platform != contract.platform
        || manifest.mediapipe_version != MEDIAPIPE_VERSION
        || manifest.mediapipe_commit != MEDIAPIPE_COMMIT
        || manifest.abi_version != 1
        || manifest.library != expected_library
        || manifest.model.path != MODEL_PATH
        || manifest.model.bytes != contract.model_bytes
        || manifest.model.sha256 != contract.model_sha256
        || manifest.files.len() < 2
        || manifest.files.len() > MAX_RUNTIME_FILES
        || !manifest
            .required_symbols
            .iter()
            .map(String::as_str)
            .eq(REQUIRED_SYMBOLS)
    {
        return Err(());
    }

    let mut paths = HashSet::with_capacity(manifest.files.len());
    let mut library_entry = None;
    let mut model_entry = None;
    for file in &manifest.files {
        let relative = validated_relative_path(&file.path).ok_or(())?;
        if !is_sha256(&file.sha256) || !paths.insert(file.path.as_str()) {
            return Err(());
        }
        let path = verified_runtime_file(root, relative).ok_or(())?;
        verify_file(&path, file.bytes, &file.sha256)?;
        if file.path == manifest.library {
            library_entry = Some(path.clone());
        }
        if file.path == manifest.model.path {
            if file.bytes != manifest.model.bytes || file.sha256 != manifest.model.sha256 {
                return Err(());
            }
            model_entry = Some(path);
        }
    }

    Ok(AssetPaths {
        library: library_entry.ok_or(())?,
        model: model_entry.ok_or(())?,
    })
}

fn validated_relative_path(value: &str) -> Option<&Path> {
    if value.is_empty() || value.contains('\\') {
        return None;
    }
    let path = Path::new(value);
    (!path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_))))
    .then_some(path)
}

fn verified_runtime_file(root: &Path, relative: &Path) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(Component::Normal(component)) = components.next() {
        path.push(component);
        let metadata = fs::symlink_metadata(&path).ok()?;
        if components.peek().is_some() {
            if !metadata.file_type().is_dir() {
                return None;
            }
        } else if !metadata.file_type().is_file() {
            return None;
        }
    }
    Some(path)
}

fn verify_model(path: &Path, contract: RuntimeContract) -> io::Result<()> {
    verify_file(path, contract.model_bytes, contract.model_sha256)
        .map_err(|()| io::Error::other("model verification failed"))
}

fn verify_file(path: &Path, expected_bytes: u64, expected_sha256: &str) -> Result<(), ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.file_type().is_file() || metadata.len() != expected_bytes {
        return Err(());
    }
    let file = File::open(path).map_err(|_| ())?;
    let actual = digest_hex(BufReader::new(file)).map_err(|_| ())?;
    (actual == expected_sha256).then_some(()).ok_or(())
}

fn is_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest_hex(mut input: impl Read) -> io::Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Cursor;

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    const TEST_MODEL: &[u8] = b"test-model";

    fn test_contract() -> RuntimeContract {
        RuntimeContract {
            platform: "test-platform",
            library_name: "libgesture_recognizer.test",
            model_bytes: TEST_MODEL.len() as u64,
            model_sha256: "61f401bc2506c75bd117f8cca1e6ccac192632cb3019e57dbe43eb5e1b69c0a1",
        }
    }

    fn create_runtime() -> (tempfile::TempDir, PathBuf) {
        let directory = tempdir().expect("runtime directory");
        let root = directory.path().join("vision-runtime");
        fs::create_dir_all(root.join("lib")).expect("library directory");
        fs::create_dir_all(root.join("model")).expect("model directory");
        fs::write(root.join("lib/libgesture_recognizer.test"), b"library")
            .expect("gesture library");
        fs::write(root.join("lib/dependency.test"), b"dependency").expect("dependency");
        fs::write(root.join(MODEL_PATH), TEST_MODEL).expect("model");
        let required_symbols = REQUIRED_SYMBOLS;
        let manifest = json!({
            "schema": RUNTIME_SCHEMA,
            "platform": "test-platform",
            "mediapipe_version": MEDIAPIPE_VERSION,
            "mediapipe_commit": MEDIAPIPE_COMMIT,
            "abi_version": 1,
            "library": "lib/libgesture_recognizer.test",
            "required_symbols": required_symbols,
            "model": {
                "path": MODEL_PATH,
                "bytes": TEST_MODEL.len(),
                "sha256": test_contract().model_sha256,
            },
            "files": [
                {
                    "path": "lib/libgesture_recognizer.test",
                    "bytes": 7,
                    "sha256": "b718f1354f7247312eca086d9a024afe5fa717ddea5adeddd6f12bcf945b2e8c",
                },
                {
                    "path": "lib/dependency.test",
                    "bytes": 10,
                    "sha256": "f26350dafe3f19aabfd69ac463fb5daf76015c9a2763e76e2ad32fc0fcfedf31",
                },
                {
                    "path": MODEL_PATH,
                    "bytes": TEST_MODEL.len(),
                    "sha256": test_contract().model_sha256,
                }
            ]
        });
        fs::write(
            root.join("runtime.json"),
            serde_json::to_vec_pretty(&manifest).expect("manifest JSON"),
        )
        .expect("runtime manifest");
        (directory, root)
    }

    #[test]
    fn digest_is_streamed_and_stable() {
        assert_eq!(
            digest_hex(Cursor::new(b"abc")).expect("hash input"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verified_runtime_resolves_the_pinned_library_and_model() {
        let (_directory, root) = create_runtime();
        let assets = verify_runtime(&root, test_contract()).expect("verified runtime");
        assert_eq!(assets.library, root.join("lib/libgesture_recognizer.test"));
        assert_eq!(assets.model, root.join(MODEL_PATH));
    }

    #[test]
    fn any_tampered_runtime_dependency_fails_closed() {
        let (_directory, root) = create_runtime();
        fs::write(root.join("lib/dependency.test"), b"replacement").expect("tamper dependency");
        assert!(verify_runtime(&root, test_contract()).is_err());
    }

    #[test]
    fn paired_developer_overrides_do_not_require_an_installed_runtime() {
        let directory = tempdir().expect("override directory");
        let library = directory.path().join("library");
        let model = directory.path().join("model");
        fs::write(&library, b"library").expect("library override");
        fs::write(&model, TEST_MODEL).expect("model override");
        let assets =
            resolve_developer_overrides(library.as_os_str(), model.as_os_str(), test_contract())
                .expect("developer overrides");
        assert_eq!(assets.library, library);
        assert_eq!(assets.model, model);
    }

    #[test]
    fn manifest_paths_cannot_escape_the_runtime() {
        assert!(validated_relative_path("../library").is_none());
        assert!(validated_relative_path("/library").is_none());
        assert!(validated_relative_path("lib\\library").is_none());
        assert_eq!(
            validated_relative_path("lib/library"),
            Some(Path::new("lib/library"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn runtime_files_cannot_escape_through_a_symlinked_directory() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().expect("runtime directory");
        let root = directory.path().join("runtime");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&root).expect("runtime root");
        fs::create_dir_all(&outside).expect("outside directory");
        fs::write(outside.join("library"), b"library").expect("outside library");
        symlink(&outside, root.join("lib")).expect("symlinked library directory");
        assert!(verified_runtime_file(&root, Path::new("lib/library")).is_none());
    }

    #[test]
    fn known_development_artifact_is_architecture_specific() {
        assert_eq!(
            development_artifact_name().is_some(),
            matches!(
                (env::consts::OS, env::consts::ARCH),
                ("linux", "x86_64") | ("macos", "aarch64")
            )
        );
    }
}
