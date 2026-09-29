//! Release naming shared by the host applications: the `x.y.z` version every
//! binary carries, the immutable `vX.Y.Z` tag a stable release publishes, and
//! the moving `dev` tag.

use std::fmt::{self, Display, Formatter};

/// The moving prerelease tag that always tracks the latest commit on `main`.
pub const DEV_RELEASE_TAG: &str = "dev";

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ReleaseVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Display for ReleaseVersion {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Parse `x.y.z`, with or without the `v` tag prefix. Anything else is not a
/// release this tooling publishes.
pub fn parse_version(text: &str) -> Option<ReleaseVersion> {
    let text = text.trim();
    let text = text.strip_prefix('v').unwrap_or(text);
    let mut parts = text.split('.').map(|part| {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            None
        } else {
            part.parse::<u64>().ok()
        }
    });
    let version = ReleaseVersion {
        major: parts.next()??,
        minor: parts.next()??,
        patch: parts.next()??,
    };
    if parts.next().is_some() {
        return None;
    }
    Some(version)
}

/// The immutable release tag for a stable version.
pub fn stable_tag(version: ReleaseVersion) -> String {
    format!("v{version}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions_with_and_without_the_tag_prefix() {
        let parsed = parse_version("v0.4.1").expect("tag parses");
        assert_eq!(parsed, parse_version("0.4.1").expect("version parses"));
        assert_eq!(parsed.to_string(), "0.4.1");
        assert_eq!(stable_tag(parsed), "v0.4.1");
        for invalid in ["dev", "0.4", "0.4.1.2", "0.4.x", "", "v", "0.4.1-rc1"] {
            assert_eq!(parse_version(invalid), None, "{invalid:?}");
        }
    }

    #[test]
    fn orders_numerically_not_lexically() {
        let older = parse_version("0.9.9").expect("older parses");
        let newer = parse_version("0.10.0").expect("newer parses");
        assert!(older < newer);
    }
}
