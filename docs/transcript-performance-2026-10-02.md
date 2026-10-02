# Transcript processing profile — 2026-10-02

## Change

- Agent transcript entries and parent pane snapshots now use shallow Svelte state. Both are updated by replacement.
- Live ACP events arriving in one 50 ms flush now copy the transcript array once per batch.
- Session history replay builds its private transcript array in place. Tool IDs are indexed for replay and batches.

## CPU profile

Node synthetic workload: 4,000 tool events alternating with 4,000 assistant messages, producing 8,000 transcript entries. Five timed runs after warmup; median wall time:

| Update path                                             |   Median |
| ------------------------------------------------------- | -------: |
| Individual immutable updates (old live/replay behavior) | 108.1 ms |
| 50-event immutable batches (new live behavior)          |  42.3 ms |
| In-place replay (new history-load behavior)             |  30.7 ms |

The workload stresses transcript processing, not rendering or actual ACP adapter latency. Live batch sizes vary with event timing. Svelte state changes were not isolated in this CPU benchmark.

## Desktop memory check

An isolated, signed macOS Tauri debug build used two ACP test agents and four visible sessions, each receiving two rounds of 400 tool events and 400 assistant entries. Each assistant entry contained 2,048 characters. WebKit `phys_footprint`:

| Stage                          | Shallow state only | Shallow state and batched updates |
| ------------------------------ | -----------------: | --------------------------------: |
| Four empty panes               |              70 MB |                             57 MB |
| Four long sessions             |             157 MB |                            116 MB |
| One pane after 20 seconds idle |             130 MB |                            103 MB |

Each column is one run. These samples show lower footprint in the optimized run but do not isolate the cause or establish a stable memory saving. The shallow-state run still grew by 87 MB with transcripts; the final run grew by 59 MB. Open panes still retain their full transcripts, and ACP child processes retain session history. Real Claude and Codex adapter memory remains unmeasured.

The final build completed the four-session workload and rendered all four conversations. Lint, Svelte check, and 72 unit tests passed.
