# Sail usability personas and test protocol

These are **hypothesis personas** for repeatable expert walkthroughs, not interviews or evidence from real users. Each tester starts with a fresh app profile and a disposable Git repository. Record the OS, Sail commit, available agents, starting state, action sequence, visible result, screenshots or accessibility output, and severity. Mark a task **blocked by environment** when an external agent, provider, or plugin is unavailable; do not call it a product failure without reproducing the product behavior.

The scenarios state goals without naming Sail controls. This follows [NN/g's task scenario guidance](https://www.nngroup.com/articles/task-scenarios-usability-testing/) and [usability testing guidance](https://www.nngroup.com/articles/usability-testing-101/). Evaluate feedback, recovery, and discoverability against [NN/g's usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/). Accessibility checks use [WCAG 2.2 keyboard operation](https://www.w3.org/WAI/WCAG22/Understanding/keyboard), [focus visibility](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible), and [dragging alternatives](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements).

## Maya — AI power user

- **Context:** Senior engineer who runs several agents, reviews plans before execution, and switches between code and conversation.
- **Goal:** Stay aware of what the agent is doing and interrupt it without losing work.
- **Scenario:** Plan a small change in a disposable repository. Inspect its diagram and individual steps, request one revision, then inspect the resulting changes. Start a second agent conversation and stop an answer in progress.
- **Observe:** Working versus idle status; timing and clarity of progress updates; whether plan edits and drafts survive panel switches; whether the diagram can be read; whether Changes reflects current Git state after a revert; whether Escape stops the active agent without deleting the conversation.
- **Success:** Each state and action is discoverable from the UI, the displayed diff matches Git, and switching or stopping preserves prior work.

## Alex — first-time user

- **Context:** Understands a local repository but has never used OpenCode, ACP, or a planning plugin.
- **Goal:** Start useful work without external coaching.
- **Scenario:** Open Sail with a repository, discover what is needed to begin, ask for a plan, then return after a restart. Repeat with a missing or invalid runtime dependency.
- **Observe:** Whether labels and setup instructions explain the next action; whether the runtime path is findable in settings; whether progress differs visibly from a stuck state; whether errors state how to recover; whether repository, session, and preferences return after restart.
- **Success:** The path to first plan is understandable when prerequisites exist. Missing prerequisites have a specific, visible repair step. Saved context returns.

## Jordan — multi-repository maintainer

- **Context:** Works across several repositories and uses worktrees to isolate tasks.
- **Goal:** Navigate quickly without editing or deleting the wrong checkout.
- **Scenario:** Organize two repositories under a named project, make a separate checkout for a task, switch among repositories and worktrees, then remove an obsolete checkout. Try removal once with an uncommitted file.
- **Observe:** Sidebar grouping and selected location; worktree dialog, destination, and base branch; session isolation on switches; deletion confirmation, dirty-file protection, and the resulting Git/workspace state.
- **Success:** Selection always names the correct path; created worktrees live in the Sail workspace; dirty deletion is refused clearly; clean deletion removes exactly the chosen worktree.

## Sam — keyboard and low-vision user

- **Context:** Uses keyboard navigation and enlarged content; precise dragging is difficult.
- **Goal:** Review the same work without relying on pointer precision.
- **Scenario:** Enlarge the UI, move between projects and the plan, open a diagram for reading, give feedback on a plan, resize the plan area, and inspect and dismiss Changes.
- **Observe:** Tab order, visible focus, accessible names, keyboard reachability and escape routes, readable text and diagrams at larger scale, resize keyboard steps and a pointer alternative, status messages, and focus after dialogs close.
- **Success:** Essential tasks remain usable with keyboard and enlarged UI, with no focus trap or unexpected jump. Resizing does not require dragging.

## Reporting

For each persona, report completed tasks, blocked tasks, and findings with exact steps, expected and actual behavior, screenshot or accessibility evidence, severity, and affected commit. Treat simulated-persona findings as an expert audit; validate high-impact findings with real users when available.
