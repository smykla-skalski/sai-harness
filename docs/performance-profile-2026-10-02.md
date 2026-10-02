# Pane performance profile — 2026-10-02

## Setup

- macOS 26.6.2, Apple Silicon; isolated, ad hoc signed Tauri debug bundle with the E2E feature.
- Private bundle ID, WebDriver port, worktree, and XDG directories. No shared Sail process or port was used.
- 30 sequential open/close cycles for terminal panes, then 30 for empty browser panes. Timings came from `performance.now()` in the app webview, excluding WebDriver round trips. RSS came from `ps` for the Sail process only.
- Terminal response: a shell command emitted a unique marker; timing ended when xterm's accessibility tree contained it. This includes shell startup, PTY I/O, IPC, and terminal rendering.
- Browser page: a local HTTP page served a small static response. A six-second `sample` capture profiled the updated app with two browser panes open.

## Results

| Operation                                 |   Median |      P95 |  Maximum |
| ----------------------------------------- | -------: | -------: | -------: |
| Terminal xterm mount                      |    44 ms |    82 ms |   100 ms |
| Terminal first shell response after mount | 2,137 ms | 4,795 ms | 6,557 ms |
| Empty browser split                       |     5 ms |     7 ms |    23 ms |
| Empty browser content mount after split   |     4 ms |     7 ms |    24 ms |

The first local page's native WebView was ready in 64 ms during the 12-cycle run. After the 30-cycle run it took 1,227 ms, then another 582 ms for the loading indicator to clear. These two observations show a large tail but are insufficient for a stable page-load distribution.

The app's post-close RSS ranged from 92–101 MiB during terminal cycles and 79–97 MiB during browser cycles. It did not rise monotonically. No terminal shell child remained after the 30 terminal cycles. RSS excludes OpenCode and WebKit helper processes; an OpenCode child used roughly 180–220 MiB RSS in sampled runs. A macOS `footprint` sample measured the Sail process at 37.5 MiB physical footprint with two empty browser panes.

## Hotspots and change

- One `browser_detected_servers` RPC took 104–158 ms across six direct calls. Before this change, every browser pane issued this RPC at mount and every five seconds. The Rust path refreshes process working directories and enumerates TCP sockets. A six-second CPU sample of the updated app included 93 stack samples in the detection task, with 63 in `sysinfo` process refresh and 27 in `netstat2` socket enumeration.
- Browser panes now share one poll per worktree. The five-second refresh and result display stay the same. The updated isolated app opened two browser panes successfully; static checks and unit tests passed.
- The shell response delay is much larger than pane mounting. On this machine, `zsh -lic true` took about 0.96 s, while `/bin/sh -ic true` took about 0.01 s. Shell setup is a substantial contributor, but the pane measurement also includes PTY and rendering work. Sail still launches the configured login shell.

## Follow-up measurements

- Profile at least 30 local page navigations on a release build to characterize the native WebView tail.
- Measure total memory including WebKit and OpenCode helper processes, preferably with stable process attribution and a long idle period.
- Add an explicit shell-ready marker in an opt-in benchmark so shell startup, PTY delivery, and xterm rendering can be timed separately.
