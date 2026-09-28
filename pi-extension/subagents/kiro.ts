/** Native interactive Kiro CLI 2.24 V2. No ACP/headless/screen-extraction fallback. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorReceiptFile, type ProcessRun } from "./process-run.ts";
import { shellEscape } from "./shell.ts";

export const kiroHookPath = join(dirname(fileURLToPath(import.meta.url)), "plugin/hooks/kiro-lifecycle.py");
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const kiroPrompt = (task: string, token: string) => `[pi-subagent-turn:${token}] ${task}`;

export function kiroTools(tools?: string, options?: {
  spawnable?: string[]; skills?: string; sessionMode?: string; promptMode?: string; thinking?: string;
}): string[] {
  if (options?.spawnable?.length) throw new Error("Kiro cannot use Pi subagent_agents/ask_question tools.");
  if (options?.skills) throw new Error("Kiro cannot auto-load Pi skills.");
  if (options?.sessionMode && options.sessionMode !== "standalone") throw new Error("Kiro only supports standalone sessions.");
  if (options?.promptMode === "replace") throw new Error("Kiro agent prompts cannot replace the native system prompt; use append.");
  if (options?.thinking && !["low", "medium", "high", "xhigh", "max"].includes(options.thinking)) {
    throw new Error(`Kiro cannot represent thinking level ${options.thinking}.`);
  }
  if (!tools?.trim()) throw new Error("Kiro profiles require an explicit tools allowlist.");
  const mapping: Record<string, string> = { read: "fs_read", ls: "fs_read", write: "fs_write", edit: "fs_write",
    bash: "execute_bash", grep: "grep", find: "glob" };
  const parsed = tools.split(",").map((tool) => tool.trim()).filter(Boolean);
  const unknown = parsed.filter((tool) => !mapping[tool]);
  if (!parsed.length || unknown.length) throw new Error(`Kiro cannot safely map Pi tools: ${unknown.join(", ")}.`);
  // Kiro's fs_write exposes both file creation and editing. Do not silently
  // grant a write-only or edit-only Pi profile the other capability.
  if (parsed.includes("write") !== parsed.includes("edit")) throw new Error("Kiro requires write and edit together (one native fs_write tool).");
  if (parsed.includes("ls") && !parsed.includes("read")) throw new Error("Kiro requires read with ls (one native fs_read tool).");
  return [...new Set(parsed.map((tool) => mapping[tool]))];
}

export function assertKiroAvailable(): void {
  const version = execFileSync("kiro-cli", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
  if (!/^kiro-cli 2\.24\.\d+$/.test(version)) {
    throw new Error(`This Kiro adapter requires CLI 2.24.x V2; found ${version}.`);
  }
  execFileSync("python3", ["-c", "import fcntl"], { timeout: 5000, stdio: "pipe" });
}

export function validateKiroProfile(run: KiroRun): void {
  execFileSync("kiro-cli", ["agent", "validate", "--path", run.profilePath], { timeout: 5000, stdio: "pipe" });
}

export interface KiroState {
  version: 1;
  run_id: string;
  session_id: string;
  phase: "ready" | "active" | "stopped" | "untracked";
  token: string | null;
  summary?: string | null;
}
export interface KiroRun {
  id: string;
  cwd: string;
  profileName: string;
  profilePath: string;
  profileHash: string;
  createdDirs: string[];
  stateFile: string;
  configFile: string;
  expectedToken: string;
  nativeSessionId?: string;
  submittedAt: number;
  acknowledged: boolean;
  autoExit: boolean;
  pendingMessages: string[];
  quittingAt?: number;
}

/** Identity comes only from this owned session's hooks, never "latest in cwd". */
export function readKiroSessionId(sessionFile: string): string | null {
  try {
    const data = JSON.parse(readFileSync(sessionFile, "utf8"));
    return data.type === "external_session" && data.harness === "kiro" &&
      typeof data.nativeSessionId === "string" && UUID.test(data.nativeSessionId) ? data.nativeSessionId : null;
  } catch { return null; }
}

export function readKiroState(run: KiroRun): KiroState | null {
  try {
    const data = JSON.parse(readFileSync(run.stateFile, "utf8"));
    if (data.version !== 1 || data.run_id !== run.id || typeof data.session_id !== "string" || !UUID.test(data.session_id) ||
      (run.nativeSessionId && data.session_id !== run.nativeSessionId) ||
      !["ready", "active", "stopped", "untracked"].includes(data.phase) ||
      (data.token !== null && (typeof data.token !== "string" || !UUID.test(data.token)))) return null;
    if (data.phase === "stopped" && (typeof data.summary !== "string" || !data.summary.trim() || !data.token)) return null;
    return data;
  } catch { return null; }
}

/** Project instruction files Pi and Claude Code read from the working directory.
 * Kiro resolves relative `file://` resources against its workspace and reads them
 * into custom-agent context. Only regular files directly in cwd are listed: no
 * globs, `~`, absolute paths, symlinks, steering, skills or knowledge bases. */
export const kiroProjectInstructionFiles = ["AGENTS.md", "CLAUDE.md"] as const;
export function kiroProjectResources(cwd: string): string[] {
  return kiroProjectInstructionFiles.filter((file) => {
    try { return lstatSync(join(cwd, file)).isFile(); } catch { return false; }
  }).map((file) => `file://${file}`);
}

