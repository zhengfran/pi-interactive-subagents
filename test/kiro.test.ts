import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { cleanupKiroRun, kiroCommand, kiroHookPath, kiroProjectResources, kiroPrompt, kiroTools, prepareKiroRun,
  readKiroSessionId, readKiroState, tickKiroRun, type KiroRun } from "../pi-extension/subagents/kiro.ts";
import { errorReceiptFile } from "../pi-extension/subagents/process-run.ts";
import { __test__ } from "../pi-extension/subagents/index.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";
const otherId = "33333333-3333-4333-8333-333333333333";
function fixture(fn: (f: { dir: string; run: KiroRun; sessionFile: string; errorFile: string }) => void) {
  const dir = mkdtempSync(join(tmpdir(), "kiro-native-test-"));
  const sessionFile = join(dir, "session.jsonl");
  const processRun = { id: "run-one", receiptFile: join(dir, "process.json") };
  writeFileSync(sessionFile, JSON.stringify({ type: "external_session", harness: "kiro", nativeSessionId: null }));
  const run = prepareKiroRun({ artifactDir: dir, processRun, cwd: dir, sessionFile, tools: ["fs_read"], autoExit: true });
  try { fn({ dir, run, sessionFile, errorFile: errorReceiptFile(processRun) }); }
  finally { cleanupKiroRun(run); rmSync(dir, { recursive: true, force: true }); }
}
function hook(run: KiroRun, kind: string, fields: Record<string, unknown> = {}, expectFailure = false) {
  const child = spawnSync("python3", [kiroHookPath, run.configFile], { encoding: "utf8", timeout: 2000,
    input: JSON.stringify({ hook_event_name: kind, cwd: run.cwd, session_id: sessionId, ...fields }) });
  assert.equal(child.status, expectFailure ? 1 : 0, child.stderr);
  assert.equal(child.stdout, "", "hook stdout must not inject receipt/context into the model");
}
function complete(run: KiroRun, text = "native answer") {
  hook(run, "userPromptSubmit", { prompt: kiroPrompt("task", run.expectedToken) });
  hook(run, "stop", { assistant_response: text });
}

