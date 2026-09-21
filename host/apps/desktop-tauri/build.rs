fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_session",
            "desktop_configure",
            "desktop_store",
            "desktop_open",
            "desktop_quit",
            "input_attach",
            "input_poll",
            "input_command",
        ]),
    ))
    .expect("build the prototype application command manifest");
}