/** Owned transient workspace profile; resume reuses its saved native agent name.
 * Exclusive creation refuses collisions; no existing/global config is edited. */
export function prepareKiroRun(options: {
  artifactDir: string; processRun: ProcessRun; cwd: string; sessionFile: string; tools: string[];
  identity?: string | null; nativeSessionId?: string; nativeAgentName?: string; autoExit: boolean;
}): KiroRun {
  const root = join(options.artifactDir, "kiro-runs", options.processRun.id);
  mkdirSync(root, { recursive: true });
  const cwd = resolve(options.cwd);
  const profileName = options.nativeAgentName ?? `pi-subagent-${randomUUID()}`;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(profileName)) throw new Error("Invalid saved native Kiro agent name.");
  const run: KiroRun = {
    id: options.processRun.id, cwd, profileName,
    profilePath: join(cwd, ".kiro", "agents", `${profileName}.json`), profileHash: "", createdDirs: [],
    stateFile: join(root, "state.json"), configFile: join(root, "hook-config.json"),
    expectedToken: randomUUID(), nativeSessionId: options.nativeSessionId,
    submittedAt: Date.now(), acknowledged: false, autoExit: options.autoExit, pendingMessages: [],
  };
  try {
    for (const dir of [join(cwd, ".kiro"), join(cwd, ".kiro", "agents")]) {
      if (existsSync(dir)) {
        if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error(`Kiro profile directory must be a real local directory: ${dir}`);
      } else { mkdirSync(dir); run.createdDirs.push(dir); }
    }
    writeFileSync(run.configFile, JSON.stringify({ version: 1, run_id: run.id, cwd,
      expected_session_id: options.nativeSessionId ?? null, session_file: options.sessionFile,
      state_file: run.stateFile, error_file: errorReceiptFile(options.processRun) }), { flag: "wx", mode: 0o600 });
    const command = `python3 ${shellEscape(kiroHookPath)} ${shellEscape(run.configFile)}`;
    const profile = JSON.stringify({ name: profileName, description: "Owned Pi interactive subagent",
      prompt: options.identity ?? undefined, tools: options.tools, allowedTools: [], resources: kiroProjectResources(cwd),
      mcpServers: {}, includeMcpJson: false,
      hooks: { agentSpawn: [{ command }], userPromptSubmit: [{ command }], stop: [{ command }] } }, null, 2) + "\n";
    writeFileSync(run.profilePath, profile, { flag: "wx", mode: 0o600 });
    run.profileHash = hash(profile);
    return run;
  } catch (error) { cleanupKiroRun(run); throw error; }
}

export function cleanupKiroRun(run: KiroRun): void {
  try {
    // Never delete a profile the human changed after launch.
    if (run.profileHash && hash(readFileSync(run.profilePath, "utf8")) === run.profileHash) unlinkSync(run.profilePath);
  } catch {}
  for (const dir of [...run.createdDirs].reverse()) { try { rmdirSync(dir); } catch {} }
}

export function kiroCommand(run: KiroRun, task: string, options?: { model?: string | null; thinking?: string | null }): string {
  const args = ["kiro-cli", "chat", "--v2", "--agent", shellEscape(run.profileName), "--trust-tools=''"];
  if (run.nativeSessionId) args.push("--resume-id", shellEscape(run.nativeSessionId));
  if (options?.model) args.push("--model", shellEscape(options.model));
  if (options?.thinking) args.push("--effort", shellEscape(options.thinking));
  args.push(shellEscape(kiroPrompt(task, run.expectedToken)));
  return `cd ${shellEscape(run.cwd)} && ${args.join(" ")}`;
}

/** Drive only known-idle follow-ups, and quit gracefully so native history flushes. */
export function tickKiroRun(run: KiroRun, send: (text: string) => void, now = Date.now()): void {
  if (run.quittingAt !== undefined) {
    if (now - run.quittingAt > 15_000) throw new Error("Kiro did not exit after /quit; native resume persistence is unconfirmed.");
    return;
  }
  const state = readKiroState(run);
  if (!state) {
    if (now - run.submittedAt > 30_000) throw new Error("Kiro did not publish a valid native hook receipt within 30 seconds.");
    return;
  }
  run.nativeSessionId ??= state.session_id;
  if (state.token === run.expectedToken && (state.phase === "active" || state.phase === "stopped")) run.acknowledged = true;
  if (!run.acknowledged && now - run.submittedAt > 30_000) throw new Error("Kiro did not acknowledge the submitted turn within 30 seconds.");
  if (run.autoExit && state.phase !== "ready" &&
      (!state.token || (run.acknowledged && state.token !== run.expectedToken))) {
    throw new Error("Unexpected human input superseded the autonomous Kiro turn; refusing ambiguous completion.");
  }
  const completed = state.phase === "stopped" && state.token === run.expectedToken;
  if ((completed || state.phase === "untracked") && run.pendingMessages.length) {
    const task = run.pendingMessages.join("\n\n");
    run.expectedToken = randomUUID();
    run.submittedAt = now;
    run.acknowledged = false;
    send(kiroPrompt(task, run.expectedToken).replace(/\s*\n\s*/g, " "));
    run.pendingMessages = [];
  } else if (completed && run.autoExit) {
    run.quittingAt = now;
    send("/quit");
  }
}
