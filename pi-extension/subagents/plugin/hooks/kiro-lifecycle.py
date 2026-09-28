#!/usr/bin/env python3
"""Kiro CLI 2.24 V2 hooks: locked, atomic native-session/turn receipts.

Stop carries assistant_response but no turn ID. Accept only one outstanding
prompt; overlapping/ambiguous native events fail closed rather than assigning
an old response to a newer prompt. The parent serializes its own follow-ups.
"""
import fcntl
import json
import os
import re
import sys
import tempfile

UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
TOKEN = re.compile(r"^\[pi-subagent-turn:([0-9a-f-]{36})\](?:\s|$)")


def atomic(path, value):
    directory = os.path.dirname(path)
    fd, temp = tempfile.mkstemp(prefix="kiro-hook-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            json.dump(value, stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def main(config):
    event = json.load(sys.stdin)
    session = event.get("session_id")
    if not isinstance(session, str) or not UUID.fullmatch(session):
        raise ValueError("missing/invalid native session ID")
    if os.path.realpath(event.get("cwd", "")) != os.path.realpath(config["cwd"]):
        raise ValueError("hook cwd differs from the owned launch cwd")
    expected = config.get("expected_session_id")
    if expected and session != expected:
        raise ValueError("native resume opened a different session")

    with open(config["state_file"] + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(config["state_file"], encoding="utf8") as stream:
                state = json.load(stream)
        except FileNotFoundError:
            state = {"version": 1, "run_id": config["run_id"], "session_id": session,
                     "phase": "ready", "token": None}
        if state.get("run_id") != config["run_id"] or state.get("session_id") != session:
            raise ValueError("hook run/session identity changed")
        with open(config["session_file"], encoding="utf8") as stream:
            identity = json.load(stream)
        if identity.get("harness") != "kiro" or identity.get("nativeSessionId") not in (None, session):
            raise ValueError("stored native session identity disagrees")
        identity["nativeSessionId"] = session
        atomic(config["session_file"], identity)

        kind = event.get("hook_event_name")
        if kind == "agentSpawn":
            if state["phase"] == "active":
                raise ValueError("agent changed during an outstanding turn")
        elif kind == "userPromptSubmit":
            if state["phase"] == "active":
                raise ValueError("overlapping prompts: stop result cannot be correlated safely")
            prompt = event.get("prompt")
            if not isinstance(prompt, str):
                raise ValueError("prompt hook has no prompt string")
            match = TOKEN.match(prompt)
            token = match.group(1) if match else None
            state = {**state, "phase": "active", "token": token, "summary": None}
        elif kind == "stop":
            if state["phase"] != "active":
                return  # duplicate/late Stop without a submitted turn
            if not state["token"]:
                state = {**state, "phase": "untracked", "summary": None}
            else:
                summary = event.get("assistant_response")
                if not isinstance(summary, str) or not summary.strip():
                    raise ValueError("Stop hook has no non-empty assistant_response")
                state = {**state, "phase": "stopped", "summary": summary.strip()}
        else:
            raise ValueError("unexpected hook event")
        atomic(config["state_file"], state)


if __name__ == "__main__":
    config = None
    try:
        with open(sys.argv[1], encoding="utf8") as stream:
            config = json.load(stream)
        main(config)
    except Exception as error:
        # No stdout: prompt hook stdout would become model context.
        message = "Kiro lifecycle hook: " + str(error)
        if config:
            try:
                atomic(config["error_file"], {"type": "error", "errorMessage": message})
            except OSError:
                pass
        print(message, file=sys.stderr)
        sys.exit(1)
