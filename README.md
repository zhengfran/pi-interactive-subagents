# pi-interactive-subagents

Herdr-enabled fork of [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents). See [FORK.md](FORK.md) for provenance and changes. The bundled roles use Pi's configured default model; no OpenRouter subscription is required.

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

- Herdr support is a **terminal transport**, not additional harness support. Bundled agents run Pi; Kiro and Codex are not implemented.
- Upstream's optional `cli: claude` path remains experimental: it bypasses permission prompts, ignores the Pi tool allowlist, lacks finished-session native resume, and follow-ups can prevent automatic completion. No bundled role selects it.
- Tool allowlists are not an OS sandbox. Omitting a tool list can leave a Pi child unrestricted; review agent definitions before use, including project-local overrides discovered without a separate trust check.
- Herdr's agent-state controls are not used as completion receipts; existing sidecar/sentinel and transcript collection remain in place.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own terminal pane (tmux or Herdr — see [Terminal backend](#terminal-backend)) — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

On tmux, panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/tmux.ts` — change it to any named tmux layout (`main-vertical`, `tiled`, …). Herdr has no equivalent "apply a named layout to every pane in the tab" command, so this auto-rebalancing is tmux-only — see [Terminal backend](#terminal-backend).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

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

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
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

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

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
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

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

Subagent panes run on one of two interchangeable terminal transports: **tmux** or **[Herdr](https://herdr.dev)**. Every tool (`subagent`, `subagent_message`, …) behaves identically either way — this only affects what a pane physically is and how it's created/closed. Backend selection is independent from which agent CLI runs inside the pane (pi, or the Claude Code CLI via `cli: claude` in an agent's frontmatter — see [Frontmatter reference](#frontmatter-reference)); this is a **terminal transport** choice, not a harness/lifecycle integration.

Selection precedence for a *new* pane:

1. **Explicit override** — `PI_SUBAGENT_TERMINAL=herdr` or `PI_SUBAGENT_TERMINAL=tmux`. An unrecognized value is a hard error rather than a silent fallback.
2. **Valid Herdr context** — `HERDR_ENV=1` *and* an explicit caller pane (`HERDR_PANE_ID` set) *and* the `herdr` CLI reachable. Both env vars are required: `HERDR_ENV=1` alone doesn't prove there's a real pane to split from, and this extension never guesses "whichever pane the user currently has focused" — new panes always split off the parent pi's own pane.
3. **tmux fallback** — if running inside tmux (`TMUX` set, `tmux` on PATH).
4. Otherwise: subagent tools report a "no terminal backend available" error with a setup hint for both.

A running subagent's pane always keeps talking to whichever backend actually created it (panes are self-identifying: tmux ids look like `%12`, Herdr ids look like `w1:p3`) — this doesn't change mid-flight even if the env/config above would resolve differently later.

### Preserved vs. Herdr-specific behavior

- **Preserved**: spawn/message/list tools, the completion widget, sidecar/sentinel-based completion detection (`.exit` files, `__SUBAGENT_DONE_<code>__`), `ask_question`, session resume, and the Claude Code CLI path (`cli: claude`) all work the same regardless of backend.
- **Not supported on Herdr**: automatic pane-layout rebalancing (Herdr's CLI has no "apply a named layout across the tab" command, unlike tmux's `select-layout`) and left/up splits (Herdr's `pane split` only supports `right`/`down` — this extension only ever splits `right` for new subagents, so this doesn't affect normal use, but a direct `right`/`down`-only restriction applies if `createSurfaceSplit` is ever called with `left`/`up` under Herdr).
- **Not (yet) used**: Herdr also exposes agent-aware lifecycle state (`agent start`/`agent prompt`/`agent wait`, idle/done/blocked/unknown). This phase does not use it — Herdr's idle/done is not a reliable per-message completion receipt (it can settle on an already-in-flight turn, and is affected by seen/focus state), so it isn't a drop-in replacement for the sidecar/sentinel completion mechanism above. A future phase could build proper cross-harness lifecycle support on top of it; this phase is terminal transport only.

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
