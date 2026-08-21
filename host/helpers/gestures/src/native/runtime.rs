use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const ARTIFACT_NAME: &str = "gesture-recognizer-float16-1";
const MODEL_DIRECTORY: &str = "model";

#[derive(Clone, Debug)]
pub(crate) struct ModelPaths {
    pub(crate) palm_detector: PathBuf,
    pub(crate) landmark_detector: PathBuf,
}

#[derive(Clone, Copy)]
struct ModelContract {
    name: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const MODELS: [ModelContract; 2] = [
    ModelContract {
        name: "hand_detector.tflite",
        bytes: 2_339_878,
        sha256: "60d1bf8d70a80aba35b36290bb2a0e52e784ca2e524937d49ea80e8161a8a384",
    },
    ModelContract {
        name: "hand_landmarks_detector.tflite",
        bytes: 5_478_949,
        sha256: "6acda74af3fbf40e68265c20c7394b2bad81a16a481dcd79ad7a081887c3d6b9",
    },
];

pub(crate) fn resolve_models(
    override_root: Option<OsString>,
    current_executable: Option<PathBuf>,
    manifest_dir: &Path,
) -> Result<ModelPaths, ()> {
    let root = if let Some(root) = override_root {
        PathBuf::from(root)
    } else {
        model_candidates(current_executable, manifest_dir)
            .into_iter()
            .find(|candidate| candidate.is_dir())
            .ok_or(())?
    };
    verify_models(&root)
}

fn model_candidates(current_executable: Option<PathBuf>, manifest_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(parent) = current_executable.as_deref().and_then(Path::parent) {
        if parent.file_name().and_then(|name| name.to_str()) == Some("MacOS") {
            if let Some(contents) = parent
                .parent()
                .filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("Contents"))
            {
                candidates.push(contents.join("Resources/vision-models"));
            }
        }
        candidates.push(parent.join("vision-models"));
    }
    if let Some(host_root) = manifest_dir.ancestors().nth(2) {
        candidates.push(
            host_root
                .join("target/vision-native/artifact")
                .join(ARTIFACT_NAME),
        );
    }
    candidates
}

fn verify_models(root: &Path) -> Result<ModelPaths, ()> {
    let model_root = root.join(MODEL_DIRECTORY);
    let mut verified = Vec::with_capacity(MODELS.len());
    for contract in MODELS {
        let path = model_root.join(contract.name);
        let metadata = fs::symlink_metadata(&path).map_err(|_| ())?;
        if !metadata.file_type().is_file() || metadata.len() != contract.bytes {
            return Err(());
        }
        let file = File::open(&path).map_err(|_| ())?;
        let mut reader = BufReader::new(file);
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = reader.read(&mut buffer).map_err(|_| ())?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
        }
        if format!("{:x}", hash.finalize()) != contract.sha256 {
            return Err(());
        }
        verified.push(path);
    }
    let [palm_detector, landmark_detector] = verified.try_into().map_err(|_| ())?;
    Ok(ModelPaths {
        palm_detector,
        landmark_detector,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_candidate_is_under_host_target() {
        let manifest = Path::new("/repo/host/helpers/gestures");
        assert_eq!(
            model_candidates(None, manifest),
            vec![PathBuf::from(
                "/repo/host/target/vision-native/artifact/gesture-recognizer-float16-1"
            )]
        );
    }

    #[test]
    fn packaged_candidate_is_beside_the_helper() {
        assert_eq!(
            model_candidates(
                Some(PathBuf::from("/app/bin/gsv-vision")),
                Path::new("/ignored")
            )[0],
            PathBuf::from("/app/bin/vision-models")
        );
    }

    #[test]
    fn macos_application_candidate_is_in_resources() {
        assert_eq!(
            model_candidates(
                Some(PathBuf::from(
                    "/Applications/GSV.app/Contents/MacOS/gsv-vision"
                )),
                Path::new("/ignored")
            )[0],
            PathBuf::from("/Applications/GSV.app/Contents/Resources/vision-models")
        );
    }
}
