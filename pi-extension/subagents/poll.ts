/** Backend-independent completion supervision. New launches use durable receipts;
 * screen sentinels are compatibility-only for older callers without a ProcessRun. */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { errorReceiptFile, isProcessAlive, readProcessReceipt, type ProcessRun } from "./process-run.ts";

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

export interface PollOptions {
  interval: number;
  sessionFile?: string;
  sentinelFile?: string;
  processRun?: ProcessRun;
  /** Launch acknowledgement deadline, not a task-duration/idle timeout. */
  startupTimeoutMs?: number;
  isComplete?: () => boolean;
  onTick?: (elapsed: number) => void;
}

/** Error sidecars describe harness errors even when the process exits zero. */
export function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

function readExitSidecar(options: PollOptions): PollResult | null {
  const path = options.processRun ? errorReceiptFile(options.processRun)
    : options.sessionFile ? `${options.sessionFile}.exit` : undefined;
  if (!path) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    rmSync(path, { force: true });
    return interpretExitSidecar(data);
  } catch { return null; }
}

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: PollOptions,
  readScreenAsync: (surface: string, lines?: number) => Promise<string>,
): Promise<PollResult> {
  const start = Date.now();
  let missingScreenReads = 0;
  let unhealthyReads = 0;
  let started = false;
  const failure = (errorMessage: string): PollResult => ({ reason: "error", exitCode: 1, errorMessage });

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    const sidecar = readExitSidecar(options);
    if (sidecar) return sidecar;
    // Harness-specific native session/turn correlation (e.g. Claude Stop).
    if (options.isComplete?.()) return { reason: "done", exitCode: 0 };

    if (options.processRun) {
      const receipt = readProcessReceipt(options.processRun);
      if (receipt) {
        started = true;
        if (receipt.exitCode !== undefined) {
          // The harness may have written its diagnostic between our first
          // sidecar check and the wrapper's final atomic rename.
          return readExitSidecar(options) ?? { reason: "done", exitCode: receipt.exitCode };
        }
        if (isProcessAlive(receipt.pid)) unhealthyReads = 0;
        else unhealthyReads++;
      } else if (started) {
        unhealthyReads++;
      }
      // SIGKILL/missing receipt cannot park a nested parent forever. Allow two
      // intervening reads for the exit trap/atomic rename to finish before failing.
      if (unhealthyReads >= 3) {
        return failure(`Subagent process ${surface} disappeared or lost its run receipt without reporting an exit.`);
      }
      if (!started && Date.now() - start >= (options.startupTimeoutMs ?? 30_000)) {
        return failure(`Subagent ${surface} did not acknowledge startup with a valid run receipt within the launch deadline.`);
      }
      // Never parse screen text for supervised runs: narrow-pane wrapping,
      // scrollback loss, and old/fabricated markers cannot affect completion.
    } else {
      if (options.sentinelFile && existsSync(options.sentinelFile)) {
        return { reason: "sentinel", exitCode: 0 };
      }
      try {
        const screen = await readScreenAsync(surface, 5);
        missingScreenReads = 0;
        const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
        if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      } catch {
        const sidecar = readExitSidecar(options);
        if (sidecar) return sidecar;
        if (++missingScreenReads >= 3) return failure(`Subagent pane ${surface} is unavailable.`);
      }
    }

    options.onTick?.(Math.floor((Date.now() - start) / 1000));
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
