"""Offline popup frames, with resolver startup held behind a gate."""
import json
import os
import pty
import re
import select
import shutil
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT, BASH, NODE = map(Path, sys.argv[1:])
ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")


class Popup:
    def __init__(self, env, root=ROOT):
        self.output = b""
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execve(str(BASH), [str(BASH), "-c", '\"$1\" \"$2\" --render; printf "\\n__PICKER_EXIT__\\n"', "picker-test", str(BASH), str(root / "bin/e2b-popup")], env)

    def read(self, seconds=.1):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([self.fd], [], [], .02)[0]:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                self.output += data
        return ANSI.sub(b"", self.output).decode(errors="replace")

    def until(self, text, timeout=5):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if text in self.read(.03):
                return
        raise AssertionError("missing %r in %r" % (text, self.read()))

    def keys(self, value):
        os.write(self.fd, value)

    def close(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(self.fd)
        # Some macOS PTYs leave an exiting process unreaped past the deadline.
        os.waitpid(self.pid, os.WNOHANG)


with tempfile.TemporaryDirectory(prefix="picker-cache-") as tmp:
    tmp = Path(tmp).resolve()
    repo, config, state = (tmp / name for name in ("repo", "config", "state"))
    for directory in (repo, config, state):
        directory.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    gate = tmp / "gate"
    node = tmp / "node"
    node.write_text('#!/bin/sh\nwhile [ ! -f "$PICKER_GATE" ]; do sleep 0.01; done\nexec %s "$@"\n' % shlex.quote(str(NODE)))
    node.chmod(0o755)
    calls = tmp / "calls"
    herdr = tmp / "herdr"
    herdr.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$PICKER_CALLS"\n')
    herdr.chmod(0o755)
    env = dict(os.environ, HERDR_E2B_NODE=str(node), HERDR_BIN_PATH=str(herdr),
               PICKER_GATE=str(gate), PICKER_CALLS=str(calls), HERDR_PLUGIN_STATE_DIR=str(state),
               HERDR_PLUGIN_CONFIG_DIR=str(config), HERDR_PLUGIN_CONTEXT_JSON="", E2B_TEMPLATE="",
               E2B_PICK_CWD=str(repo), E2B_POPUP_MODE="pick-box", E2B_DASH_ORIGIN_PANE="w1:p1")

    def configure(names):
        (config / "config.toml").write_text('[sandbox]\ntemplate="base"\ntemplates=%s\n' % json.dumps(names))

    def cache():
        return next(state.rglob("input"))

    def run_case(name, fn):
        try:
            detail = fn()
            print("OK " + name + (" (%s)" % detail if detail else ""), flush=True)
        except Exception as error:
            print("FAIL " + name + ": " + str(error), flush=True)

    def cold():
        configure(["base", "claude", "codex"])
        p = Popup(env)
        try:
            assert "E2B template for" not in p.read(.3)
            gate.touch()
            p.until("E2B template for")
            p.keys(b"q")
            p.read(.3)
            assert b"claude\ncodex" in cache().read_bytes()
        finally:
            p.close()
    run_case("picker without cache keeps the resolver-first path and writes input", cold)

    def hit():
        gate.unlink(missing_ok=True)
        p = Popup(env)
        try:
            p.until("E2B template for", 1)
            assert "claude" in p.read()
            p.keys(b"q")
            p.read(.3)
            assert not list((state / "pickers").glob("refresh.*")), "abort left its refresh directory"
            assert not calls.exists(), "abort contacted Herdr"
        finally:
            gate.touch()
            p.close()
    run_case("picker cache paints before a blocked Node starts resolving", hit)

    def stale():
        configure(["base", "grok"])
        gate.unlink(missing_ok=True)
        p = Popup(env)
        try:
            p.until("E2B template for", 1)
            assert "claude" in p.read()
            p.keys(b"\r")
            assert not calls.exists(), "cached answer launched before refresh"
            gate.touch()
            p.until("grok")
            assert not calls.exists(), "changed rows accepted a stale confirmation"
            assert b"base\ngrok" in cache().read_bytes()
            assert b"base\nclaude\ncodex" not in cache().read_bytes()
            assert p.output.count(b"\x1b[2J") == 1, "refresh cleared the screen"
            p.keys(b"q")
            p.read(.3)
        finally:
            gate.touch()
            p.close()
    run_case("stale picker rows refresh in place without a keystroke", stale)

    def settled():
        p = Popup(dict(env, E2B_TEMPLATE="codex"))
        try:
            end = time.monotonic() + 5
            while not calls.exists() and time.monotonic() < end:
                p.read(.05)
            assert "E2B_TEMPLATE=codex" in calls.read_text()
            assert "E2B template for" not in p.read()
        finally:
            p.close()
    run_case("settled template hands off without painting a picker", settled)

    def branch():
        calls.unlink(missing_ok=True)
        configure(["base", "claude"])
        with (config / "config.toml").open("a") as f:
            f.write('\n[[sandbox.template_rules]]\npattern=".*"\ntemplate="codex"\n')
        p = Popup(env)
        try:
            end = time.monotonic() + 5
            while not calls.exists() and time.monotonic() < end:
                p.read(.05)
            assert calls.exists(), p.read()
            assert "E2B_TEMPLATE=" not in calls.read_text()
            assert cache().read_bytes().split(b"\0")[5] == b""
        finally:
            p.close()
    run_case("refresh can settle a cached picker through a branch rule", branch)

    def fleet():
        configure(["base", "claude", "codex"])
        # The regular fleet owner writes the same arguments on a cold open.
        subprocess.run([str(ROOT / "bin/e2b-box"), "fleet"], cwd=repo,
                       env=dict(env, E2B_PICKER_INPUT=str(tmp / "fresh")), check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        gate.unlink(missing_ok=True)
        p = Popup(dict(env, E2B_POPUP_MODE="pick-fleet"))
        try:
            p.until("New E2B fleet", 1)
            gate.touch()
            p.keys(b"speed\r")
            p.until("claude")
            p.keys(b"q")
            p.read(.3)
        finally:
            gate.touch()
            p.close()
    run_case("fleet cache paints the slug immediately and reaches cached roster rows", fleet)

    def fleet_handoff(preset=False):
        plugin = tmp / ("preset plugin" if preset else "plugin with spaces")
        (plugin / "bin/lib").mkdir(parents=True)
        (plugin / "src").mkdir()
        for name in ("e2b-popup", "lib/paths.sh", "lib/pane.sh", "lib/chooser.sh", "lib/picker-cache.sh"):
            shutil.copyfile(ROOT / "bin" / name, plugin / "bin" / name)
        (plugin / "src/fleet-name.js").write_text('process.exit(process.argv[2] === "speed" ? 0 : 1)')
        box = plugin / "bin/e2b-box"
        box.write_text('#!/bin/sh\nif [ -n "$E2B_PICKER_INPUT" ]; then cp "$PICKER_FRESH" "$E2B_PICKER_INPUT"; else printf "%s\\n" "$@" > "$PICKER_CALLS"; fi\n')
        box.chmod(0o755)
        fields = cache().read_bytes().split(b"\0")
        fields[9:14] = [b"", b"claude", b"1", b"claude", b"claude|native|high,low|high|env|model-a,model-b|model-a"]
        if preset:
            (plugin / "package.json").write_text('{"type":"module"}')
            (plugin / "src/fleet-spec.js").write_text(
                "process.argv[1] = %s; await import(%s);" % (
                    json.dumps(str(ROOT / "src/fleet-spec.js")), json.dumps((ROOT / "src/fleet-spec.js").as_uri())))
            (config / "presets").mkdir(exist_ok=True)
            (config / "presets/bad.json").write_text('{"members":[{"template":"claude","model":"invented"}]}')
            (config / "presets/quick.json").write_text('{"members":[{"template":"claude"}]}')
            (config / "presets/compare.json").write_text(json.dumps({
                "task": "saved instruction",
                "members": [{"template": "claude", "model": "claude-fable-5", "reasoning": "high", "count": 2},
                            {"template": "claude", "model": "claude-fable-5-1", "reasoning": "low"}]}))
            fields[13] = b"claude|native|high,low|high|env|claude-fable-5,claude-fable-5-1|claude-fable-5"
        fresh = tmp / "fleet-fresh"
        fresh.write_bytes(b"\0".join(fields))
        cache().write_bytes(fresh.read_bytes())
        calls.unlink(missing_ok=True)
        p = Popup(dict(env, E2B_POPUP_MODE="pick-fleet", PICKER_FRESH=str(fresh)), plugin)
        try:
            p.until("New E2B fleet")
            p.keys(b"spee\t")
            p.read(.03)
            p.keys(b"\x1b[Z")
            assert "__PICKER_EXIT__" not in p.read(.03), "slug Shift-Tab closed the popup"
            p.keys(b"d\tfix the bug\r")
            p.until("claude-fable-5" if preset else "model-a")
            if preset:
                p.keys(b"P")
                p.until("preset: quick")
                p.output = b""
                p.keys(b"p")
                p.until("not a model")
                p.until("preset: quick")
                p.keys(b"p")
                p.until("preset: compare")
                p.until("saved instruction")
                p.until("3 members")
                p.keys(b"+")
                p.until("4 members")
            p.keys(b"\t")
            p.read(.03)
            p.keys(b"\x1b[Z")
            assert "__PICKER_EXIT__" not in p.read(.03), "roster Shift-Tab closed the popup"
            p.keys(b"\r")
            end = time.monotonic() + 3
            while not calls.exists() and time.monotonic() < end:
                p.read(.05)
            expected = ["fleet", "--slug", "speed", "--task", "fix the bug"]
            if preset:
                expected += ["--preset", "compare"]
                for member in ["claude:claude-fable-5@high", "claude:claude-fable-5@high", "claude:claude-fable-5-1@low", "claude:claude-fable-5@high"]:
                    expected += ["-t", member]
            else:
                expected += ["-t", "claude:model-a@high"]
            assert calls.read_text().splitlines() == expected, calls.read_text()
        finally:
            p.close()
    run_case("cached fleet handoff preserves task, template, model and effort flags", fleet_handoff)
    run_case("popup preset fills editable counts and per-instance model/reasoning cells", lambda: fleet_handoff(True))

    def escape_quickly(mode, roster=False):
        gate.touch()
        subprocess.run([str(ROOT / "bin/e2b-picker-warm")],
                       env=dict(env, HERDR_PLUGIN_CONTEXT_JSON=json.dumps({"workspace_cwd": str(repo)})), check=True)
        calls.unlink(missing_ok=True)
        if not roster:
            gate.unlink()
        p = Popup(dict(env, E2B_POPUP_MODE=mode))
        try:
            p.until("E2B template for" if mode == "pick-box" else "New E2B fleet")
            if roster:
                p.keys(b"speed\r")
                p.until("space tick")
            else:
                p.keys(b"\r" if mode == "pick-box" else b"speed\r")
                p.read(.03)
            start = time.monotonic()
            p.keys(b"\x1b")
            p.until("__PICKER_EXIT__", .4)
            elapsed = (time.monotonic() - start) * 1000
            assert elapsed < 200, "Escape took %.1f ms" % elapsed
            assert not calls.exists(), "Escape launched work"
            return "%.1f ms" % elapsed
        finally:
            gate.touch()
            p.close()
    run_case("Escape cancels a pending box confirmation immediately", lambda: escape_quickly("pick-box"))
    run_case("Escape cancels a pending fleet slug immediately", lambda: escape_quickly("pick-fleet"))
    run_case("Escape closes the fleet roster immediately", lambda: escape_quickly("pick-fleet", True))

    def popup_arrow_keys():
        gate.touch()
        p = Popup(env)
        try:
            p.until("E2B template for")
            p.keys(b"\x1b[B")
            assert "__PICKER_EXIT__" not in p.read(.03), "down arrow closed the popup"
            p.keys(b"\x1b[C")
            assert "__PICKER_EXIT__" not in p.read(.03), "right arrow closed the popup"
            p.keys(b"\r")
            p.until("enter take")
            p.output = b""
            start = time.monotonic()
            p.keys(b"\x1b")
            p.until("enter confirm", .4)
            assert time.monotonic() - start < .2
            assert "__PICKER_EXIT__" not in p.read(.03), "dropdown Escape closed the popup"
            p.keys(b"\x1b[Z")
            p.read(.03)
            p.keys(b"\r")
            p.until("__PICKER_EXIT__")
            assert "E2B_TEMPLATE=claude" in calls.read_text(), "Shift-Tab failed to return to template column"
        finally:
            p.close()
    run_case("popup arrows and Shift-Tab still work; dropdown Escape only goes back", popup_arrow_keys)
