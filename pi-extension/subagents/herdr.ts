/**
 * Herdr surface layer — the second terminal backend this extension supports
 * (see tmux.ts for the other, and terminal.ts for backend selection).
 *
 * Mirrors tmux.ts's small API (create/split a pane, type a command into it,
 * read its screen, close it, poll for exit) so index.ts's orchestration
 * stays transport-agnostic. See terminal.ts for how a surface id is routed
 * back to this module vs tmux.ts.
 *
 * Panes are identified by Herdr pane ids (e.g. `w1:p3`, opaque and stable).
 * Splits always target the caller's own pane (`$HERDR_PANE_ID`, the pane this
 * extension's host process is itself running in) via an explicit `--pane`
 * argument, and always pass `--no-focus`, so new panes follow the agent
 * rather than stealing the human's keyboard focus.
 *
 * Every Herdr CLI call in this file goes through `runHerdr`/`runHerdrAsync` —
 * the sole seam tests replace to avoid spawning a real `herdr` process. See
 * `__setHerdrExecutorForTest__` at the bottom.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { shellEscape } from "./shell.ts";
import { writeCommandScript, type CommandScriptOptions } from "./script-file.ts";
import { pollForExit as genericPollForExit, type PollOptions, type PollResult } from "./poll.ts";
import { balanceOwnedPanes } from "./herdr-layout.ts";

const execFileAsync = promisify(execFile);

// ── CLI executor seam (real by default; swappable in tests) ──

/** Result of a raw `herdr` invocation, whatever its exit status. */
interface CliResult {
  stdout: string;
  /** Populated on failure: herdr writes its JSON error envelope to stderr, not stdout. */
  stderr: string;
  exitCode: number;
}

type CliRunner = (args: string[]) => CliResult;
type CliRunnerAsync = (args: string[]) => Promise<CliResult>;

function defaultCliRunner(args: string[]): CliResult {
  try {
    const stdout = execFileSync("herdr", args, { encoding: "utf8", timeout: 5000 });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error: any) {
    // herdr writes a JSON error envelope to STDERR (confirmed empirically —
    // NOT stdout, unlike its success envelopes) and exits 1 for application
    // errors (pane not found, etc.); exit 2 is a CLI syntax error. Node's
    // execFileSync captures both streams onto the thrown error.
    return {
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      exitCode: typeof error?.status === "number" ? error.status : 1,
    };
  }
}

async function defaultCliRunnerAsync(args: string[]): Promise<CliResult> {
  try {
    const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8", timeout: 5000 });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      exitCode: typeof error?.code === "number" ? error.code : 1,
    };
  }
}

let cliRunner: CliRunner = defaultCliRunner;
let cliRunnerAsync: CliRunnerAsync = defaultCliRunnerAsync;

/** Test-only seam: replace the CLI runner(s) with fakes. Returns a restore function. */
export function __setHerdrExecutorForTest__(
  sync: CliRunner,
  async: CliRunnerAsync = async (args) => sync(args),
): () => void {
  const prevSync = cliRunner;
  const prevAsync = cliRunnerAsync;
  cliRunner = sync;
  cliRunnerAsync = async;
  return () => {
    cliRunner = prevSync;
    cliRunnerAsync = prevAsync;
  };
}

// ── JSON envelope helpers ──

/**
 * Herdr's control commands (split/get/close/…) print a JSON envelope:
 * `{"result": {...}}` on stdout for success, `{"error": {"code","message"}}`
 * on **stderr** (exit 1) for failure — confirmed empirically; the two are not
 * interchangeable, unlike some CLIs that put both on stdout. `pane read` is a
 * further exception on the success side — it prints raw terminal text, not
 * JSON (see readScreen below).
 */
function parseHerdrEnvelope(result: CliResult, action: string): any {
  if (result.exitCode !== 0) {
    let parsedError: any;
    try {
      parsedError = JSON.parse(result.stderr);
    } catch {
      throw new Error(
        `herdr ${action} failed (exit ${result.exitCode}) with non-JSON stderr: ${result.stderr.slice(0, 500)}`,
      );
    }
    const code = parsedError?.error?.code ?? "unknown";
    const message = parsedError?.error?.message ?? (result.stderr.slice(0, 500) || "unknown error");
    throw new Error(`herdr ${action} failed: ${message} (${code})`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`herdr ${action} returned non-JSON output: ${result.stdout.slice(0, 500)}`);
  }
  return parsed;
}

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }
  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }
  commandAvailability.set(command, available);
  return available;
}

/**
 * True when this process is inside a Herdr-managed pane with the CLI
 * reachable. Callers that need the *selection* precedence (explicit config,
 * valid context, tmux fallback) should use terminal.ts's
 * `resolveTerminalBackend` instead of this raw availability check.
 */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID && hasCommand("herdr");
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Run pi inside a Herdr pane (HERDR_ENV=1 with a caller pane id) or set PI_SUBAGENT_TERMINAL=herdr.";
}

/**
 * Test-only override for `requireHerdr()`'s availability gate. Real
 * `isHerdrAvailable()` depends on env vars *and* the `herdr` binary actually
 * being on PATH, which unit tests should not depend on — this lets tests
 * exercise the CLI-call/JSON-parsing logic below the gate deterministically,
 * on any machine, via the CLI executor seam above. Returns a restore function.
 */
