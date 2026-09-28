# Native Claude Code integration validation

## Supported contract

The adapter runs the **native interactive Claude Code TUI** in an owned tmux/Herdr pane. It does not use `-p/--print`, stream JSON, the SDK/ACP, or terminal-text extraction. Live checks below used Claude Code 2.1.283 on Linux/Herdr 0.9.0. The command is:

```text
cd <cwd> && claude --permission-mode bypassPermissions --dangerously-skip-permissions \
  --strict-mcp-config --tools <mapped> --settings <per-run file> \
  [--model …] [--effort …] [--append-system-prompt|--system-prompt …] (--session-id|--resume) <uuid> '<tagged prompt>'
```

- **Identity:** the parent chooses the UUID (`--session-id`) and resumes the same UUID (`--resume`). Hooks reject any other `session_id` (for example after `/clear` or a fork), so the run fails instead of adopting a new identity.
- **Hooks:** an exclusively created per-run `settings.json` registers `SessionStart`, `UserPromptSubmit`, `Stop` and `StopFailure` to `plugin/hooks/claude-lifecycle.py`, with per-run config and locked, atomic state. No user, project, or global settings file is written. The old shared `claude-settings.json` let a concurrent launch, or Claude's settings hot reload, retarget another child's receipt.
- **Turn correlation:** a Stop completes a run only if it follows a `UserPromptSubmit` whose `prompt` starts with the current `[pi-subagent-turn:<uuid>]` token. Stale or duplicate Stops, untagged human prompts, and prompts that overlap an active turn are `untracked`. `StopFailure` (API errors) and empty final text are `failed`. The summary comes from the hook's `last_assistant_message`. The adapter does not scan transcripts or select the most recent session.
- **Follow-ups:** a message sent to a running Claude child is queued and typed only after the current correlated Stop. Typing into a busy TUI could be absorbed mid-turn or reach an approval prompt.
- **Exit:** a Stop receipt never closes the pane. Autonomous runs send `/exit` and complete only after the supervised process exits, so native history is flushed before any resume. Interactive profiles remain open for the human.
- **Deadlines:** if the tagged prompt is not acknowledged within 120 seconds of launch (30 seconds for a queued follow-up), the run fails. This catches disabled hooks or a human-only startup dialog, such as workspace trust, without answering that dialog. The run also fails if `/exit` does not end the process within 15 seconds. Waiting for approvals after acknowledgement is not timed out.

## Permissions

- The `--tools` built-in allowlist maps `read`→`Read`, `grep`→`Grep`, `find`→`Glob`, `write`→`Write`, `edit`→`Edit`, and `bash`→`Bash`. `ls` requires `find` because Claude has no non-recursive listing tool. Unmapped Pi tools, Pi skills, nested `subagent_agents`, lineage/fork sessions, and unsupported effort levels (for example `minimal`) are rejected before launch. Agent, Skill, web and other built-ins are not granted unless listed, and the list above has no mapping for them.
- `--strict-mcp-config` without `--mcp-config` loads **zero** MCP servers, ignoring user, project and plugin MCP configuration. `--permission-mode bypassPermissions --dangerously-skip-permissions` pre-approves calls to the tools named by `--tools`; it does not add tools outside that allowlist. Workspace trust is still a separate startup dialog and is never answered by the adapter.
- Inherited configuration still applies natively. User and plugin hooks also run. For example, the validation account's `SessionStart` memory hook injected context. Enabled plugins' skills and commands remain available to a **human** typing slash commands. Claude also updates its own `~/.claude.json` state. The bypass is intentionally dangerous and this is not an OS sandbox; use native worker profiles only in trusted working directories.
- Resume replays the loadout snapshot (tools, model, effort, identity, and original cwd). It refuses a missing or mismatched native UUID or cwd.

## Live evidence — 2026-09-28

The run used exactly two benign model prompts, both in a disposable, already-trusted, non-git directory (`/tmp/pi-claude-probe.*`; `/tmp` was already trusted, so no dialog appeared). Each prompt ran in an owned Herdr pane split from the caller with `--no-focus`. A local non-model Node driver loaded the working-tree extension with a stub Pi API and invoked the real `subagent` and `subagent_message` tools. No tools were requested or used (the transcript has zero `tool_use` entries). No approvals were answered.

0. **No-model reconnaissance:** the original lifecycle validation, run without a prompt, showed `manual mode on`, no trust dialog, and `/mcp` → "No MCP servers configured". `/exit` typed through `herdr pane run` exited the TUI normally. The later approval-bypass change is covered by command-construction and offline launch fixtures; `claude --permission-mode bypassPermissions --dangerously-skip-permissions --version` also confirms the installed CLI accepts the flags.
1. **Initial spawn** (`claude-probe`: `cli: claude`, `tools: read`, `auto-exit: true`): the prompt asked Claude to remember `COBALT` and reply `CLAUDE_NATIVE_ONE`. The hook state recorded `session_id 6e0467be-…`, the launch token, `phase: stopped`, and `summary: CLAUDE_NATIVE_ONE`. The adapter sent `/exit`, and the wrapper receipt recorded `exitCode: 0`. Exactly one `subagent_result` was delivered (exit 0, 7 s, `{ triggerTurn: true, deliverAs: "steer" }`).
2. **Finished-session resume** via `subagent_message({ name })`: `--resume 6e0467be-…` with a new token returned `CLAUDE_NATIVE_RESUMED COBALT`, which shows retained native context. The wrapper exited 0 after `/exit`, and one result was delivered.

Afterward, the native transcript `~/.claude/projects/-tmp-pi-claude-probe-*/6e0467be-….jsonl` held one session ID. It contained both tagged prompts and both answers, with `permissionMode: default`, which was the internal name for manual mode in that pre-bypass lifecycle run. The running-child map was empty, and both owned panes were closed. The caller pane kept focus.

## Not live-verified

- A queued **live follow-up** typed into the running TUI, and long or multi-line follow-up delivery. These have fixture coverage only, although `/exit` confirmed that typed input works.
- A live tool-using turn under bypass mode; `StopFailure` for real API errors; the start deadline with an untrusted workspace; `/clear` or compaction identity changes; tmux transport.
- The actual tool schema sent to the model. The CLI's `--tools` and MCP state were checked, but the per-request tool list is not observable without additional model calls.
- Another user or plugin `Stop` hook that blocks and continues a turn can race `/exit`. The latest continued text is kept, but this has not been exercised.

`npm test` covers hook parsing, identity and turn mismatch, overlap, stale and duplicate Stops, API failure, queued follow-ups, graceful exit and its deadline, the start deadline, per-run settings isolation, fail-closed permission mapping, and spawn → resume → result delivery through real launch scripts with an offline `claude` stand-in (`test/fixtures/claude-cli.py`). Those fixtures never contact a model.

This content is generated by AI (Kiro)
