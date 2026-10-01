# Agent instructions

## Isolated Sail desktop runs

- Treat existing Sail windows, dev servers, and E2E sessions as owned by other worktrees. Do not stop them or reuse their ports.
- Build test apps with a private `CARGO_TARGET_DIR` under a unique temporary directory. Give each macOS test bundle a unique Tauri `identifier` and `productName`; the identifier separates its system and webview data.
- Give each embedded WebDriver instance a free port through `TAURI_WEBDRIVER_PORT` or WebdriverIO's `embeddedPort`. The default is `4445`. Set `SAIL_E2E_CONFIG_DIR`, `SAIL_WORKTREE_ROOT`, and the XDG directories to private paths. Keep `SAIL_ACP_TEST_AGENT` pointed at this checkout's `test/e2e/acp-agent.mjs`.
- `wdio.conf.ts` currently hardcodes `src-tauri/target/debug/sail`. Override the binary path when testing a private build; a private target directory alone will not change that path. Avoid a shared Vite dev server on port `1420` by testing a bundled app.
- On macOS, sign the private `.app` bundle and launch a separate instance with `open -n -g`, passing the isolated environment through `open --env`. Verify readiness at `http://127.0.0.1:<port>/status` before driving it. In the Orca command sandbox, a localhost request can fail even while the endpoint is listening; run the readiness probe outside that sandbox.
- Stop only the processes started for the current run, then remove their temporary state.
