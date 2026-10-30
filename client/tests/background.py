"""Linux process smoke test: python3 tests/background.py /path/to/rust-remote-client."""

import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def wait_for(predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for client")


def stopped(pid):
    status = Path(f"/proc/{pid}/status")
    return not status.exists() or "State:\tZ" in status.read_text()


def main():
    binary = str(Path(sys.argv[1]).resolve())
    processes = []
    with tempfile.TemporaryDirectory(prefix="remote-background-") as temporary:
        directory = Path(temporary)
        env = dict(os.environ, XDG_STATE_HOME=str(directory / "state"))
        env.update(REMOTE_SERVER="ws://127.0.0.1:1/agent/ws", REMOTE_TOKEN="x" * 32,
                   REMOTE_ALLOW_INSECURE="true", RUST_LOG="info")
        env.pop("REMOTE_UPDATE_READY", None)
        log = directory / "state/rust-remote/client.log"

        def run(*args, environment=env):
            return subprocess.run([binary, *args], env=environment, cwd=directory,
                                  capture_output=True, text=True, timeout=10)

        def launch(*args):
            result = run(*args)
            assert result.returncode == 0, result.stderr
            assert result.stdout == "", result.stdout
            assert result.stderr == "", result.stderr
            pid = next(int(item) for item in os.listdir("/proc") if item.isdigit() and Path(f"/proc/{item}/cmdline").exists() and binary in Path(f"/proc/{item}/cmdline").read_bytes().decode(errors="ignore"))
            processes.append(pid)
            return pid

        try:
            result = run("--help")
            assert result.returncode == 0 and "--foreground" in result.stdout
            assert not log.exists()
            result = run(environment=dict(env, REMOTE_TOKEN="short"))
            assert result.returncode != 0 and "at least 32" in result.stderr
            assert not log.exists()

            pid = launch()
            wait_for(lambda: not stopped(pid))
            assert not stopped(pid)
            assert os.getsid(pid) == pid, "Client still shares its launcher's session"
            assert os.readlink(f"/proc/{pid}/fd/0") == "/dev/null"
            for fd in (1, 2):
                assert os.readlink(f"/proc/{pid}/fd/{fd}") == "/dev/null"
            assert not log.exists()
            assert (directory / ".rust-remote-device-id").is_file()

            duplicate = launch()
            wait_for(lambda: stopped(duplicate))
            assert stopped(duplicate)
            assert not stopped(pid)
            os.kill(pid, signal.SIGTERM)
            wait_for(lambda: stopped(pid))

            foreground = subprocess.Popen([binary, "--foreground"], env=env,
                                          cwd=directory, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True)
            try:
                output = ""
                deadline = time.monotonic() + 10
                while foreground.poll() is None and time.monotonic() < deadline:
                    if select.select([foreground.stdout], [], [], 0.1)[0]:
                        chunk = os.read(foreground.stdout.fileno(), 65536)
                        assert chunk, "Foreground client exited during startup"
                        output += chunk.decode()
                assert foreground.poll() is None
                foreground.send_signal(signal.SIGINT)
                stdout, stderr = foreground.communicate(timeout=10)
                assert foreground.returncode == 0, stderr
                assert output + stdout == ""
                assert stderr == ""
            finally:
                if foreground.poll() is None:
                    foreground.kill()
                foreground.wait()

            failed = launch("--identity", "missing-directory/device-id")
            wait_for(lambda: stopped(failed))
            assert "Client stopped with an error" in log.read_text()

            # Simulate upgrading a pre-background release: its restart arguments
            # do not contain --foreground. The helper must still supervise the
            # actual candidate until authentication, without rolling back early.
            staging = directory / "update"
            staging.mkdir()
            original = directory / "previous-client"
            original.write_text("#!/bin/sh\nexit 99\n")
            original.chmod(0o700)
            shutil.copy2(binary, staging / "payload")
            offset = len(log.read_text())
            helper = subprocess.Popen(
                [binary, "--internal-apply-update", str(original), str(staging),
                 "--identity", str(directory / ".rust-remote-device-id")],
                env=env, cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            try:
                children = Path(f"/proc/{helper.pid}/task/{helper.pid}/children")
                wait_for(lambda: children.exists() and children.read_text().strip())
                candidate = int(children.read_text().split()[0])
                processes.append(candidate)
                wait_for(lambda: "scheduling reconnect" in log.read_text()[offset:])
                time.sleep(0.5)
                assert helper.poll() is None, "Update helper stopped tracking candidate"
                assert not stopped(candidate)
                (staging / "ready").write_text("ready")
                _, errors = helper.communicate(timeout=10)
                assert helper.returncode == 0, errors
                assert not staging.exists()
                assert not stopped(candidate)
            finally:
                if helper.poll() is None:
                    helper.kill()
                helper.wait()
        finally:
            for pid in processes:
                if not stopped(pid):
                    os.kill(pid, signal.SIGKILL)
    print("Linux background startup, logging, single instance, foreground, and update checks passed")


if __name__ == "__main__":
    main()
