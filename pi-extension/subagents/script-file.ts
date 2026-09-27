/**
 * Long-command script staging, shared by every terminal backend.
 *
 * Typing a very long command straight into a terminal breaks on line-wrapping
 * in some multiplexers/terminals, so long commands are instead written to a
 * small bash script and executed with `bash <path>`. Both tmux.ts and
 * herdr.ts stage the script the same way; only how the resulting `bash …`
 * invocation is delivered to the pane differs per backend.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Write `command` (optionally preceded by a preamble comment block) to a
 * script file and return its path. By default the script goes to a temp
 * directory, but callers can pass a stable path (e.g. under session
 * artifacts) so the exact invocation is preserved for debugging.
 */
export function writeCommandScript(
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });

  return scriptPath;
}
