#!/usr/bin/env python3
"""Integration tests for scripts/multiagent.py against throwaway git fixtures.

Imports multiagent.py via importlib and monkeypatches AGENTS/INTEGRATION/STATE/LOCK
into a temp dir, so the real /home/deploy checkout is never touched.
"""
import importlib.util, json, os, subprocess, tempfile, unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("multiagent", HERE / "multiagent.py")


def sh(*args, cwd=None):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"{args} failed: {r.stderr.strip()}")
    return r.stdout.strip()


class MultiagentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.ma = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(self.ma)
        self.ma.AGENTS = str(root)
        self.ma.INTEGRATION = str(root / "integration")
        self.ma.STATE = str(root / "state")
        self.ma.LOCK = str(root / "state" / "integration.lock")
        os.makedirs(self.ma.STATE, exist_ok=True)

        # origin bare <- seed repo; integration = clone of bare (has remote origin)
        self.bare = str(root / "origin.git")
        sh("git", "init", "--bare", "-b", "main", self.bare)
        seed = root / "seed"
        sh("git", "init", "-b", "main", str(seed))
        sh("git", "config", "user.email", "t@t", cwd=seed)
        sh("git", "config", "user.name", "t", cwd=seed)
        (seed / "src").mkdir()
        (seed / "src" / "base.txt").write_text("base\n")
        sh("git", "add", "--", "src/base.txt", cwd=seed)
        sh("git", "commit", "-m", "seed", cwd=seed)
        sh("git", "remote", "add", "origin", self.bare, cwd=seed)
        sh("git", "push", "-u", "origin", "main", cwd=seed)
        sh("git", "clone", self.bare, self.ma.INTEGRATION)
        # core guard: provision refuses unless the integration worktree is on a
        # branch literally named "integration"
        sh("git", "checkout", "-b", "integration", cwd=self.ma.INTEGRATION)
        sh("git", "config", "user.email", "t@t", cwd=self.ma.INTEGRATION)
        sh("git", "config", "user.name", "t", cwd=self.ma.INTEGRATION)
        self.seed = str(seed)

        # ok/die print+sys.exit, unsafe to capture across threads; swap for
        # exception-carrying versions (thread-safe, restored in tearDown)
        class _Exit(Exception):
            def __init__(self, payload):
                self.payload = payload

        self._Exit = _Exit

        def ok(**kw):
            raise _Exit({"ok": True, **kw})

        def die(msg, **extra):
            raise _Exit({"ok": False, "error": msg, **extra})

        self._orig = (self.ma.ok, self.ma.die)
        self.ma.ok, self.ma.die = ok, die

    def tearDown(self):
        self.ma.ok, self.ma.die = self._orig

    def call(self, fn, **kw):
        """Run a multiagent cmd, return its JSON result via _Exit."""
        try:
            fn(SimpleNamespace(**kw))
        except self._Exit as e:
            return e.payload
        self.fail(f"{fn.__name__} neither ok() nor die()")

    def commit(self, wt, rel, content):
        p = Path(wt) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        sh("git", "add", "--", rel, cwd=wt)
        sh("git", "commit", "-m", f"add {rel}", cwd=wt)

    def test_end_to_end(self):
        ma = self.ma
        # two disjoint-owner tasks provisioned in parallel
        with ThreadPoolExecutor(max_workers=2) as ex:
            futs = [ex.submit(self.call, ma.cmd_provision,
                              task_id=t, owner=o, goal="g")
                    for t, o in (("a", "src/a"), ("b", "src/b"))]
            pa, pb = [f.result() for f in futs]
        self.assertTrue(pa["ok"], pa)
        self.assertTrue(pb["ok"], pb)
        wt_a, wt_b = pa["worktree"], pb["worktree"]
        self.assertEqual(pa["ownership"], "src/a/")
        self.assertEqual(pb["ownership"], "src/b/")
        self.assertNotEqual(wt_a, wt_b)

        # independent commits in each worktree
        self.commit(wt_a, "src/a/a.txt", "A\n")
        self.commit(wt_b, "src/b/b.txt", "B\n")

        # reject overlapping owner
        pc = self.call(ma.cmd_provision, task_id="c", owner="src/a", goal="g")
        self.assertFalse(pc["ok"], pc)
        self.assertEqual(pc["error"], "ownership overlap")
        self.assertEqual(pc["with_tasks"], ["a"])

        # integrate A serially
        ia = self.call(ma.cmd_integrate, task_id="a")
        self.assertTrue(ia["ok"], ia)
        head_a = sh("git", "rev-parse", "HEAD", cwd=ma.INTEGRATION)
        self.assertEqual(ia["commit"], head_a)
        self.assertEqual(ia["files"], ["src/a/a.txt"])
        self.assertEqual(Path(ma.INTEGRATION, "src", "a", "a.txt").read_text(), "A\n")
        with open(f"{ma.STATE}/a.json") as f:
            m = json.load(f)
        self.assertTrue(m["integrated"])
        self.assertEqual(m["integrate_sha"], head_a)
        # already integrated -> rejected
        ia2 = self.call(ma.cmd_integrate, task_id="a")
        self.assertFalse(ia2["ok"], ia2)

        # remote change on origin main before integrating B
        self.commit(self.seed, "src/remote.txt", "R\n")
        sh("git", "push", "origin", "main", cwd=self.seed)

        ib = self.call(ma.cmd_integrate, task_id="b")
        self.assertTrue(ib["ok"], ib)
        self.assertEqual(ib["files"], ["src/b/b.txt"])
        self.assertEqual(Path(ma.INTEGRATION, "src", "b", "b.txt").read_text(), "B\n")
        self.assertEqual(Path(ma.INTEGRATION, "src", "remote.txt").read_text(), "R\n")

        # branch without commits -> rejected
        pd = self.call(ma.cmd_provision, task_id="d", owner="src/d", goal="g")
        self.assertTrue(pd["ok"], pd)
        idd = self.call(ma.cmd_integrate, task_id="d")
        self.assertFalse(idd["ok"], idd)
        self.assertIn("has no commits since base", idd["error"])

        # changes outside ownership -> rejected
        pe = self.call(ma.cmd_provision, task_id="e", owner="src/e", goal="g")
        self.assertTrue(pe["ok"], pe)
        self.commit(pe["worktree"], "src/a/intrude.txt", "X\n")
        ie = self.call(ma.cmd_integrate, task_id="e")
        self.assertFalse(ie["ok"], ie)
        self.assertEqual(ie["error"], "changes outside ownership")
        self.assertEqual(ie["files"], ["src/a/intrude.txt"])
        # integration still clean after rejected integrate
        self.assertEqual(sh("git", "status", "--porcelain", cwd=ma.INTEGRATION), "")


if __name__ == "__main__":
    unittest.main()
