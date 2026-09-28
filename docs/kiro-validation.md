# Native Kiro integration validation

## Supported contract

The adapter targets **Kiro CLI 2.24.x, explicitly `chat --v2`**, in a real interactive terminal pane. Live checks below used 2.24.0 on Linux/Herdr 0.9.0. It does not substitute ACP, `--no-interactive`, stream JSON, a log viewer, or terminal-text extraction. V3 is not claimed: its optional migration dialog was left unanswered and that disposable workspace was closed.

References: [Kiro 2.x reference](https://kiro.dev/docs/cli/2x-reference/), [agent configuration](https://kiro.dev/docs/cli/custom-agents/configuration-reference/), and the installed `kiro-cli chat --help`. Current web docs also describe 3.0; they are not evidence that those interfaces work identically in 2.24.

## Live evidence — 2026-09-28

Three additional benign model prompts were explicitly authorized after earlier reconnaissance. No tools were requested, approvals answered, global configuration modified, or packages updated. Those lifecycle runs predate the later switch to `--trust-all-tools`; the bypass flag is covered by command-construction and offline launch fixtures.

1. **Initial native turn:** the prompt supplied a tagged token and asked Kiro to remember `COBALT`, then answer `KIRO_NATIVE_ONE`. The hook JSON contained:
   - `agentSpawn`: `hook_event_name`, `cwd`, `session_id`.
   - `userPromptSubmit`: the same identity plus the exact `prompt` string/token.
   - `stop`: the same identity plus `assistant_response: "KIRO_NATIVE_ONE"`.
2. **Live follow-up:** a second tagged prompt in the same TUI received `KIRO_NATIVE_TWO COBALT`. Both prompt and stop hooks retained the same native UUID. `/quit` exited the native CLI normally.
3. **Actual extension resume path:** a local, non-model driver registered the observed native session and its loadout, then invoked the extension's real `subagent_message` tool. The adapter created a native Kiro pane, resumed the exact UUID, received `KIRO_NATIVE_RESUMED COBALT`, sent `/quit`, and observed exit code 0. Exactly one `subagent_result` with `{ triggerTurn: true, deliverAs: "steer" }` reached the driver. The running-child map was empty and the owned generated profile was removed afterward. Completion took approximately 15 seconds.

A no-prompt resume check also established a critical behavior: **`--resume-id` restores the session's saved agent name, ignoring a different `--agent` name**. Merely generating a new profile name on resume loses the lifecycle hooks. The adapter therefore persists `nativeAgentName` in the loadout and recreates that same owned profile, with new per-run hook paths. Exclusive file creation refuses collisions rather than overwriting another profile.

The first two live turns captured the native event contract; the third exercised the production adapter/hook/watcher/resume path. A later user-requested demo also exercised the real `subagent` initial-spawn path with the bundled `kiro-worker`: one tool-free JavaScript review correctly identified `average([])` returning `NaN`, proposed a `RangeError` guard, and supplied a test case. It returned in 17 seconds with exit code 0, one result notification, no remaining child entry, and its generated profile removed.

Mid-generation queued steering has deterministic fixture coverage, not a live model probe. No live tmux model integration was performed.

## Reliability and safety

- Hooks lock and atomically write state. Session identity is obtained from the owned native hooks, never by selecting a recent session from a directory.
- Kiro Stop has no turn ID. Parent follow-ups are queued and serialized after the current correlated Stop. Overlapping native prompts fail explicitly rather than assigning an old response to a new turn.
- A Stop receipt alone does not close the pane. Autonomous runs send `/quit` and await the supervised process exit, allowing native history to persist before a future resume. Interactive profiles remain open.
- Missing hook/start acknowledgements fail after 30 seconds; graceful quit that never exits fails after 15 seconds. A provider/tool wait after a valid prompt acknowledgement is not a task timeout.
- Generated profiles have explicit tool sets and no inherited MCP configuration. Their `resources` contain only cwd-local, regular (non-symlink) `AGENTS.md`/`CLAUDE.md` files. The installed 2.24.0 source reads relative `file://` resources against the workspace into custom-agent context and skips missing files. This resource wiring has fixture/source coverage only, not a live model probe. The launch uses `--trust-all-tools`, which pre-approves the generated profile's explicit tool set without adding unavailable tools. Pi-only capabilities and permission mappings that would broaden access fail closed. This is not an OS sandbox; use native worker profiles only in trusted working directories.
- Run-specific files isolate concurrent sessions in the same cwd. Profiles are removed only when their contents still match the generated file; human edits are preserved. Symlinked profile directories are refused.
- Native session-ID rollover (for example, a compaction that changes identity), unsupported CLI versions, and ambiguous human input during autonomous operation fail closed. They are not silently treated as successful completion.

`npm test` covers event parsing, identity and turn mismatch, overlap, missing output, queued follow-ups, graceful quit, permissions, profile ownership, and all three harnesses' spawn/resume/result delivery with local fake CLI executables. Those fixtures never contact a model.
