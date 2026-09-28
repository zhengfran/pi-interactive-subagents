/** Durable process supervision, independent of the terminal and agent harness. */
import { readFileSync } from "node:fs";
import { shellEscape } from "./shell.ts";

export interface ProcessRun {
  id: string;
  receiptFile: string;
}

export interface ProcessReceipt {
  version: 1;
  runId: string;
  /** PID of the dedicated, non-interactive launch wrapper (not a shell prompt). */
  pid: number;
  exitCode?: number;
}

export function errorReceiptFile(run: ProcessRun): string {
  return `${run.receiptFile}.error`;
}

export function readProcessReceipt(run: ProcessRun): ProcessReceipt | null {
  try {
    const data = JSON.parse(readFileSync(run.receiptFile, "utf8"));
    if (data?.version !== 1 || data.runId !== run.id || !Number.isInteger(data.pid) || data.pid <= 0 ||
        (data.exitCode !== undefined && (!Number.isInteger(data.exitCode) || data.exitCode < 0 || data.exitCode > 255))) {
      return null;
    }
    return data;
  } catch { return null; }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

export function isProcessRunLive(run: ProcessRun | undefined): boolean {
  if (!run) return false;
  const receipt = readProcessReceipt(run);
  return !!receipt && receipt.exitCode === undefined && isProcessAlive(receipt.pid);
}

/**
 * Persist startup + process exit atomically, even for failed cd/CLI startup.
 * Run via `exec bash script`, not `bash script`: once the native TUI exits there
 * must never be an outer interactive shell to interpret a racing steer message.
 * The wrapper reads commands from its script, never from terminal stdin.
 */
export function supervisedCommand(command: string, run: ProcessRun): string {
  const prefix = JSON.stringify({ version: 1, runId: run.id }).slice(0, -1) + ",";
  return [
    "__pi_write_receipt() (",
    "  umask 077",
    `  printf '%s"pid":%s%s}\\n' ${shellEscape(prefix)} "$$" "$1" > ${shellEscape(run.receiptFile + ".tmp")} &&`,
    `    mv -f -- ${shellEscape(run.receiptFile + ".tmp")} ${shellEscape(run.receiptFile)}`,
    ")",
    `trap '__pi_exit=$?; __pi_write_receipt ",\\\"exitCode\\\":$__pi_exit"; exit "$__pi_exit"' EXIT`,
    '__pi_write_receipt "" || exit 125',
    command,
  ].join("\n");
}
