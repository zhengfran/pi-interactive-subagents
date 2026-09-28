import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeCommandScript } from "../pi-extension/subagents/script-file.ts";
import { pollForExit } from "../pi-extension/subagents/poll.ts";
import { errorReceiptFile, isProcessRunLive } from "../pi-extension/subagents/process-run.ts";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { __setHerdrExecutorForTest__, __setHerdrAvailableForTest__, sendLongCommand } from "../pi-extension/subagents/herdr.ts";
import { createStatusState } from "../pi-extension/subagents/status.ts";
import subagentDoneExtension, { runningChildrenCount } from "../pi-extension/subagents/subagent-done.ts";

async function withRun(fn: (run: { id: string; receiptFile: string }, dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-supervision-"));
  try { await fn({ id: "new-run", receiptFile: join(dir, "run.json") }, dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function receipt(run: { id: string; receiptFile: string }, exitCode?: number, id = run.id) {
  writeFileSync(run.receiptFile, JSON.stringify({ version: 1, runId: id, pid: process.pid,
    ...(exitCode === undefined ? {} : { exitCode }) }));
}

// Replays the actual failure: the CLI has exited but the narrow pane no longer
// contains an intact __SUBAGENT_DONE marker. No real agent/model calls needed.
describe("owned-run supervision", () => {
  it("delivers an exited child even when its terminal marker is mangled", async () => withRun(async (run) => {
    receipt(run, 0);
    const result = await pollForExit("w1:p2", AbortSignal.timeout(150),
      { interval: 1, processRun: run }, async () => "E_0__\nuser@host$ ");
    assert.equal(result.exitCode, 0);
    assert.equal(result.reason, "done");
  }));

  it("preserves nonzero startup/crash exit codes without a readable pane", async () => withRun(async (run) => {
    receipt(run, 127);
    const result = await pollForExit("%12", AbortSignal.timeout(150),
      { interval: 1, processRun: run }, async () => { throw new Error("pane gone"); });
    assert.equal(result.exitCode, 127);
  }));

  it("the real launch script persists its exit code (including failed cd) atomically", async () => withRun((run, dir) => {
    for (const command of ["true", "exit 23", "cd /definitely-missing-subagent-dir && true"]) {
      const path = writeCommandScript(command, { scriptPath: join(dir, "run.sh"), processRun: run });
      const child = spawnSync("bash", [path], { encoding: "utf8" });
      const data = JSON.parse(readFileSync(run.receiptFile, "utf8"));
      assert.equal(data.runId, run.id);
      assert.equal(data.exitCode, child.status);
      assert.ok(data.pid > 0);
    }
  }));

  it("rejects a stale run receipt instead of completing a resumed run", async () => withRun(async (run) => {
    receipt(run, 0, "previous-run");
    const result = await pollForExit("w1:p2", AbortSignal.timeout(150),
      { interval: 1, processRun: run, startupTimeoutMs: 5 }, async () => "__SUBAGENT_DONE_0__");
    assert.equal(result.reason, "error");
    assert.match(result.errorMessage ?? "", /start|receipt/i);
  }));

  it("reports a launch that never starts, without waiting forever", async () => withRun(async (run) => {
    const result = await pollForExit("%12", AbortSignal.timeout(150),
      { interval: 1, processRun: run, startupTimeoutMs: 5 }, async () => "shell prompt");
    assert.equal(result.reason, "error");
    assert.match(result.errorMessage ?? "", /start|receipt/i);
  }));

  it("detects SIGKILL of the real wrapper without any terminal reads", async () => withRun(async (run, dir) => {
    const path = writeCommandScript("kill -KILL $$", { scriptPath: join(dir, "killed.sh"), processRun: run });
    assert.equal(spawnSync("bash", [path]).signal, "SIGKILL");
    const result = await pollForExit("%12", AbortSignal.timeout(150), { interval: 1, processRun: run },
      async () => { assert.fail("supervised completion must not read the terminal"); });
    assert.equal(result.reason, "error");
    assert.match(result.errorMessage ?? "", /disappeared/);
  }));

  it("live processes waiting for input/children are not task-timed-out or screen-completed", async () => withRun(async (run) => {
    receipt(run);
    let ticks = 0;
    const result = await pollForExit("%12", AbortSignal.timeout(150), {
      interval: 1, processRun: run, startupTimeoutMs: 0,
      onTick() { if (++ticks === 5) receipt(run, 0); },
    }, async () => "__SUBAGENT_DONE_0__");
    assert.equal(ticks, 5);
    assert.equal(result.exitCode, 0);
  }));

  it("reports receipts lost after startup instead of parking the parent", async () => withRun(async (run) => {
    receipt(run);
    const result = await pollForExit("%12", AbortSignal.timeout(150), {
      interval: 1, processRun: run,
      onTick() { rmSync(run.receiptFile, { force: true }); },
    }, async () => "");
    assert.equal(result.reason, "error");
    assert.match(result.errorMessage ?? "", /lost its run receipt/);
  }));

  it("current-run provider errors override shell success; old session errors cannot complete a resume", async () => withRun(async (run, dir) => {
    receipt(run);
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: "old run" }));
    let ticks = 0;
    const result = await pollForExit("%12", AbortSignal.timeout(150), {
      interval: 1, processRun: run, sessionFile,
      onTick() {
        ticks++;
        writeFileSync(errorReceiptFile(run), JSON.stringify({ type: "error", errorMessage: "provider failed" }));
        receipt(run, 0);
      },
    }, async () => "");
    assert.equal(ticks, 1);
    assert.equal(result.errorMessage, "provider failed");
    assert.equal(result.exitCode, 1);
  }));

  it("rejects malformed receipts and invalid PIDs/exit codes", async () => withRun(async (run) => {
    for (const payload of ["broken JSON", JSON.stringify({ version: 1, runId: run.id, pid: 0 }),
      JSON.stringify({ version: 1, runId: run.id, pid: process.pid, exitCode: -1 })]) {
      writeFileSync(run.receiptFile, payload);
      assert.equal(isProcessRunLive(run), false);
      const result = await pollForExit("%12", AbortSignal.timeout(150),
        { interval: 1, processRun: run, startupTimeoutMs: 0 }, async () => "");
      assert.equal(result.reason, "error");
    }
  }));

  it("cancellation remains immediate for a live supervised run", async () => withRun(async (run) => {
    receipt(run);
    const controller = new AbortController();
    await assert.rejects(pollForExit("%12", controller.signal, {
      interval: 1000, processRun: run, onTick() { controller.abort(); },
    }, async () => ""), /Aborted/);
  }));

  it("never steers an exited/unknown run into a shell, and allows a verified live wrapper", async () => withRun((run) => {
    const running: any = { name: "scout", surface: "w1:p2", processRun: run };
    let writes = 0;
    const send = () => { writes++; };
    assert.ok("error" in __test__.steerSubagent(running, "unsafe in a shell", send));
    receipt(run, 0);
    assert.ok("error" in __test__.steerSubagent(running, "unsafe in a shell", send));
    assert.equal(writes, 0);
    receipt(run);
    assert.deepEqual(__test__.steerSubagent(running, "follow-up", send), { ok: true });
    running.activity = { phase: "done" };
    assert.ok("error" in __test__.steerSubagent(running, "exit race", send));
    assert.equal(writes, 1);
  }));

  it("exec replaces the owned shell, so even a racing input cannot fall through to it", async () => withRun((run, dir) => {
    const restoreAvailable = __setHerdrAvailableForTest__(true);
    let invocation = "";
    const restoreExec = __setHerdrExecutorForTest__((args) => {
      assert.deepEqual(args.slice(0, 3), ["pane", "run", "w-test:p1"]);
      invocation = args[3];
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    try {
      sendLongCommand("w-test:p1", "true", { scriptPath: join(dir, "launch.sh"), processRun: run });
      assert.match(invocation, /^exec bash /);
      const child = spawnSync("bash", ["-c", `${invocation}; printf 'FELL THROUGH'`], {
        input: "printf 'INPUT EXECUTED'\n", encoding: "utf8",
      });
      assert.equal(child.status, 0);
      assert.equal(child.stdout, "");
    } finally { restoreExec(); restoreAvailable(); }
  }));

  it("spawn and resume publish one parent result through real launch scripts, for Pi, Claude and Kiro", { timeout: 5000 }, async () => withRun(async (_run, dir) => {
    const oldCwd = process.cwd();
    const overrides: Record<string, string | undefined> = {
      PI_CODING_AGENT_DIR: join(dir, "config"), PI_SUBAGENT_TERMINAL: "herdr",
      PI_SUBAGENT_SHELL_READY_DELAY_MS: "0", HERDR_ENV: "0", HERDR_PANE_ID: "w-test:parent",
      HERDR_SOCKET_PATH: undefined, PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    };
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    process.chdir(dir);
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "config", "agents"), { recursive: true });
    for (const [agent, cli] of [["scout", "pi"], ["researcher", "claude"], ["kiro", "kiro"]]) {
      writeFileSync(join(dir, "config", "agents", `${agent}.md`),
        `---\nname: ${agent}\ncli: ${cli}\ntools: read\nauto-exit: true\n---\nTest fixture.\n`);
    }
    // These are local fake executables, not authenticated harness/model calls.
    writeFileSync(join(dir, "bin", "pi"), `#!/bin/bash\nprintf '%s\\n' '{"type":"session","id":"fake-session"}' >> "$PI_SUBAGENT_SESSION"\nprintf '%s\\n' '{"type":"message","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"fixture result"}]}}' >> "$PI_SUBAGENT_SESSION"\nexit 0\n`, { mode: 0o700 });
    writeFileSync(join(dir, "bin", "claude"), readFileSync(new URL("./fixtures/claude-cli.py", import.meta.url)), { mode: 0o700 });
    writeFileSync(join(dir, "bin", "kiro-cli"), readFileSync(new URL("./fixtures/kiro-cli.py", import.meta.url)), { mode: 0o700 });
    let launches = 0;
    const restoreAvailable = __setHerdrAvailableForTest__(true);
    const restoreExec = __setHerdrExecutorForTest__((args) => {
      if (args[1] === "split") return { stdout: JSON.stringify({ result: { pane: { pane_id: "w-test:child" } } }), stderr: "", exitCode: 0 };
      if (args[1] === "run") {
        assert.match(args[3], /^exec bash /);
        const result = spawnSync("bash", ["-c", args[3]], { encoding: "utf8", timeout: 1000 });
        assert.equal(result.status, 0, result.stderr);
        launches++;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[1] === "close") return { stdout: "", stderr: JSON.stringify({ error: { code: "not_found", message: "already exited" } }), exitCode: 1 };
      assert.fail(`Unexpected terminal read/operation: ${args}`);
    });
    const tools = new Map<string, any>();
    const handlers = new Map<string, Function>();
    const results: any[] = [];
    let delivered: (value: any) => void;
    subagentsExtension({
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
      sendMessage(message: any, options: any) { results.push({ message, options }); delivered({ message, options }); },
    } as any);
    const parentSession = join(dir, "parent.jsonl");
    writeFileSync(parentSession, JSON.stringify({ type: "session", id: "parent" }) + "\n");
    const ctx: any = { cwd: dir, ui: { setWidget() {} }, sessionManager: {
      getSessionFile: () => parentSession, getSessionId: () => "parent", getSessionDir: () => dir,
    } };
    handlers.get("session_start")!({}, ctx);
    try {
      let claudeSession = "";
      for (const agent of ["scout", "researcher", "kiro"]) {
        for (const resume of [false, true]) {
          const completion = new Promise<any>((resolve) => { delivered = resolve; });
          const tool = tools.get(resume ? "subagent_message" : "subagent");
          const params = resume ? { name: agent, message: "follow-up" } : { name: agent, agent, task: "fixture" };
          const ack = await tool.execute("test-call", params, new AbortController().signal, undefined, ctx);
          assert.equal(ack.details.status, "started", JSON.stringify(ack));
          const result = await completion;
          assert.equal(result.message.customType, "subagent_result");
          assert.equal(result.message.details.exitCode, 0, result.message.content);
          assert.deepEqual(result.options, { triggerTurn: true, deliverAs: "steer" });
          assert.equal(runningChildrenCount(), 0);
          const script = readFileSync(ack.details.launchScriptFile, "utf8");
          assert.match(script, /trap .*EXIT/);
          if (agent === "scout") assert.match(script, /PI_SUBAGENT_EXIT_FILE=/);
          if (agent === "researcher") {
            assert.match(script, resume ? /--resume '[0-9a-f-]{36}'/ : /--session-id '[0-9a-f-]{36}'/);
            assert.match(result.message.content, /Claude fixture result/);
            assert.match(result.message.details.sessionId, /^[0-9a-f-]{36}$/);
            if (resume) assert.equal(result.message.details.sessionId, claudeSession);
            claudeSession = result.message.details.sessionId;
          }
          if (agent === "kiro" || agent === "researcher") {
            // Native harnesses get the same blank-session wrapper as Pi on spawn, and the raw message on resume.
            const wrapped = /Complete your task autonomously\.[\s\S]*fixture[\s\S]*Your FINAL assistant message should summarize/;
            if (resume) assert.doesNotMatch(script, wrapped); else assert.match(script, wrapped);
          }
          if (agent === "kiro") {
            assert.match(script, /kiro-cli chat --v2/);
            assert.match(result.message.content, /Kiro fixture result/);
            if (resume) assert.match(script, /--resume-id/);
          }
        }
      }
      assert.equal(launches, 6);
      assert.equal(results.length, 6);
    } finally {
      handlers.get("session_shutdown")!({}, ctx);
      restoreExec(); restoreAvailable();
      process.chdir(oldCwd);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      // Restore a fresh module scope for later watcher tests.
      handlers.get("session_start")!({}, ctx);
    }
  }));

  it("clears the nested running-child latch and preserves the result when a finished pane is already gone", async () => withRun(async (run, dir) => {
    const restoreAvailable = __setHerdrAvailableForTest__(true);
    const restoreExec = __setHerdrExecutorForTest__(() => ({ stdout: "", exitCode: 1,
      stderr: JSON.stringify({ error: { code: "not_found", message: "pane already exited" } }) }));
    const oldAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    const oldActivity = process.env.PI_SUBAGENT_ACTIVITY_FILE;
    delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    const handlers = new Map<string, Function>();
    let shutdowns = 0;
    subagentDoneExtension({ on: (name: string, fn: Function) => handlers.set(name, fn),
      registerTool() {}, registerShortcut() {} } as any);
    const event = { messages: [{ role: "assistant", stopReason: "stop" }] };
    const ctx = { shutdown() { shutdowns++; } };
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "child" }) + "\n" +
      JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop",
        content: [{ type: "text", text: "actual scout summary" }] } }) + "\n");
    const running: any = { id: run.id, name: "scout", task: "map package", surface: "w-test:p1", sessionFile,
      processRun: run, startTime: Date.now(), interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }) };
    try {
      __test__.runningSubagents.set(run.id, running);
      assert.equal(runningChildrenCount(), 1);
      handlers.get("agent_end")!(event, ctx);
      assert.equal(shutdowns, 0);
      receipt(run, 0);
      const result = await __test__.watchSubagent(running, new AbortController().signal);
      assert.equal(result.summary, "actual scout summary");
      assert.equal(result.exitCode, 0);
      assert.equal(runningChildrenCount(), 0);
      handlers.get("agent_end")!(event, ctx);
      assert.equal(shutdowns, 1);
    } finally {
      __test__.runningSubagents.clear();
      if (oldAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
      else process.env.PI_SUBAGENT_AUTO_EXIT = oldAutoExit;
      if (oldActivity === undefined) delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
      else process.env.PI_SUBAGENT_ACTIVITY_FILE = oldActivity;
      restoreExec(); restoreAvailable();
    }
  }));
});
