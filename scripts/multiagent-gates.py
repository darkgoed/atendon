#!/usr/bin/env python3
"""Central quality gates for the AtendON multi-agent integration flow.

validate: flock(state/heavy.lock) -> lint, renderer build, typecheck, tests,
backend/panel builds + Jev/Ponytail
review of the integration diff, one round per SHA; records state/validation.json
atomically only after full success. No E2E.

promote: flock(state/deploy.lock) -> push integration branch (NEVER main) and
open a PR integration->main. Merge of that PR on main is what triggers Coolify.

State schema shared with scripts/multiagent.py: state/{task_id}.json manifests
with integrated / integrate_sha fields.
"""
import argparse, fcntl, json, os, re, shutil, subprocess, sys, tempfile, time
from typing import NoReturn

AGENTS = "/home/deploy/atendon-agents"
INTEGRATION = f"{AGENTS}/integration"
STATE = f"{AGENTS}/state"
VALIDATION = f"{STATE}/validation.json"
DEPLOY = f"{STATE}/deploy.json"
HEAVY_LOCK = f"{STATE}/heavy.lock"
DEPLOY_LOCK = f"{STATE}/deploy.lock"
CMD_TIMEOUT = 1800
REVIEW_TIMEOUT = 900
TAIL = 5000
REVIEW_VERDICT = "VERDICT: PASS"