describe("Kiro native V2 adapter", () => {
  it("maps only explicit representable tools and rejects unsupported Pi capabilities", () => {
    assert.deepEqual(kiroTools("read,grep,find,ls,read"), ["fs_read", "grep", "glob"]);
    assert.deepEqual(kiroTools("write,edit,bash"), ["fs_write", "execute_bash"]);
    for (const tools of [undefined, "", ",", "safe_bash", "ask_question", "web_search", "write", "edit", "ls"]) {
      assert.throws(() => kiroTools(tools));
    }
    for (const options of [{ spawnable: ["scout"] }, { skills: "web" }, { sessionMode: "fork" },
      { promptMode: "replace" }, { thinking: "off" }]) assert.throws(() => kiroTools("read", options));
  });

  it("creates isolated profiles without global MCP or automatic tool trust", () => fixture(({ run }) => {
    const profile = JSON.parse(readFileSync(run.profilePath, "utf8"));
    assert.deepEqual(profile.tools, ["fs_read"]);
    assert.deepEqual(profile.allowedTools, []);
    assert.equal(profile.includeMcpJson, false);
    assert.deepEqual(Object.keys(profile.hooks), ["agentSpawn", "userPromptSubmit", "stop"]);
    const command = kiroCommand(run, "task", { model: "native-model", thinking: "high" });
    assert.match(command, /kiro-cli chat --v2/);
    assert.match(command, /--trust-tools=''/);
    assert.doesNotMatch(command, /trust-all|no-interactive|stream-json|acp|--resume /);
    run.nativeSessionId = sessionId;
    assert.match(kiroCommand(run, "again"), new RegExp(`--resume-id '${sessionId}'`));
  }));

  it("extracts exact native stop response and native identity from observed V2 payloads", () => fixture(({ run, sessionFile }) => {
    hook(run, "agentSpawn");
    assert.equal(readKiroSessionId(sessionFile), sessionId);
    assert.equal(readKiroState(run)?.phase, "ready");
    complete(run, "KIRO_NATIVE_ONE");
    assert.equal(readKiroState(run)?.summary, "KIRO_NATIVE_ONE");
    assert.equal(readKiroState(run)?.token, run.expectedToken);
  }));

  it("never attributes overlapping submissions to the wrong turn", () => fixture(({ run, errorFile }) => {
    hook(run, "userPromptSubmit", { prompt: kiroPrompt("first", run.expectedToken) });
    hook(run, "userPromptSubmit", { prompt: kiroPrompt("second", otherId) }, true);
    assert.match(JSON.parse(readFileSync(errorFile, "utf8")).errorMessage, /overlapping prompts/);
    assert.equal(readKiroState(run)?.token, run.expectedToken);
  }));

  it("rejects missing result, wrong session, wrong cwd, and malformed events as explicit failures", () => {
    for (const fields of [{ assistant_response: "" }, { session_id: otherId }, { cwd: "/different" }, { session_id: null }]) {
      fixture(({ run, errorFile }) => {
        hook(run, "userPromptSubmit", { prompt: kiroPrompt("task", run.expectedToken) });
        hook(run, "stop", fields, true);
        assert.equal(JSON.parse(readFileSync(errorFile, "utf8")).type, "error");
        assert.notEqual(readKiroState(run)?.phase, "stopped");
      });
    }
  });

  it("a resumed launch must hook the exact saved UUID", () => fixture(({ run, errorFile }) => {
    const config = JSON.parse(readFileSync(run.configFile, "utf8"));
    writeFileSync(run.configFile, JSON.stringify({ ...config, expected_session_id: otherId }));
    hook(run, "agentSpawn", {}, true);
    assert.match(readFileSync(errorFile, "utf8"), /different session/);
  }));

  it("duplicate Stop and untagged human turns cannot reuse a prior completion", () => fixture(({ run }) => {
    complete(run, "first");
    hook(run, "stop", { assistant_response: "duplicate" });
    assert.equal(readKiroState(run)?.summary, "first");
    hook(run, "userPromptSubmit", { prompt: "human input without marker" });
    hook(run, "stop", { assistant_response: "unrelated answer" });
    assert.equal(readKiroState(run)?.phase, "untracked");
    assert.equal(readKiroState(run)?.token, null);
    assert.throws(() => tickKiroRun(run, () => assert.fail("must not send")), /ambiguous completion/);
  }));

  it("serializes queued live follow-ups after Stop and quits only after the latest result", () => fixture(({ run }) => {
    const sent: string[] = [];
    hook(run, "userPromptSubmit", { prompt: kiroPrompt("task", run.expectedToken) });
    run.pendingMessages.push("follow-up", "extra detail");
    tickKiroRun(run, (text) => sent.push(text));
    assert.deepEqual(sent, []);
    const oldToken = run.expectedToken;
    hook(run, "stop", { assistant_response: "first result" });
    tickKiroRun(run, (text) => sent.push(text));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /follow-up extra detail/);
    assert.notEqual(run.expectedToken, oldToken);
    tickKiroRun(run, (text) => sent.push(text));
    assert.equal(sent.length, 1, "old receipt cannot finish the follow-up");
    complete(run, "follow-up result");
    tickKiroRun(run, (text) => sent.push(text));
    assert.equal(sent[1], "/quit");
    tickKiroRun(run, (text) => sent.push(text));
    assert.equal(sent.length, 2, "only one graceful quit");
    assert.throws(() => tickKiroRun(run, () => {}, run.quittingAt! + 15_001), /did not exit/);
  }));

  it("interactive profiles remain open, but hook/submission loss has a bounded failure", () => fixture(({ run }) => {
    assert.throws(() => tickKiroRun(run, () => {}, run.submittedAt + 30_001), /valid native hook receipt/);
    hook(run, "agentSpawn");
    assert.throws(() => tickKiroRun(run, () => {}, run.submittedAt + 30_001), /acknowledge/);
    run.autoExit = false;
    complete(run);
    tickKiroRun(run, () => assert.fail("interactive profiles must not auto-quit"));
  }));

  it("keeps concurrent same-cwd sessions separate and rejects corrupt/stale state", () => fixture(({ dir, run }) => {
    complete(run);
    const secondSession = join(dir, "second.jsonl");
    writeFileSync(secondSession, JSON.stringify({ type: "external_session", harness: "kiro", nativeSessionId: null }));
    const other = prepareKiroRun({ artifactDir: dir, processRun: { id: "run-two", receiptFile: join(dir, "other-process.json") },
      cwd: dir, sessionFile: secondSession, tools: ["fs_read"], autoExit: true });
    try {
      assert.notEqual(run.profilePath, other.profilePath);
      assert.notEqual(run.stateFile, other.stateFile);
      writeFileSync(other.stateFile, readFileSync(run.stateFile));
      assert.equal(readKiroState(other), null);
      writeFileSync(other.stateFile, "invalid json");
      assert.equal(readKiroState(other), null);
    } finally { cleanupKiroRun(other); }
  }));

  it("removes only unchanged owned profiles, preserving existing dirs and human edits", () => fixture(({ run }) => {
    writeFileSync(run.profilePath, "human edit");
    cleanupKiroRun(run);
    assert.equal(readFileSync(run.profilePath, "utf8"), "human edit");
    assert.ok(existsSync(dirname(run.profilePath)));
  }));

  it("does not follow .kiro symlinks into global configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiro-symlink-test-"));
    mkdirSync(join(dir, "global"));
    symlinkSync(join(dir, "global"), join(dir, ".kiro"));
    try {
      assert.throws(() => prepareKiroRun({ artifactDir: dir, cwd: dir, sessionFile: join(dir, "s.json"), tools: ["fs_read"],
        processRun: { id: "run", receiptFile: join(dir, "p.json") }, autoExit: true }), /real local directory/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("message tool queues Kiro input instead of injecting text during an active turn", () => fixture(({ run }) => {
    const running: any = { id: run.id, name: "kiro", surface: "fake:p1", cli: "kiro", kiro: run };
    __test__.runningSubagents.set(run.id, running);
    try {
      const result = __test__.handleSubagentSteer({ name: "kiro", message: "next" }, () => assert.fail("must queue"), () => true);
      assert.equal(result.details.status, "queued");
      assert.deepEqual(run.pendingMessages, ["next"]);
      run.quittingAt = Date.now();
      assert.ok(__test__.handleSubagentSteer({ name: "kiro", message: "too late" }, () => {}, () => true).details.error);
    } finally { __test__.runningSubagents.clear(); }
  }));

  it("gives profiles only regular project instruction files from cwd, never global context", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiro-resources-test-"));
    const processRun = { id: "run", receiptFile: join(dir, "p.json") };
    const prepare = () => prepareKiroRun({ artifactDir: join(dir, "artifacts"), cwd: dir, sessionFile: join(dir, "s.json"),
      tools: ["fs_read"], processRun, autoExit: true });
    try {
      assert.deepEqual(kiroProjectResources(dir), []);
      writeFileSync(join(dir, "AGENTS.md"), "project rules");
      mkdirSync(join(dir, "global"));
      writeFileSync(join(dir, "global", "CLAUDE.md"), "global rules");
      // A symlink could point at global/home config; only regular files qualify.
      symlinkSync(join(dir, "global", "CLAUDE.md"), join(dir, "CLAUDE.md"));
      assert.deepEqual(kiroProjectResources(dir), ["file://AGENTS.md"]);
      rmSync(join(dir, "CLAUDE.md"));
      mkdirSync(join(dir, "CLAUDE.md"));
      assert.deepEqual(kiroProjectResources(dir), ["file://AGENTS.md"]);
      rmSync(join(dir, "CLAUDE.md"), { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), "claude rules");
      const run = prepare();
      try {
        const profile = JSON.parse(readFileSync(run.profilePath, "utf8"));
        assert.deepEqual(profile.resources, ["file://AGENTS.md", "file://CLAUDE.md"]);
        assert.deepEqual(profile.mcpServers, {});
        assert.equal(profile.includeMcpJson, false);
        assert.deepEqual(profile.allowedTools, []);
        assert.deepEqual(profile.tools, ["fs_read"]);
        assert.equal(profile.includePowers, undefined);
        // No steering, skills, knowledge bases, home-relative, absolute or glob resources.
        for (const resource of profile.resources) {
          assert.match(resource, /^file:\/\/[A-Z]+\.md$/);
        }
      } finally { cleanupKiroRun(run); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("wraps the initial Kiro task with the same autonomous-mode and summary instructions as Pi and Claude", () => {
    const autonomous = __test__.buildSubagentTask("do the thing", { autoExit: true });
    assert.equal(autonomous, "\n\nComplete your task autonomously. When you are finished, simply stop — your session ends automatically." +
      "\n\ndo the thing\n\nYour FINAL assistant message should summarize what you accomplished.");
    assert.equal(__test__.buildSubagentTask("do the thing", { autoExit: true, roleBlock: "\n\nYou are X." }),
      `\n\nYou are X.${autonomous}`);
    assert.match(__test__.buildSubagentTask("t", { autoExit: false }), /user can interact[\s\S]*before the user exits/);
    assert.equal(__test__.buildSubagentTask("raw", { autoExit: true, inheritsConversationContext: true }), "raw");
    // The token-tagged prompt stays correlatable by the lifecycle hook.
    assert.match(kiroPrompt(autonomous, sessionId), /^\[pi-subagent-turn:[0-9a-f-]{36}\]\s/);
  });
});

describe("bundled native worker profiles", () => {
  const read = (name: string) => readFileSync(new URL(`../agents/${name}.md`, import.meta.url), "utf8")
    .replace(/^---\n[\s\S]*?\n---\n*/, "");
  const core = [
    "You operate in an isolated context — you have no knowledge of any prior conversation. All necessary context will be provided in the task description.",
    "Do not announce that you are finishing; just produce the answer.",
    "- Read files before editing to understand existing code",
    "- Make targeted edits, not wholesale rewrites",
    "- If something fails, diagnose and fix it",
    "- Your FINAL assistant message should summarize what you did and what changed",
    "## Changes Made", "## Verification", "## Notes",
  ];

  it("share the Pi worker's core instructions and final format", () => {
    const worker = read("worker");
    for (const name of ["claude-worker", "kiro-worker"]) {
      const body = read(name);
      for (const line of core) {
        assert.ok(worker.includes(line), `worker.md drifted from native core: ${line}`);
        assert.ok(body.includes(line), `${name} is missing core instruction: ${line}`);
      }
      assert.match(body, /work autonomously/);
      assert.match(body, /Keep native permission prompts for human approval/);
      assert.match(body, /report the blocker/);
    }
    assert.equal(read("claude-worker"), read("kiro-worker"), "native worker bodies should not drift apart");
  });

  it("do not claim Pi-only capabilities", () => {
    for (const name of ["claude-worker", "kiro-worker"]) {
      const body = read(name);
      assert.doesNotMatch(body, /ask_question|web_search|fetch_content|get_search_content|source_check|subagent|scout|researcher|skill/i);
    }
  });
});
