fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "start_runtime",
            "validate_repository",
            "working_tree_diff",
            "create_worktree",
            "local_plugin_version",
            "acp_agents",
            "acp_connect",
            "acp_new_session",
            "acp_load_session",
            "acp_prompt",
            "acp_cancel",
            "acp_permission",
            "acp_set_config",
            "acp_authenticate",
        ]),
    ))
    .expect("failed to build Tauri permissions")
}