def sh(*args, cwd=INTEGRATION, check=True):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode:
        die(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r


def out(*args, cwd=INTEGRATION):
    return sh(*args, cwd=cwd).stdout.strip()


def die(msg, **extra) -> NoReturn:
    print(json.dumps({"ok": False, "error": msg, **extra}))
    sys.exit(1)


def ok(**kw) -> NoReturn:
    print(json.dumps({"ok": True, **kw}))
    sys.exit(0)


def atomic_write(path, data):
    fd, tmp = tempfile.mkstemp(dir=STATE, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def flock_ex(path):
    lf = open(path, "a")
    fcntl.flock(lf, fcntl.LOCK_EX)
    return lf


def manifests_integrated():
    ms = []
    if not os.path.isdir(STATE):
        return ms
    for name in sorted(f for f in os.listdir(STATE)
                       if f.endswith(".json") and f not in ("validation.json", "deploy.json")):
        try:
            with open(f"{STATE}/{name}") as f:
                m = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if m.get("integrated"):
            ms.append(m)
    return ms


def run_check(name, argv, cwd, env=None, timeout=CMD_TIMEOUT):
    t0 = time.monotonic()
    try:
        r = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        die(f"{name} timed out after {timeout}s", cmd=argv)
    except FileNotFoundError:
        die(f"tool unavailable for {name}: {argv[0]!r} not on PATH")
    if r.returncode != 0:
        die(f"{name} failed (rc={r.returncode})", cmd=argv,
            output=(r.stdout[-TAIL:] + r.stderr[-TAIL:]))
    return {"cmd": argv, "rc": 0, "seconds": round(time.monotonic() - t0, 1)}


JEV = "/var/www/scripts/jev-gate.py"


def jev_gate(name, payload, task_id, cwd):
    """Real JevGate CLI call, advisory per its own contract (SHADOW/ADVISORY
    modes never block; fallback is normal). stdin JSON in, real output/errors
    preserved verbatim in the record — the gate never invents a PASS from jev
    output. Only the CLI failing to execute at all blocks."""
    try:
        r = subprocess.run([sys.executable, JEV, name, "--task-id", task_id],
                           cwd=cwd, input=json.dumps(payload), capture_output=True,
                           text=True, timeout=120)
    except subprocess.TimeoutExpired:
        die(f"jev {name} timed out after 120s")
    except OSError as e:
        die(f"jev {name} failed to execute: {e}")
    txt = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        die(f"jev {name} failed (rc={r.returncode})", output=txt[-TAIL:])
    return {"cmd": [JEV, name], "rc": 0, "output": txt[-TAIL:]}


def review_step(base, cwd):
    """Real gates on the diff: JevGate CLI (intake/scope-drift/completeness,
    advisory — findings recorded, never a verdict) then a Ponytail over-
    engineering review via the hermes CLI with the real skill preloaded
    (--skills ponytail), whose verdict must be exactly the final line
    'VERDICT: PASS' — substring matches never count."""
    if not os.path.exists(JEV):
        die(f"review tool unavailable: {JEV} missing")
    if not shutil.which("hermes"):
        die("review tool unavailable: hermes CLI not on PATH")
    diff = out("git", "diff", f"{base}...HEAD", cwd=cwd)
    if len(diff) > 120_000:  # argv per-arg limit on Linux is ~128KB
        die(f"diff too large for one review round ({len(diff)} chars); split integration")
    ms = manifests_integrated()
    request = " | ".join(f"{m.get('task_id')}: {m.get('goal', '')}" for m in ms)
    changed = out("git", "diff", "--name-only", f"{base}...HEAD", cwd=cwd).splitlines()
    stat = out("git", "diff", "--stat", f"{base}...HEAD", cwd=cwd)
    results = {
        "jev_intake": jev_gate("intake", {"request": request}, ms[0]["task_id"], cwd),
        "jev_scope_drift": jev_gate("scope-drift",
            {"original_request": request, "changed_files": changed,
             "diff_summary": stat[-TAIL:]}, ms[0]["task_id"], cwd),
        "jev_completeness": jev_gate("completeness",
            {"original_request": request, "evidence": stat[-TAIL:]},
            ms[0]["task_id"], cwd),
    }
    prompt = (
        "You are running the Ponytail skill (laziest solution that works: YAGNI, "
        "stdlib over custom code, deletion over addition, no unrequested "
        "abstractions, boring over clever). Review the following AtendON "
        "integration diff (git origin/main...HEAD) as a Ponytail over-engineering "
        "pass: flag code that should not exist, abstractions with one caller, "
        "scaffolding for later. Never simplify away input validation at trust "
        "boundaries or error handling that prevents data loss.\n"
        "You are an automated gate: end your reply with exactly one final line, "
        f"either '{REVIEW_VERDICT}' or 'VERDICT: FAIL - <reason>'.\n\n"
        f"DIFF:\n{diff}"
    )
    t0 = time.monotonic()
    try:
        r = subprocess.run(["hermes", "--skills", "ponytail", "-z", prompt], cwd=cwd,
                           capture_output=True, text=True, timeout=REVIEW_TIMEOUT)
    except subprocess.TimeoutExpired:
        die(f"review timed out after {REVIEW_TIMEOUT}s")
    except FileNotFoundError:
        die("review tool unavailable: hermes CLI not on PATH")
    txt = (r.stdout + r.stderr).strip()
    lines = txt.splitlines()
    if r.returncode != 0 or not lines or lines[-1] != REVIEW_VERDICT:
        die("ponytail review did not pass", rc=r.returncode, output=txt[-TAIL:])
    results["ponytail"] = {"cmd": ["hermes", "--skills", "ponytail", "-z",
                                   "<diff-review-prompt>"], "rc": 0,
                           "verdict": "PASS", "seconds": round(time.monotonic() - t0, 1)}
    return results


def load_validation():
    if not os.path.exists(VALIDATION):
        return None
    with open(VALIDATION) as f:
        return json.load(f)


def cmd_validate(_a):
    os.makedirs(STATE, exist_ok=True)
    cwd = os.path.realpath(INTEGRATION)
    with flock_ex(HEAVY_LOCK):
        sha = out("git", "rev-parse", "HEAD", cwd=cwd)
        if out("git", "symbolic-ref", "-q", "HEAD", cwd=cwd) != "refs/heads/integration":
            die("integration worktree is not on branch integration")
        if out("git", "status", "--porcelain", cwd=cwd):
            die("integration worktree is dirty")
        if not manifests_integrated():
            die("no integrated commits in agent state")
        base = out("git", "merge-base", "origin/main", "HEAD", cwd=cwd)
        if base == sha:
            die("integration has no commits beyond origin/main")
        prior = load_validation()
        if prior and prior.get("ok") and prior.get("validated_sha") == sha:
            ok(validated_sha=sha, already_validated=True, integration=cwd,
               checks=prior.get("checks", {}))
        # One build pass per workspace, dependency order: @atendon/
        # proposal-renderer exports point to dist/ (absent after npm ci), so
        # it must be built before the global typecheck; backend and panel
        # (which import it) are built after tests. The root `npm run build`
        # is dropped: it would emit renderer again.
        tests = {"lint": ["npm", "run", "lint"],
                 "build_renderer": ["npm", "run", "build", "-w",
                                    "@atendon/proposal-renderer"],
                 "typecheck": ["npm", "run", "typecheck"],
                 # relevant tests for this flow only: the multiagent integration
                 # suite, not the full `npm run test` (shared test DB)
                 "test": ["python3", "-m", "unittest", "scripts/test_multiagent.py",
                          "scripts/test_multiagent_hook.py", "scripts/test_multiagent_gates.py",
                          "-q"],
                 "build_backend": ["npm", "run", "build", "-w", "@atendon/backend"],
                 "build_panel": ["npm", "run", "build", "-w", "@atendon/panel"]}
        results = {n: run_check(n, argv, cwd,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
                                    if argv[0] == "python3" else None)
                   for n, argv in tests.items()}
        results.update(review_step(base, cwd))
        record = {"ok": True, "validated_sha": sha, "integration": cwd,
                  "diff_base": base, "validated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "checks": results}
        atomic_write(VALIDATION, record)
    ok(validated_sha=sha, integration=cwd,
       checks={k: v["rc"] for k, v in results.items()})


def branch_protection_active():
    """gh api: main must still be protected before integration is pushed —
    PR-only promote is only guaranteed while that protection is active.
    Parsed JSON (not substring sniffing): requires a truthy
    required_pull_request_reviews object, enforce_admins.enabled true and
    allow_force_pushes.enabled false. Real API output preserved on failure."""
    repo = out("gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")
    r = sh("gh", "api", f"repos/{repo}/branches/main/protection", check=False)
    if r.returncode:
        die("main branch protection check failed; refusing push",
            output=(r.stdout[-TAIL:] + r.stderr[-TAIL:]))
    try:
        prot = json.loads(r.stdout)
    except json.JSONDecodeError:
        die("main branch protection returned invalid JSON; refusing push",
            output=r.stdout[-TAIL:])
    reviews = prot.get("required_pull_request_reviews")
    if not isinstance(reviews, dict) or not reviews:
        die("main branch protection does not require PR reviews; refusing push",
            required_pull_request_reviews=reviews)
    if not prot.get("enforce_admins", {}).get("enabled"):
        die("main branch protection does not enforce admins; refusing push")
    if (prot.get("allow_force_pushes") or {}).get("enabled"):
        die("main branch protection allows force pushes; refusing push")


def cmd_promote(_a):
    os.makedirs(STATE, exist_ok=True)
    v = load_validation()
    if not v or not v.get("ok"):
        die("no successful validation record; run validate first")
    if v.get("integration") != os.path.realpath(INTEGRATION):
        die("validation was not run on the canonical integration worktree")
    with flock_ex(DEPLOY_LOCK):
        if out("git", "status", "--porcelain"):
            die("integration worktree is dirty; promote refuses")
        sha = out("git", "rev-parse", "HEAD")
        if v.get("validated_sha") != sha:
            die(f"validated_sha {v.get('validated_sha')} != integration HEAD {sha}")
        sh("git", "fetch", "origin", "main")
        main_sha = out("git", "rev-parse", "origin/main")
        if main_sha == sha:
            die("integration has no commits beyond origin/main")
        if sh("git", "merge-base", "--is-ancestor", "origin/main", "HEAD", check=False).returncode:
            die("origin/main is not a predecessor of integration HEAD")
        branch_protection_active()
        sh("git", "push", "origin", "integration:refs/heads/integration")  # NEVER main
        if not shutil.which("gh"):
            die("tool unavailable: gh CLI not on PATH")
        existing = out("gh", "pr", "list", "--head", "integration", "--base", "main",
                       "--state", "open", "--json", "number,url", "--limit", "1")
        prs = json.loads(existing) if existing else []
        if prs:
            pr_url = prs[0]["url"]
            created = False
        else:
            r = subprocess.run(
                ["gh", "pr", "create", "--base", "main", "--head", "integration",
                 "--title", f"integration -> main ({sha[:10]})",
                 "--body", f"Promoted sha {sha}; validated {v['validated_sha']}.\n"
                           f"Rollback SHA: {main_sha}.\n"
                           "No auto-merge: merging this PR on main triggers Coolify."],
                cwd=INTEGRATION, capture_output=True, text=True)
            if r.returncode:
                die("gh pr create failed", output=(r.stdout[-TAIL:] + r.stderr[-TAIL:]))
            m = re.search(r"https://\S+", r.stdout)
            pr_url, created = (m.group(0) if m else ""), True
        atomic_write(DEPLOY, {"promoted_sha": sha, "rollback_sha": main_sha,
                              "pr_url": pr_url, "promoted_at":
                              time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    ok(promoted_sha=sha, rollback_sha=main_sha, pr_url=pr_url, pr_created=created,
       note="no auto-merge, no deploy; merge the PR on main to trigger Coolify")


def cmd_status(_a):
    v = load_validation()
    d = None
    if os.path.exists(DEPLOY):
        with open(DEPLOY) as f:
            d = json.load(f)
    info = {"integration": INTEGRATION,
            "head": out("git", "rev-parse", "HEAD", cwd=INTEGRATION) if os.path.isdir(INTEGRATION) else None,
            "clean": not out("git", "status", "--porcelain", cwd=INTEGRATION) if os.path.isdir(INTEGRATION) else None,
            "integrated_tasks": [m.get("task_id") for m in manifests_integrated()],
            "validation": v, "last_promotion": d}
    print(json.dumps(info, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    pv = sub.add_parser("validate")
    sub.add_parser("promote")
    sub.add_parser("status")
    a = p.parse_args()
    {"validate": cmd_validate, "promote": cmd_promote, "status": cmd_status}[a.cmd](a)


if __name__ == "__main__":
    main()
