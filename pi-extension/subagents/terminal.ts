/**
 * Terminal backend selection — the seam between index.ts's orchestration and
 * the two interchangeable transports it can run subagent panes on: tmux
 * (tmux.ts) and Herdr (herdr.ts).
 *
 * index.ts imports the small surface API (create/split, send, read, close,
 * poll) from *this* module instead of importing tmux.ts directly, so the
 * orchestration code never has a transport conditional in it — this module
 * (and detectBackendFromSurface below) is the only place that branches on
 * backend.
 *
 * Two different decisions live here:
 *
 *  1. Which backend to use for a *new* surface (createSurface /
 *     createSurfaceSplit) — decided by `resolveTerminalBackend()` from
 *     environment/config, since there's no existing surface id to key off of
 *     yet.
 *
 *  2. Which backend already owns an *existing* surface (sendCommand,
 *     readScreen, closeSurface, pollForExit, …) — decided by
 *     `detectBackendFromSurface()` from the shape of the surface id itself
 *     (tmux ids start with `%`; Herdr ids are `workspace:pane`-shaped with a
 *     colon). This is deliberately independent of (1): a long-running
 *     subagent's operations must keep routing to the backend that actually
 *     created its pane, even if the process's environment/config could in
 *     principle be read differently later.
 */
import * as tmux from "./tmux.ts";
import * as herdr from "./herdr.ts";
import { shellEscape } from "./shell.ts";
import type { PollResult } from "./poll.ts";

export type TerminalBackendName = "tmux" | "herdr";

export interface TerminalBackendEnv {
  HERDR_ENV?: string;
  HERDR_PANE_ID?: string;
  PI_SUBAGENT_TERMINAL?: string;
}

export interface BackendAvailabilityChecks {
  herdrAvailable: () => boolean;
  tmuxAvailable: () => boolean;
}

const defaultChecks: BackendAvailabilityChecks = {
  herdrAvailable: () => herdr.isHerdrAvailable(),
  tmuxAvailable: () => tmux.isTmuxAvailable(),
};

/**
 * Decide which backend a *new* surface should be created on.
 *
 * Precedence (highest first):
 *   1. `PI_SUBAGENT_TERMINAL=herdr|tmux` — explicit user override. An
 *      unrecognized value fails closed (throws) rather than silently
 *      guessing, since a typo here should not silently fall through to
 *      whatever backend happens to be available.
 *   2. A valid Herdr context: `HERDR_ENV=1` *and* an explicit caller pane
 *      (`HERDR_PANE_ID` set) *and* the `herdr` CLI reachable. Both env vars
 *      are required — `HERDR_ENV=1` alone does not prove there's a real
 *      pane to split from, and we never guess "whichever pane is currently
 *      focused" (see herdr.ts's callerPaneId).
 *   3. tmux, if available (`TMUX` set and the `tmux` binary on PATH) — the
 *      long-standing fallback.
 *   4. Neither available: returns null; callers surface a setup hint.
 *
 * `env` and `checks` are injectable so this precedence is unit-testable
 * without mutating real process.env or spawning real CLIs.
 */
export function resolveTerminalBackend(
  env: TerminalBackendEnv = process.env as TerminalBackendEnv,
  checks: BackendAvailabilityChecks = defaultChecks,
): TerminalBackendName | null {
  const explicit = env.PI_SUBAGENT_TERMINAL?.trim().toLowerCase();
  if (explicit) {
    if (explicit === "herdr") return "herdr";
    if (explicit === "tmux") return "tmux";
    throw new Error(
      `Unknown PI_SUBAGENT_TERMINAL value "${env.PI_SUBAGENT_TERMINAL}" (expected "herdr" or "tmux").`,
    );
  }

  if (env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && checks.herdrAvailable()) {
    return "herdr";
  }

  if (checks.tmuxAvailable()) {
    return "tmux";
  }

  return null;
}

function requireBackendForNewSurface(): TerminalBackendName {
  const backend = resolveTerminalBackend();
  if (!backend) {
    throw new Error(`No terminal backend available. ${muxSetupHint()}`);
  }
  return backend;
}

/**
 * Decide which backend already owns `surface`, from the shape of the id
 * itself. tmux pane ids always start with `%` (e.g. `%12`); Herdr pane ids
 * are always `<scope>:p<n>`-shaped with a colon (e.g. `w1:p3`). Neither
 * format is a prefix of the other, so this is unambiguous.
 */
export function detectBackendFromSurface(surface: string): TerminalBackendName {
  if (surface.startsWith("%")) return "tmux";
  if (surface.includes(":")) return "herdr";
  throw new Error(
    `Cannot determine terminal backend for surface id "${surface}" ` +
      `(expected a tmux id like "%12" or a Herdr id like "w1:p3").`,
  );
}

function backendModuleFor(name: TerminalBackendName): typeof tmux | typeof herdr {
  return name === "herdr" ? herdr : tmux;
}

export function isMuxAvailable(): boolean {
  return resolveTerminalBackend() !== null;
}

export function muxSetupHint(): string {
  return `${tmux.muxSetupHint()} Or: ${herdr.muxSetupHint()}`;
}

export function createSurface(name: string): string {
  return backendModuleFor(requireBackendForNewSurface()).createSurface(name);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  return backendModuleFor(requireBackendForNewSurface()).createSurfaceSplit(name, direction, fromSurface);
}

export function sendCommand(surface: string, command: string): void {
  return backendModuleFor(detectBackendFromSurface(surface)).sendCommand(surface, command);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  return backendModuleFor(detectBackendFromSurface(surface)).sendLongCommand(surface, command, options);
}

export function readScreen(surface: string, lines = 50): string {
  return backendModuleFor(detectBackendFromSurface(surface)).readScreen(surface, lines);
}

export function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return backendModuleFor(detectBackendFromSurface(surface)).readScreenAsync(surface, lines);
}

export function closeSurface(surface: string): void {
  return backendModuleFor(detectBackendFromSurface(surface)).closeSurface(surface);
}

export function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  return backendModuleFor(detectBackendFromSurface(surface)).pollForExit(surface, signal, options);
}

export { shellEscape };
export type { PollResult };
