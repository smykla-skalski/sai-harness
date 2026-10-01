fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "start_runtime",
            "validate_repository",
            "create_worktree",
            "local_plugin_version",
        ]),
    ))
    .expect("failed to build Tauri permissions")
}
