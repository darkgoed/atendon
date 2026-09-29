#!/usr/bin/env python3
"""Multi-agent worktree provisioning/integration for AtendON.

Never touches main or a dirty /var/www checkout: all git ops run in
/home/deploy/atendon-agents/{integration,<id>} worktrees only.
"""
import argparse, fcntl, glob, json, os, re, subprocess, sys, tempfile

AGENTS = "/home/deploy/atendon-agents"
INTEGRATION = f"{AGENTS}/integration"
STATE = f"{AGENTS}/state"
LOCK = f"{STATE}/integration.lock"
ID_RE = re.compile(r"^[a-z0-9-]+$")
BAD_OWNERS = {"", ".", "..", "/"}


def sh(*args, cwd=None, check=True):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode:
        die(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r


def out(*args, cwd=None):
    return sh(*args, cwd=cwd).stdout.strip()


def die(msg, **extra):
    print(json.dumps({"ok": False, "error": msg, **extra}))
    sys.exit(1)


def ok(**kw):
    print(json.dumps({"ok": True, **kw}))
    sys.exit(0)


def norm_owner(owner):
    """Validate owner as a safe relative directory prefix inside the canonical app."""
    if owner in BAD_OWNERS or owner.startswith("/") or "\\" in owner or "\x00" in owner:
        die(f"unsafe owner prefix: {owner!r}")
    parts = [p for p in owner.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        die(f"unsafe owner prefix: {owner!r}")
    return "/".join(parts) + "/"


def load_manifest(tid):
    path = f"{STATE}/{tid}.json"
    if not os.path.exists(path):
        die(f"no manifest for task {tid}")
    with open(path) as f:
        return json.load(f)


def manifests(exclude=None):
    ms = []
    for p in glob.glob(f"{STATE}/*.json"):
        with open(p) as f:
            m = json.load(f)
        if m.get("task_id") != exclude:
            ms.append(m)
    return ms


def overlaps(prefix, m):
    own = m.get("ownership")
    if not own:
        return False
    own = own if isinstance(own, list) else [own]
    return any(prefix.startswith(o) or o.startswith(prefix) for o in (x if isinstance(x, str) else x.get("prefix", "") for x in own))


def write_manifest(m):
    fd, tmp = tempfile.mkstemp(dir=STATE, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(m, f, indent=2)
    os.replace(tmp, f"{STATE}/{m['task_id']}.json")


def cmd_provision(a):
    tid = a.task_id
    if not ID_RE.match(tid):
        die(f"invalid task id {tid!r}: must match [a-z0-9-]+")
    owner = norm_owner(a.owner)
    branch = f"agent/{tid}"
    wt = f"{AGENTS}/{tid}"
    with open(LOCK, "a") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        if os.path.exists(wt) or sh("git", "rev-parse", "--verify", branch, cwd=INTEGRATION, check=False).returncode == 0:
            die(f"task {tid} already provisioned")
        clash = [m["task_id"] for m in manifests() if overlaps(owner, m)]
        if clash:
            die("ownership overlap", with_tasks=clash)
        cur = out("git", "branch", "--show-current", cwd=INTEGRATION)
        if cur != "integration":
            die(f"integration branch is {cur!r}, refusing provision")
        if sh("git", "status", "--porcelain", cwd=INTEGRATION, check=False).stdout.strip():
            die("integration worktree is dirty")
        base_sha = out("git", "rev-parse", "HEAD", cwd=INTEGRATION)
        sh("git", "worktree", "add", "-b", branch, wt, base_sha, cwd=INTEGRATION)
        write_manifest({"task_id": tid, "branch": branch, "worktree": wt,
                        "base_sha": base_sha, "ownership": owner, "goal": a.goal,
                        "integrated": False})
    ok(task_id=tid, branch=branch, worktree=wt, base_sha=base_sha, ownership=owner)


def cmd_integrate(a):
    tid = a.task_id
    with open(LOCK, "a") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        m = load_manifest(tid)
        if m.get("integrated"):
            die(f"task {tid} already integrated")
        branch, base_sha, owner, wt = m["branch"], m["base_sha"], m["ownership"], m["worktree"]
        if out("git", "status", "--porcelain", cwd=wt):
            die(f"worker worktree {wt} is dirty")
        if sh("git", "status", "--porcelain", cwd=INTEGRATION, check=False).stdout.strip():
            die("integration worktree is dirty")
        sh("git", "fetch", "origin", "main", cwd=INTEGRATION)
        r = sh("git", "merge", "--no-edit", "origin/main", cwd=INTEGRATION, check=False)
        if r.returncode:
            sh("git", "merge", "--abort", cwd=INTEGRATION, check=False)
            die("origin/main merge conflicted; integration restored")
        if not out("git", "rev-list", f"{base_sha}..{branch}", cwd=INTEGRATION):
            die(f"branch {branch} has no commits since base")
        files = out("git", "diff", "--name-only", f"{base_sha}..{branch}", cwd=INTEGRATION).splitlines()
        outside = [f for f in files if not f.startswith(owner)]
        if outside:
            die("changes outside ownership", files=outside)
        clashing = []
        for om in manifests(exclude=tid):
            ofiles = om.get("files") or []
            hit = set(files) & set(ofiles)
            if hit or (not ofiles and overlaps(owner, om)):
                clashing.append(om["task_id"])
        if clashing:
            die("overlap with integrated tasks", with_tasks=clashing)
        r = sh("git", "merge", "--squash", branch, cwd=INTEGRATION, check=False)
        if r.returncode:
            sh("git", "merge", "--abort", cwd=INTEGRATION, check=False)
            die("squash merge conflicted; integration restored")
        rc = subprocess.run(["git", "commit", "-m", f"integrate {tid}"], cwd=INTEGRATION,
                            capture_output=True, text=True)
        if rc.returncode:
            # ponytail: restore clears the failed squash without git reset; no reset ever in this shared checkout
            sh("git", "restore", "--staged", "--worktree", "--", ".", cwd=INTEGRATION)
            die(f"squash commit failed: {rc.stderr.strip()}")
        sha = out("git", "rev-parse", "HEAD", cwd=INTEGRATION)
        m.update(integrated=True, integrate_sha=sha, files=files)
        write_manifest(m)
    ok(task_id=tid, commit=sha, files=files)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    pp = sub.add_parser("provision")
    pp.add_argument("--task-id", required=True)
    pp.add_argument("--owner", required=True)
    pp.add_argument("--goal", required=True)
    pi = sub.add_parser("integrate")
    pi.add_argument("--task-id", required=True)
    a = p.parse_args()
    os.makedirs(STATE, exist_ok=True)
    (cmd_provision if a.cmd == "provision" else cmd_integrate)(a)


if __name__ == "__main__":
    main()
