"""Run both loopback services and stop only the children this launcher owns."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser

ROOT = Path(__file__).resolve().parents[1]


def check_port(port: int) -> None:
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as exc:
            raise RuntimeError(f"Port {port} is in use. Select another port; no existing process was stopped.") from exc


def wait_ready(url: str, children: list[subprocess.Popen[bytes]]) -> None:
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if any(child.poll() is not None for child in children):
            raise RuntimeError("A tracker service exited during startup; see its output above.")
        try:
            with urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError, OSError):
            pass
        time.sleep(0.25)
    raise RuntimeError(f"Service did not become ready at {url}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--api-port", type=int, default=8000)
    parser.add_argument("--development", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    children: list[subprocess.Popen[bytes]] = []
    try:
        if args.port == args.api_port or any(not 1024 <= port <= 65535 for port in (args.port, args.api_port)):
            raise RuntimeError("Choose two different ports between 1024 and 65535.")
        for port in (args.port, args.api_port):
            check_port(port)
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js was not found. See README.md.")
        origin = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update({"HOST": "127.0.0.1", "PORT": str(args.port), "ORIGIN": origin,
                    "GFL2_FRONTEND_ORIGIN": origin, "GFL2_API_URL": f"http://127.0.0.1:{args.api_port}",
                    "BODY_SIZE_LIMIT": "64M"})
        # CREATE_NO_WINDOW keeps background helpers hidden on Windows. The launcher's
        # own console remains the single place for output and Ctrl+C.
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        children.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", str(args.api_port), "--no-access-log"], cwd=ROOT, env=env, creationflags=flags))
        wait_ready(f"{env['GFL2_API_URL']}/api/health", children)
        web_args = [node, "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", str(args.port), "--strictPort"] if args.development else [node, "build"]
        children.append(subprocess.Popen(web_args, cwd=ROOT / "web", env=env, creationflags=flags))
        wait_ready(origin, children)
        print(f"GFL2 Pull Tracker: {origin}\nPress Ctrl+C to stop both services.", flush=True)
        if not args.no_browser:
            webbrowser.open(origin)
        while all(child.poll() is None for child in children):
            time.sleep(0.5)
        raise RuntimeError("A tracker service stopped; shutting down the other service.")
    except KeyboardInterrupt:
        return 0
    except (RuntimeError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for child in reversed(children):
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
