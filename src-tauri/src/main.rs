#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--browser-mcp") {
        sail_lib::browser_agent::run_mcp_stdio();
        return;
    }
    sail_lib::run();
}
