use std::error::Error;
use std::fs;
use std::io::{Error as IoError, ErrorKind};
use std::path::Path;

use sha2::{Digest, Sha256};

struct ModelContract {
    path: &'static str,
    bytes: usize,
    sha256: &'static str,
}

const MODELS: [ModelContract; 2] = [
    ModelContract {
        path: "models/hand_detector.tflite",
        bytes: 2_339_878,
        sha256: "60d1bf8d70a80aba35b36290bb2a0e52e784ca2e524937d49ea80e8161a8a384",
    },
    ModelContract {
        path: "models/hand_landmarks_detector.tflite",
        bytes: 5_478_949,
        sha256: "6acda74af3fbf40e68265c20c7394b2bad81a16a481dcd79ad7a081887c3d6b9",
    },
];

fn main() -> Result<(), Box<dyn Error>> {
    for contract in MODELS {
        println!("cargo:rerun-if-changed={}", contract.path);
        verify_model(&contract)?;
    }
    Ok(())
}

fn verify_model(contract: &ModelContract) -> Result<(), Box<dyn Error>> {
    let bytes = fs::read(Path::new(contract.path)).map_err(|error| {
        IoError::new(
            error.kind(),
            format!(
                "{} is required; restore the vendored gesture models before building: {error}",
                contract.path
            ),
        )
    })?;
    if bytes.len() != contract.bytes {
        return Err(IoError::new(
            ErrorKind::InvalidData,
            format!(
                "{} has {} bytes; expected {}",
                contract.path,
                bytes.len(),
                contract.bytes
            ),
        )
        .into());
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    if sha256 != contract.sha256 {
        return Err(IoError::new(
            ErrorKind::InvalidData,
            format!("{} failed checksum verification", contract.path),
        )
        .into());
    }
    Ok(())
}
