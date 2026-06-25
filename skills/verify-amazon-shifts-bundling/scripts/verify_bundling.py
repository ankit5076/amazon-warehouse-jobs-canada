#!/usr/bin/env python3
import subprocess
import sys
from pathlib import Path


REPO = Path("/Users/ankit5076/Documents/Automations/amazon-shifts")


def run(command):
    print(f"$ {' '.join(command)}", flush=True)
    return subprocess.run(command, cwd=REPO).returncode


def main():
    if run(["npm", "test", "--", "--run"]) != 0:
        return 1
    if run(["npm", "run", "verify:bundle"]) != 0:
        return 1
    if run(["git", "diff", "--check"]) != 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
