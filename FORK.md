# Fork provenance

This fork builds on [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) at commit `c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7` (3.7.2), itself derived from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). Upstream history and the original MIT license are retained.

## Changes

- Add Herdr as a terminal backend alongside tmux. Select explicitly with `PI_SUBAGENT_TERMINAL`, otherwise detect a valid Herdr caller context before falling back to tmux.
- Share shell escaping, launch-script staging, and completion polling between terminal adapters. Preserve caller focus and use explicit pane targets.
- Use current `@earendil-works` Pi imports and `typebox`.
- Let bundled agents use Pi's configured default model rather than requiring OpenRouter. Apply role thinking levels even without an explicit model override.
- Use `pi-web-access`'s actual tool names (`web_search`, `fetch_content`, `get_search_content`, `source_check`) and locate its Pi-managed npm entry point for restricted children.
- Add mocked Herdr/terminal-selection tests and make extension-resolution tests independent of personal configuration.

The terminal adapter has been smoke-tested against Herdr 0.9.0, protocol 22. Unit tests do not launch model sessions or real panes. Live tmux model-driven integration tests are separate and opt-in.

## Non-goals of this release

No Kiro/Codex harness integration, quota-aware routing, cross-session relay, or OS sandbox was added. The optional upstream Claude path retains its existing permission, resume, and completion-hook limitations. Herdr agent-state controls are not used as a replacement for completion receipts.
