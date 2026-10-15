//! Installer selection and manual commands shared by the host applications.

use std::path::Path;

pub const DEFAULT_INSTALLER_URL: &str = "https://install.ship.space";

pub fn installer_script_url(base_url: &str, windows: bool) -> Result<String, String> {
    let mut url =
        url::Url::parse(base_url).map_err(|error| format!("invalid installer URL: {error}"))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("installer URL must use HTTPS without credentials".to_string());
    }
    if windows {
        let path = url.path().trim_end_matches('/');
        let directory = if path.ends_with(".sh") || path.ends_with(".ps1") {
            path.rsplit_once('/').map_or("", |(directory, _)| directory)
        } else {
            path
        };
        let script_path = format!("{directory}/install.ps1");
        url.set_path(&script_path);
    }
    Ok(url.into())
}

pub fn install_command(
    installer_url: &str,
    release: &str,
    install_dir: Option<&Path>,
    windows: bool,
) -> Result<String, String> {
    let url = shell_quote(&installer_script_url(installer_url, windows)?, windows);
    let release = shell_quote(release, windows);
    let directory = install_dir.map(|dir| shell_quote(&dir.to_string_lossy(), windows));
    if windows {
        let destination = directory
            .map(|dir| format!("$env:GSV_INSTALL_DIR={dir}; "))
            .unwrap_or_default();
        Ok(format!(
            "$env:GSV_VERSION={release}; {destination}irm {url} | iex"
        ))
    } else {
        let destination = directory
            .map(|dir| format!(" GSV_INSTALL_DIR={dir}"))
            .unwrap_or_default();
        Ok(format!(
            "curl -fsSL {url} | GSV_VERSION={release}{destination} bash"
        ))
    }
}

fn shell_quote(value: &str, windows: bool) -> String {
    let escaped = value.replace('\'', if windows { "''" } else { "'\\''" });
    format!("'{escaped}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_commands_quote_the_installer_release_and_destination() {
        let installer = "https://downloads.example/it's/install.sh?channel=stable&arch=x64";
        let dir = Path::new("/home/O'Neil/$bin");
        assert_eq!(
            install_command(installer, "v0.5.0", Some(dir), false).expect("Unix command"),
            "curl -fsSL 'https://downloads.example/it'\\''s/install.sh?channel=stable&arch=x64' | GSV_VERSION='v0.5.0' GSV_INSTALL_DIR='/home/O'\\''Neil/$bin' bash"
        );
        assert_eq!(
            install_command(installer, "v0.5.0", Some(dir), true).expect("Windows command"),
            "$env:GSV_VERSION='v0.5.0'; $env:GSV_INSTALL_DIR='/home/O''Neil/$bin'; irm 'https://downloads.example/it''s/install.ps1?channel=stable&arch=x64' | iex"
        );
        for invalid in [
            "not a URL",
            "http://downloads.example",
            "https://user:password@downloads.example",
        ] {
            assert!(install_command(invalid, "v0.5.0", None, false).is_err());
        }
    }

    #[test]
    fn the_installer_url_matches_the_platform_script() {
        for (base, windows_url) in [
            (
                "https://downloads.example",
                "https://downloads.example/install.ps1",
            ),
            (
                "https://downloads.example/",
                "https://downloads.example/install.ps1",
            ),
            (
                "https://downloads.example/host",
                "https://downloads.example/host/install.ps1",
            ),
            (
                "https://downloads.example/host/",
                "https://downloads.example/host/install.ps1",
            ),
            (
                "https://downloads.example/host/install.sh",
                "https://downloads.example/host/install.ps1",
            ),
            (
                "https://downloads.example/host/install.ps1",
                "https://downloads.example/host/install.ps1",
            ),
            (
                "https://downloads.example/host/install.sh?channel=dev",
                "https://downloads.example/host/install.ps1?channel=dev",
            ),
        ] {
            assert_eq!(
                installer_script_url(base, true).expect("Windows script"),
                windows_url
            );
            assert_eq!(
                installer_script_url(base, false).expect("Unix script"),
                url::Url::parse(base).expect("valid URL").as_str()
            );
        }
        assert!(installer_script_url("not a URL", true).is_err());
    }
}
