# Multi-agent memory profile — 2026-10-02

## Workload

- Isolated signed Tauri debug build on macOS 26.6.2, Apple Silicon.
- Two ACP test-agent processes, one for Claude and one for Codex; two sessions per agent, all four visible in separate panes.
- Each session received two rounds of 400 tool entries and 400 assistant entries. Assistant text totaled about 6.3 MiB across the four sessions.
- Measurements used `ps` RSS for Sail and helper processes and macOS `footprint` for the WebKit content process. RSS sums are volatile and can count shared pages more than once.
- The fixture stores full session history. Real Claude and Codex adapters were not run, so their memory use is unknown.

## Measured memory

| Stage                                         | WebKit physical footprint | Sail RSS |   ACP fixture RSS, combined |
| --------------------------------------------- | ------------------------: | -------: | --------------------------: |
| Four empty sessions, before panes opened      |                    55 MiB |   88 MiB |                      86 MiB |
| Four empty agent panes                        |                    87 MiB |   95 MiB |                      90 MiB |
| Four long sessions, after both rounds         |                   171 MiB |   87 MiB |                      84 MiB |
| One pane remains, after 20 seconds idle       |                   121 MiB |   96 MiB |                      86 MiB |
| All agent panes closed, after 20 seconds idle |                   110 MiB |        — | Two processes still running |

OpenCode also ran as a child process and ranged from about 130 to 300 MiB RSS during these runs. It makes the total memory much larger than Sail's own RSS. Its RSS varied substantially even when the ACP workload was idle, so a summed RSS figure is not a stable measure of the incremental session cost.

## Retention paths

- An open `AgentWorkspace` keeps its full transcript in `entries`. Only the last 50 entries render initially; rendering fewer entries does not cap the in-memory transcript.
- Sail's saved recent-transcript cache keeps at most 20 threads, the last 50 entries per thread, with a 128 KiB per-thread size budget. After all four panes closed, the saved cache was about 225 KiB.
- ACP connections are one process per agent type. Closing panes does not terminate these processes or their session histories. This preserves background sessions but retains agent-side memory until the app exits or the agent process stops.
- The parent app previously kept full `agentEntrySnapshots` for closed panes until changing projects. The app now drops snapshots when their agent pane leaves the layout. The repeat stress run completed with four long sessions and successful pane closure; WebKit footprint fell from 171 MiB to 110 MiB after all panes closed. The footprint remained above its empty baseline, so this does not establish that all WebKit allocations were released.

## Next measurement

Run the same scenario with real Claude and Codex ACP adapters and representative long sessions. Their process memory, especially retained conversation context and tool output, cannot be estimated from the lightweight test agents.
