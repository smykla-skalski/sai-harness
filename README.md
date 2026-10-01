# Sail

A desktop workspace for planning and reviewing coding-agent work. OpenCode runs the agent sessions; Sail manages the workflow around them: plans, reviewer findings, decisions, approvals, and implementation handoff.

## Plan workspace

- Pick a repository, start an Architect chat, and resume earlier plan sessions.
- Organize repositories into named sidebar groups and switch between them without losing each repository's last session.
- Create a Git worktree from a repository row; Sail opens the new checkout and lists it beneath its repository.
- Resize the entire interface with Command/Ctrl + minus or plus; Command/Ctrl + 0 resets it.
- See live OpenCode messages alongside structured questions, Mermaid diagrams, alternatives, and per-step decisions.
- Send answers, request revisions, or approve a plan for the build agent through [opencode-plugin-plan-review](https://github.com/smykla-skalski/opencode-plugin-plan-review).
- The desktop app starts a local, password-protected OpenCode server and stops it on exit.

## Development

For packaged development builds, see [installation and first project](docs/install.md). The [release checklist](docs/validation.md#release-checklist) covers platform smoke tests and signing status.

Prerequisites: [mise](https://mise.jdx.dev/), [OpenCode v2](https://opencode.ai/v2/docs/), and the platform dependencies required by [Tauri](https://tauri.app/start/prerequisites/). Configure [opencode-plugin-plan-review](https://github.com/smykla-skalski/opencode-plugin-plan-review) before planning. See the [tested version matrix and release smoke](docs/validation.md); the published `0.2.0` plugin lacks the history RPC required by this app. Install the tested Git revision:

```sh
opencode plugin add github:smykla-skalski/opencode-plugin-plan-review#fdc575ba5ffccc6420ad5b3b68372f99f70290f5
```

For a local checkout, add its path to the selected repository's `opencode.jsonc`:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-plugin-plan-review"] }
```

Mise installs the latest stable Node.js and Rust toolchains. The development task installs JavaScript dependencies when needed.

```sh
mise run dev
```

Select the repository in the app and complete the repository setup checks, then describe the work in chat. The first message creates an Architect session. The app detects OpenCode in common installation locations. Open **OpenCode settings** to see the detected binary or set an absolute path; the app remembers an override. You can also set `SAIL_OPENCODE_BIN` before starting the app.

Use **+ Group** and **+ Repo** in the sidebar to organize saved repositories. Each repository row has a **+** control to create a worktree. Sail uses the remote default branch when Git records one, then `main` or `master`, then the main checkout branch. Enter a base branch in the form to choose another starting point. By default, new worktrees live in `~/sail/worktrees/<repository>-<id>/<name>` so repositories with the same name stay separate; choose a different parent folder in the form when needed. `SAIL_WORKTREE_ROOT` overrides the default root.

Other tasks:

```sh
mise run web    # frontend preview; desktop runtime unavailable in a browser
mise run lint   # strict Oxlint, ESLint, Prettier, rustfmt, Clippy
mise run check  # lint, Svelte typecheck, frontend build
mise run format # format frontend and Rust sources
mise run build  # desktop bundle
```

Pull requests run the same frontend and Rust checks on Linux, macOS, and Windows through GitHub Actions. The frontend lint configuration follows the [Harness panel](https://github.com/smykla-skalski/harness/tree/main/crates/harness-panel/frontend); Rust uses its Clippy settings.

## Architecture

```text
Svelte + SUI ── OpenCode v2 client ── local OpenCode server
      │                                    └── plan-review plugin RPC + storage
      └── Tauri ── starts/stops server, opens repository picker
```

OpenCode owns sessions and execution. The plan-review plugin owns plans and decisions. Sail renders and submits that workflow in a desktop UI.

## License

MIT