let availabilityOverride: (() => boolean) | null = null;
export function __setHerdrAvailableForTest__(value: boolean): () => void {
  const prev = availabilityOverride;
  availabilityOverride = () => value;
  return () => {
    availabilityOverride = prev;
  };
}

function requireHerdr(): void {
  const available = availabilityOverride ? availabilityOverride() : isHerdrAvailable();
  if (!available) {
    throw new Error(`Herdr is required for subagents. ${muxSetupHint()}`);
  }
}

/** The pane this extension's own host process runs in — the split anchor. */
function callerPaneId(): string | undefined {
  return process.env.HERDR_PANE_ID;
}

// ── Shell helpers ──

export { shellEscape };

// ── Surface primitives ──

const ownedPanes = new Set<string>();
let balanceTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleBalance(): void {
  if (balanceTimer) clearTimeout(balanceTimer);
  balanceTimer = setTimeout(() => {
    balanceTimer = null;
    const caller = callerPaneId();
    if (caller) void balanceOwnedPanes(caller, ownedPanes).catch(() => {
      // Cosmetic layout changes must not interrupt subagent lifecycle.
    });
  }, 120);
}

/**
 * Create a new pane for a subagent: a right split off the caller's own pane,
 * so new panes follow the agent rather than the user's focus.
 * Returns the new pane id (e.g. `w1:p3`).
 */
export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right", callerPaneId());
}

/**
 * Create a new split in the given direction from an optional source pane
 * (defaults to the caller's own pane). Returns the new pane id.
 *
 * Herdr's `pane split` only supports "right" and "down" — unlike tmux's
 * four-direction union — so "left"/"up" fail with an explicit error instead
 * of silently falling back to a different direction.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name; // Herdr panes are not named; the pi process inside shows its own title.
  requireHerdr();

  if (direction !== "right" && direction !== "down") {
    throw new Error(
      `Herdr only supports "right" and "down" pane splits (got "${direction}"). ` +
        `tmux supports all four directions; Herdr does not.`,
    );
  }

  const anchor = fromSurface ?? callerPaneId();
  if (!anchor) {
    throw new Error(
      "No Herdr anchor pane to split from (HERDR_PANE_ID is unset and no fromSurface was given).",
    );
  }

  const args = ["pane", "split", "--pane", anchor, "--direction", direction, "--no-focus"];
  const result = cliRunner(args);
  const envelope = parseHerdrEnvelope(result, "pane split");
  const paneId = envelope?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`herdr pane split returned no pane id: ${JSON.stringify(envelope)}`);
  }
  if (anchor === callerPaneId()) {
    ownedPanes.add(paneId);
    scheduleBalance();
  }
  return paneId;
}

/**
 * Send a command string to a pane and execute it.
 * `pane run` atomically submits the command text and Enter in one call —
 * unlike tmux, there's no separate literal-type + Enter step.
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  const result = cliRunner(["pane", "run", surface, command]);
  if (result.exitCode !== 0) {
    // `pane run` prints a JSON error envelope on failure (e.g. pane not
    // found); success prints nothing, so only parse when something failed.
    parseHerdrEnvelope(result, "pane run");
  }
}

/**
 * Send a long command to a pane by writing it to a script file first (same
 * rationale as tmux.ts: avoids issues with very long single-line input).
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: CommandScriptOptions,
): string {
  const scriptPath = writeCommandScript(command, options);
  sendCommand(surface, `${options?.processRun ? "exec " : ""}bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 *
 * Unlike Herdr's control commands, `pane read` prints raw terminal text on
 * success (not a JSON envelope) — only failures are JSON. `--source recent`
 * matches tmux's `capture-pane` default of recent (wrapped) scrollback.
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  const result = cliRunner([
    "pane",
    "read",
    surface,
    "--source",
    "recent",
    "--lines",
    String(Math.max(1, lines)),
    "--format",
    "text",
  ]);
  if (result.exitCode !== 0) {
    parseHerdrEnvelope(result, "pane read");
  }
  return result.stdout;
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const result = await cliRunnerAsync([
    "pane",
    "read",
    surface,
    "--source",
    "recent",
    "--lines",
    String(Math.max(1, lines)),
    "--format",
    "text",
  ]);
  if (result.exitCode !== 0) {
    parseHerdrEnvelope(result, "pane read");
  }
  return result.stdout;
}

/**
 * Close a pane. Only ever called on panes this extension created
 * (child-only cleanup) — never on the caller's own pane.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  try {
    const result = cliRunner(["pane", "close", surface]);
    parseHerdrEnvelope(result, "pane close");
  } finally {
    // An exec-wrapped process may already have closed its pane on exit.
    if (ownedPanes.delete(surface)) scheduleBalance();
  }
}

// ── Exit polling ──

export type { PollResult };

/**
 * Poll until the subagent exits. See poll.ts for the shared algorithm; this
 * just plugs in Herdr's readScreenAsync.
 *
 * Note: Herdr also exposes agent-aware idle/done/blocked states (`agent
 * get`/`agent wait`), but those are not a reliable per-message completion
 * receipt for this extension's purposes (see README). Process receipts and
 * harness-specific completion remain the source of truth, same as tmux.
 */
export function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: PollOptions,
): Promise<PollResult> {
  return genericPollForExit(surface, signal, options, readScreenAsync);
}
