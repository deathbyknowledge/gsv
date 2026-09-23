fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_session",
            "desktop_configure",
            "desktop_store",
            "desktop_open",
            "desktop_quit",
            "machine_status",
            "machine_command",
            "control_attach",
            "control_detach",
            "control_active",
            "control_reply",
            "input_attach",
            "input_acknowledge",
            "input_command",
        ]),
    ))
    .expect("build the desktop application command manifest");
}
