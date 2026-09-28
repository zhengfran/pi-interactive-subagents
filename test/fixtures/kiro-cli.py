#!/usr/bin/env python3
"""Offline Kiro stand-in for launch/resume wiring; never contacts a model."""
import json
import pathlib
import subprocess
import sys

if sys.argv[1:] == ["--version"]:
    print("kiro-cli 2.24.0")
    sys.exit(0)

args = sys.argv[1:]
if args[:3] == ["agent", "validate", "--path"]:
    json.loads(pathlib.Path(args[3]).read_text())
    sys.exit(0)
assert args[:2] == ["chat", "--v2"]
assert "--trust-all-tools" in args and not any(arg.startswith("--trust-tools") for arg in args)
assert "--no-interactive" not in args
name = args[args.index("--agent") + 1]
saved = pathlib.Path(".fake-kiro-session.json")
sid = "11111111-1111-4111-8111-111111111111"
if "--resume-id" in args:
    native = json.loads(saved.read_text())
    assert args[args.index("--resume-id") + 1] == native["session_id"]
    # Actual Kiro restores the saved agent, ignoring a different --agent.
    assert name == native["name"], "resume must recreate the original agent profile"
else:
    saved.write_text(json.dumps({"session_id": sid, "name": name}))
profile = json.loads((pathlib.Path(".kiro/agents") / (name + ".json")).read_text())
assert profile["tools"] == ["fs_read"]
assert profile["allowedTools"] == []
assert profile["includeMcpJson"] is False
for kind, extra in [("agentSpawn", {}), ("userPromptSubmit", {"prompt": args[-1]}),
                    ("stop", {"assistant_response": "Kiro fixture result"})]:
    payload = {"hook_event_name": kind, "cwd": str(pathlib.Path.cwd()), "session_id": sid, **extra}
    for hook in profile["hooks"][kind]:
        result = subprocess.run(hook["command"], shell=True, input=json.dumps(payload), text=True, capture_output=True)
        assert result.returncode == 0, result.stderr
        assert result.stdout == ""
# Model nothing; exit like a human closing a completed interactive session.
