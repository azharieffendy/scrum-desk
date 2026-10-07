"""Scan tracked text and reachable Git history for likely credentials.

Usage: python scripts/audit-repo-secrets.py
Only file paths, object IDs, line numbers, and pattern names are printed.
Review findings privately; a clean result is not a guarantee against all secret formats.
"""

from pathlib import Path
from io import BytesIO
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "GitHub token": re.compile(rb"(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,})"),
    "AWS access key": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "Google API key": re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b"),
    "Slack token": re.compile(rb"\bxox[baprs]-[0-9A-Za-z-]{20,}\b"),
    "credential URL": re.compile(rb"https?://[^\s/@:]+:[^\s/@]+@[^\s/]+"),
    "credential assignment": re.compile(
        rb"(?i)\b(?:JIRA_API_TOKEN|APP_ACCESS_CODE|SETUP_CODE|API[_-]?KEY|SECRET[_-]?KEY|"
        rb"PASSWORD|ACCESS[_-]?TOKEN)\b\s*[:=]\s*['\"]?([A-Za-z0-9+/_!@#$%^&*.-]{12,})"
    ),
}
EXAMPLE = re.compile(rb"(?i)^(?:test[-_]|demo[-_]|example|placeholder|changeme|your[-_]|SECRET-TOKEN)")


def git(*args, input_data=None):
    return subprocess.run(["git", *args], cwd=ROOT, input=input_data,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def inspect(label, data):
    if b"\0" in data[:8192]:
        return 0
    count = 0
    for number, line in enumerate(data.splitlines(), 1):
        for name, pattern in PATTERNS.items():
            for match in pattern.finditer(line):
                if name == "credential assignment" and EXAMPLE.match(match.group(1)):
                    continue
                print(f"{label}:{number}: {name} (value redacted)")
                count += 1
    return count


def scan_history():
    rows = git("rev-list", "--objects", "--all").splitlines()
    names = {}
    for row in rows:
        oid, _, path = row.partition(b" ")
        names.setdefault(oid, path.decode("utf-8", "replace") or "(commit/tree)")
    stream = BytesIO(git("cat-file", "--batch", input_data=b"".join(oid + b"\n" for oid in names)))
    found = 0
    for oid in names:
        header = stream.readline().split()
        if len(header) != 3 or header[0] != oid:
            raise RuntimeError("Git object stream was incomplete")
        size = int(header[2])
        data = stream.read(size)
        stream.read(1)
        if header[1] == b"blob":
            found += inspect(f"history {oid.decode()[:12]} {names[oid]}", data)
    return found, len(names)


def scan_worktree():
    found = 0
    for raw in git("ls-files", "-z").split(b"\0"):
        if not raw:
            continue
        path = ROOT / raw.decode("utf-8", "replace")
        if path.is_file():
            found += inspect(f"worktree {path.relative_to(ROOT)}", path.read_bytes())
    return found


if __name__ == "__main__":
    worktree = scan_worktree()
    history, objects = scan_history()
    print(f"Scanned tracked worktree and {objects} reachable Git objects: {worktree} worktree, {history} history candidate(s).")
    sys.exit(1 if worktree or history else 0)
