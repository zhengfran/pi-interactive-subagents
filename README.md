# pi-interactive-subagents

Herdr-enabled fork of [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents). See [FORK.md](FORK.md) for provenance and changes. The bundled Pi roles use Pi's configured default model; `kiro-worker` and `claude-worker` use their CLI's native default. No OpenRouter subscription is required.

Async subagents for [pi](https://github.com/earendil-works/pi), running in terminal panes — tmux or [Herdr](https://herdr.dev). Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**tmux or Herdr.** See [Terminal backend](#terminal-backend) for how the two are selected, and [Acknowledgements](#acknowledgements) for the upstream project, which also supports cmux, zellij, and WezTerm.

## Install

```bash
pi install git:github.com/zhengfran/pi-interactive-subagents
# Needed by the bundled researcher and worker web tools:
pi install npm:pi-web-access@0.15.0
```

Start Pi inside a Herdr or tmux pane, then call `subagents_list` or use `/subagent scout <task>`. If another subagent extension is already installed, disable it first to avoid duplicate tool registrations. Restart Pi or run `/reload` after installation; finish existing child tasks before reloading.

This fork uses current `@earendil-works` Pi packages and `typebox`. Unit tests run with Pi 0.87.1. The web-tool adapter expects Pi's standard managed npm installation of `pi-web-access` under the agent directory, or an explicitly registered backing extension.

### Scope and limitations

- The standard scout/researcher/worker agents run Pi; the opt-in `kiro-worker` runs Kiro and `claude-worker` runs Claude Code.
- `cli: claude` runs the native interactive **Claude Code TUI** with a parent-chosen session UUID and manual permissions. It uses a mapped `--tools` allowlist, loads no MCP servers, and registers per-run lifecycle hooks. Results come from tagged prompt/Stop receipts. Follow-ups are queued, autonomous runs exit gracefully with `/exit`, and resume reopens the exact UUID. A tool-free initial spawn and a finished-session resume with retained context were verified live on Claude Code 2.1.283. Live typed follow-ups, tool/approval turns, and API-error paths have fixture coverage only; see [validation evidence and limits](docs/claude-validation.md). The workspace must already be trusted: the adapter never answers the trust dialog and fails after 120 seconds without an acknowledged prompt.
- `cli: kiro` supports native interactive **Kiro CLI 2.24.x V2** (`chat --v2`), with tagged prompt/Stop-hook results, queued live follow-ups, graceful exit, and exact native UUID resume. Initial response, live follow-up, and the extension's real resume/result path were verified on 2.24.0; see [validation evidence and limits](docs/kiro-validation.md). V3 and Codex are not implemented.
- Native harness profiles fail closed when tools are absent or include unsupported Pi tools, skills, nested spawn, or Pi fork/lineage modes. Both reject unsupported thinking levels; Kiro also rejects system-prompt replacement. Tool restrictions are not an OS sandbox; manual approval prompts remain interactive.
- Tool allowlists are not an OS sandbox. Omitting a tool list can leave a Pi child unrestricted; review agent definitions before use, including project-local overrides discovered without a separate trust check.
- Herdr's agent-state controls and terminal text are not completion receipts. New launches use durable, per-run process receipts; legacy terminal sentinels remain only for older unsupervised callers.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own terminal pane (tmux or Herdr — see [Terminal backend](#terminal-backend)) — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

On tmux, the extension re-applies `even-horizontal` after each spawn and exit (debounced). Herdr uses its documented socket `layout.set_split_ratio` API to balance only the parent's contiguous, owned horizontal subtree when it fits; it skips mixed/unrelated/zoomed layouts rather than recreating panes or tabs. Both preserve focus and live processes.

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

### Completion and failure supervision

Every spawn and resume runs in an owned `exec bash` wrapper that atomically records its PID and exit code in `artifacts/<parent-session-id>/subagent-runs/<run-id>.json`. Clean Pi completion no longer depends on a terminal marker surviving narrow-pane wrapping or scrollback loss. Provider-error diagnostics use a separate run-specific file; an old run's receipt cannot complete a resumed session. Claude and Kiro require their correlated native Stop result plus a normal process exit, after graceful `/exit` or `/quit` for autonomous runs. A receipt alone never closes a native TUI.

A launch that never acknowledges startup fails after 30 seconds. A dead wrapper or lost receipt after startup fails after three consecutive checks (normally about two seconds). These are supervision failures, **not idle/task timeouts**: live agents waiting for a question, permission, or nested children remain open. Failure clears the running-child count and delivers an error to the parent, so a nested worker can recover rather than wait indefinitely.

Steering requires a live wrapper receipt and refuses a Pi child already marked done. `exec` also removes the outer shell: if the child exits between that check and input delivery, the message cannot become a shell command. A send acknowledgement still does not guarantee that the agent processed the message. If the tool reports an exiting run, wait for its result and retry the same name to resume. Already-closed panes do not discard completed results.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated terminal pane (tmux or Herdr, async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — Pi messages are typed into the live pane (newlines flattened). Kiro and Claude messages are queued and submitted after the current correlated native Stop. Kiro Stop events have no turn ID, and typing into a busy Claude TUI could be absorbed mid-turn or reach an approval prompt. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | Pi default | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | Pi default | `web_search`, `fetch_content`, `get_search_content`, `source_check`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | Pi default | `read`, `write`, `edit`, `bash`, web tools + spawning | General implementer; may spawn `scout` and `researcher` |
| **kiro-worker** | Kiro default | `read`, `grep`, `find`, `write`, `edit`, `bash` | Opt-in native Kiro CLI coding worker |
| **claude-worker** | Claude default | `read`, `grep`, `find`, `write`, `edit`, `bash` | Opt-in native Claude Code TUI coding worker |

The three Pi roles and the opt-in **kiro-worker** and **claude-worker** are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `fetch_content`, `get_search_content`, `source_check` (from Pi-managed `pi-web-access`), `safe_bash`; legacy standalone web/video extensions remain supported when installed. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `pi` (default), `claude`, or `kiro` (native interactive CLI; explicit supported tool allowlist required) |

### Native Claude Code profile

The package includes `claude-worker` (`read, grep, find, write, edit, bash`, effort `high`). Override it in `.pi/agents/claude-worker.md` if needed, and use `subagent({ agent: "claude-worker", task: "…" })`. Omit `model` to use Claude's native default, or provide a **Claude model ID or alias**, not a Pi `provider/model`. Claude Code and `python3` (with `fcntl`) must be installed and authenticated, and the target cwd must already be trusted in Claude.

Mappings: `read` → `Read`, `grep` → `Grep`, `find` → `Glob`, `write` → `Write`, `edit` → `Edit`, `bash` → `Bash`. `ls` requires `find` because Claude has no non-recursive listing tool. Thinking maps to `--effort` (`low`–`max`; `minimal` is refused). `system-prompt: replace` uses `--system-prompt`. The adapter writes only per-run files under the parent's artifacts; no Claude settings are edited. User/project permission allow rules and user/plugin hooks still apply natively, and approval prompts stay in the pane for the human. Details: [docs/claude-validation.md](docs/claude-validation.md).

### Native Kiro profile

The package includes `kiro-worker`. To customize it, override it in `.pi/agents/kiro-worker.md`:

```markdown
---
name: kiro-worker
cli: kiro
tools: read, grep, find, write, edit, bash
thinking: high
auto-exit: true
system-prompt: append
---
Complete the assigned coding task and summarize the result.
```

Use `subagent({ agent: "kiro-worker", task: "…" })` and follow up by the returned name. Omit `model` to use Kiro's native default, or provide a **Kiro model ID**, not a Pi `provider/model` identifier. Kiro and `python3` (with `fcntl`, Linux/macOS) must be installed; the CLI version and generated profile are checked before launch.

Mappings: `read` → `fs_read`, `grep` → `grep`, `find` → `glob`, `bash` → `execute_bash`; `write` and `edit` must be granted together because Kiro exposes both through `fs_write`. `ls` requires `read` for the same reason. Unsupported custom tools such as `safe_bash`, Pi skills, nested `subagent_agents`, and fork/lineage sessions are refused rather than granted broader access.

The adapter creates a uniquely named, temporary `.kiro/agents/<name>.json` in the target cwd without overwriting existing profiles or editing global settings. Native resume restores the **saved agent name**, so the loadout preserves it and resume recreates the same profile with fresh hook paths. If the path is occupied, resume refuses to overwrite it. Unchanged owned profiles are cleaned up on exit; human edits are preserved.

The generated profile lists only `file://AGENTS.md` and `file://CLAUDE.md` as `resources`, and only when each is a regular, non-symlinked file directly in the target cwd. It adds no steering, skills, knowledge bases, MCP servers, or home-relative/absolute/glob paths. Kiro may still apply its own native steering independently of the profile; the adapter neither adds nor suppresses it.

Like Pi and Claude spawns, the initial Kiro task gets the shared autonomous-mode and final-summary wrapper; resume and follow-up messages are sent unwrapped. The bundled `claude-worker` and `kiro-worker` share the Pi `worker`'s core guidelines and `Changes Made` / `Verification` / `Notes` format. They do not include its Pi-only `ask_question`, web tools, skills, or scout/researcher delegation. Blockers are reported in the final message instead.

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Terminal backend

Subagent panes run on one of two interchangeable terminal transports: **tmux** or **[Herdr](https://herdr.dev)**. Every tool (`subagent`, `subagent_message`, …) behaves identically either way — this only affects what a pane physically is and how it's created/closed. Backend selection is independent from which agent CLI runs inside the pane (Pi, Claude Code via `cli: claude`, or Kiro via `cli: kiro` in an agent's frontmatter — see [Frontmatter reference](#frontmatter-reference)); this is a **terminal transport** choice, not a harness/lifecycle integration.

Selection precedence for a *new* pane:

1. **Explicit override** — `PI_SUBAGENT_TERMINAL=herdr` or `PI_SUBAGENT_TERMINAL=tmux`. An unrecognized value is a hard error rather than a silent fallback.
2. **Valid Herdr context** — `HERDR_ENV=1` *and* an explicit caller pane (`HERDR_PANE_ID` set) *and* the `herdr` CLI reachable. Both env vars are required: `HERDR_ENV=1` alone doesn't prove there's a real pane to split from, and this extension never guesses "whichever pane the user currently has focused" — new panes always split off the parent pi's own pane.
3. **tmux fallback** — if running inside tmux (`TMUX` set, `tmux` on PATH).
4. Otherwise: subagent tools report a "no terminal backend available" error with a setup hint for both.

A running subagent's pane always keeps talking to whichever backend actually created it (panes are self-identifying: tmux ids look like `%12`, Herdr ids look like `w1:p3`) — this doesn't change mid-flight even if the env/config above would resolve differently later.

### Preserved vs. Herdr-specific behavior

- **Preserved**: spawn/message/list tools, widget, Pi `ask_question`/resume, and result delivery. Process exit supervision is now durable rather than screen-based. Claude and Kiro use separate native hook/session-ID contracts, not Pi transcripts or screen scrapes.
- **Herdr-specific**: equal-width balancing is best-effort on the parent plus its owned horizontal children, bounded by minimum pane width; left/up splits remain unsupported (`pane split` only supports `right`/`down`).
- **Not (yet) used**: Herdr also exposes agent-aware lifecycle state (`agent start`/`agent prompt`/`agent wait`, idle/done/blocked/unknown). This phase does not use it — Herdr's idle/done is not a reliable per-message completion receipt (it can settle on an already-in-flight turn, and is affected by seen/focus state), so it isn't a drop-in replacement for the run-specific completion mechanisms above. Terminal state remains informational; the native harness adapters own turn/session completion.

## Requirements

- [pi](https://github.com/earendil-works/pi) with the current `@earendil-works` package names
- One of:
  - [tmux](https://github.com/tmux/tmux)
  - [Herdr](https://herdr.dev), with `HERDR_ENV=1` and `HERDR_PANE_ID` set in the calling pane (Herdr sets these natively)

```bash
tmux new -A -s pi 'pi'
# or, inside a Herdr pane:
pi
```

## Development

Use Node.js 24 or newer:

```bash
npm ci
npm test
```

Live integration tests are opt-in and require tmux plus configured Pi model access; they may make model requests:

```bash
npm run test:integration
```

## Acknowledgements

Forked from [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents), based on [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT

This content is generated by AI (Kiro)
