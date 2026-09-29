#!/usr/bin/env python3
"""Testes unitários de scripts/multiagent-hook.py (subprocess puro, sem depender do CLI core).

O CLI de provision é mockado via ATENDON_MULTIAGENT_CLI: um script que grava o argv
recebido (acumulando por provision) e cospe um JSON canônico com substituição
{task_id}/{owner} controlada pelo teste — ownership no formato CANÔNICO do core
(`owner.rstrip('/') + '/'`, cf. norm_owner). Os testes de CONTRATO carregam o
multiagent.py REAL (norm_owner/ID_RE) em fixture e o usam como fonte canônica.
Rodar: python scripts/test_multiagent_hook.py   (ou python -m unittest)
"""
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "multiagent-hook.py")
DEFAULT_CORE = os.environ.get("ATENDON_MULTIAGENT_CORE",
                              "/home/deploy/atendon-agents/integration/scripts/multiagent.py")

MOCK_CLI = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
path = os.environ["MOCK_PROVISION_RECORD"]
items = []
if os.path.exists(path):
    items = json.load(open(path))
items.append({"argv": args, "cwd": os.getcwd()})
json.dump(items, open(path, "w"))
tid = args[args.index("--task-id") + 1] if "--task-id" in args else ""
owner = args[args.index("--owner") + 1] if "--owner" in args else ""
raw = open(os.environ["MOCK_PROVISION_RESPONSE"]).read()
try:
    tpl = json.loads(raw)
    info = json.loads(json.dumps(tpl).replace("{task_id}", tid).replace("{owner}", owner))
except ValueError:  # resposta proposital inválida: ecoa cru para o hook rejeitar
    sys.stdout.write(raw)
    sys.exit(0)
if tid in os.environ.get("MOCK_PROVISION_FAIL_IDS", "").split(","):
    sys.exit(int(os.environ.get("MOCK_PROVISION_FAIL_EXIT", "1")))
if os.environ.get("MOCK_PROVISION_MKDIR", "1") == "1":
    os.makedirs(info["worktree"], exist_ok=True)
sys.stdout.write(json.dumps(info))
'''

# CLI de contrato: usa o norm_owner/ID_RE do multiagent.py REAL para canonicar
# o ownership exatamente como o core faz (branch agent/{tid}, worktree {root}/{tid}).
CONTRACT_CLI = r'''#!/usr/bin/env python3
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("core_multiagent", os.environ["CONTRACT_CORE"])
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
args = sys.argv[1:]
path = os.environ["MOCK_PROVISION_RECORD"]
items = []
if os.path.exists(path):
    items = json.load(open(path))
items.append({"argv": args, "cwd": os.getcwd()})
json.dump(items, open(path, "w"))
tid = args[args.index("--task-id") + 1]
owner = args[args.index("--owner") + 1]
if not core.ID_RE.match(tid):
    core.die("invalid task id %r: must match [a-z0-9-]+" % tid)
info = {
    "task_id": tid,
    "branch": "agent/" + tid,
    "worktree": os.environ["ATENDON_CANONICAL_ROOT"].rstrip("/") + "/" + tid,
    "base_sha": "916c7ff7deadbeef",
    "ownership": core.norm_owner(owner),
}
if os.environ.get("MOCK_PROVISION_MKDIR", "1") == "1":
    os.makedirs(info["worktree"], exist_ok=True)
sys.stdout.write(json.dumps(info))
'''

RESPONSE_TEMPLATE = {
    "task_id": "{task_id}",
    "branch": "agent/{task_id}",
    "base_sha": "916c7ff7deadbeef",
    "ownership": "{owner}/",   # formato canônico do core norm_owner (rstrip('/') + '/')
}
SECRET_SENTINEL = "«redacted:sk-…»"


class HookTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="multiagent-hook-test-")
        self.canonical = os.path.join(self.tmp, "canon")  # raiz canônica fingida p/ os testes
        os.makedirs(self.canonical)
        self.cli = os.path.join(self.tmp, "mock-multiagent.py")
        with open(self.cli, "w") as f:
            f.write(MOCK_CLI)
        os.chmod(self.cli, os.stat(self.cli).st_mode | stat.S_IEXEC)
        self.record = os.path.join(self.tmp, "argv.json")
        self.response = os.path.join(self.tmp, "response.json")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- helpers ----

    def write_response(self, obj=None, raw=None):
        with open(self.response, "w") as f:
            f.write(raw if raw is not None else json.dumps(obj or {}))

    def ok_response(self, worktree="{task_id}", **over):
        r = dict(RESPONSE_TEMPLATE, worktree=os.path.join(self.canonical, worktree))
        r.update(over)
        return r

    def env(self):
        e = dict(os.environ)
        e["ATENDON_MULTIAGENT_CLI"] = self.cli
        e["ATENDON_CANONICAL_ROOT"] = self.canonical
        e["MOCK_PROVISION_RECORD"] = self.record
        e["MOCK_PROVISION_RESPONSE"] = self.response
        e.pop("MOCK_PROVISION_FAIL_IDS", None)
        e.pop("MOCK_PROVISION_MKDIR", None)
        return e

    def run_hook(self, tool_input=None, tool_name="delegate_task", cwd="/var/www/apps/atendon",
                 raw_stdin=None, env=None):
        payload = None if raw_stdin is not None else {
            "hook_event_name": "pre_tool_call", "tool_name": tool_name,
            "tool_input": tool_input or {}, "cwd": cwd, "profile": "daybreak",
        }
        proc = subprocess.run(
            [sys.executable, HOOK],
            input=raw_stdin if raw_stdin is not None else json.dumps(payload),
            capture_output=True, text=True, timeout=60,
            env=env or self.env(),
        )
        return proc

    def out(self, proc):
        return json.loads(proc.stdout)

    def recorded_argv(self):
        with open(self.record) as f:
            return json.load(f)

    def task_ids_called(self):
        argvs = self.recorded_argv()
        return [a["argv"][a["argv"].index("--task-id") + 1] for a in argvs]

    def task(self, tid, owner="scripts/foo/*", goal=None, **extra):
        d = {"goal": goal or "Implementar o export corrigido no AtendON.",
             "context": "Arquivo: scripts/verify-blockers.ts\n"
                        "task_id: %s\nowner: %s" % (tid, owner)}
        d.update(extra)
        return d

    # ---- pass-through: o hook global não pode bloquear outras delegações ----

    def test_non_atendon_delegation_passes(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={
            "goal": "Refatorar export do CRM e corrigir bug de passageiros no crm-whatsapp.",
        }, cwd="/var/www/apps/crm-whatsapp")
        self.assertEqual(self.out(proc), {})
        self.assertFalse(os.path.exists(self.record))

    def test_atendon_research_non_code_passes(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={
            "goal": "Pesquisar a arquitetura AtendON, investigar o funil e comparar abordagens de export.",
        }, cwd="/var/www/apps/atendon")
        self.assertEqual(self.out(proc), {})
        self.assertFalse(os.path.exists(self.record))

    def test_control_action_passes(self):
        proc = self.run_hook(tool_input={"action": "list"})
        self.assertEqual(self.out(proc), {})

    def test_other_tool_passes(self):
        proc = self.run_hook(tool_input={"command": "ls"}, tool_name="terminal")
        self.assertEqual(self.out(proc), {})

    def test_malformed_stdin_passes(self):
        proc = self.run_hook(raw_stdin="isto não é json {")
        self.assertEqual(self.out(proc), {})
        self.assertEqual(proc.returncode, 0)

    # ---- fail closed: código AtendON sem task_id/owner ----

    def test_atendon_code_without_task_id_blocks(self):
        proc = self.run_hook(tool_input={
            "goal": "Implementar validação de passageiros no export AtendON e testar.",
            "context": "owner: scripts/verify-blockers.ts",
        }, cwd="/var/www/apps/atendon")
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("task_id", out["message"])

    def test_atendon_code_without_owner_blocks(self):
        proc = self.run_hook(tool_input={
            "goal": "Implementar validação de passageiros no export AtendON.",
            "context": "task_id: FLOW-9",
        }, cwd="/var/www/apps/atendon")
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("owner", out["message"])

    def test_owner_monorepo_prefix_blocks(self):
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", owner="apps/atendon/scripts/*"),
        ]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("app root", out["message"])
        self.assertFalse(os.path.exists(self.record))

    def test_owner_absolute_blocks(self):
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", owner="/etc/passwd"),
        ]})
        self.assertEqual(self.out(proc)["action"], "block")

    def test_owner_traversal_blocks(self):
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", owner="scripts/../other/*"),
        ]})
        self.assertEqual(self.out(proc)["action"], "block")

    def test_task_id_invalid_slug_blocks(self):
        proc = self.run_hook(tool_input={"tasks": [
            self.task("bug!!"),
        ]})
        self.assertEqual(self.out(proc)["action"], "block")
        self.assertFalse(os.path.exists(self.record))

    def test_task_id_slug_aligned_with_core_id_re(self):
        # divergência fechada: core ID_RE = [a-z0-9-]+ — slug com . ou _ bloqueia
        self.write_response(self.ok_response())
        for tid in ("flow.9", "flow_9"):
            proc = self.run_hook(tool_input={"tasks": [self.task(tid)]})
            self.assertEqual(self.out(proc)["action"], "block", msg=tid)
            self.assertFalse(os.path.exists(self.record), msg=tid)

    def test_owner_glob_outside_last_segment_blocks(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", owner="sc*pts/foo/*"),
        ]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("glob", out["message"])
        self.assertFalse(os.path.exists(self.record))

    def test_ownership_canonical_core_form_accepted(self):
        # bug 2a6a68ac: core norm_owner devolve `scripts` -> `scripts/`; hook deve aceitar
        self.write_response(self.ok_response(ownership="scripts/"))
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9", owner="scripts")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        self.assertIn("ownership: scripts/", out["args"]["tasks"][0]["context"])

    def test_ownership_non_canonical_form_blocks(self):
        # forma antiga (sem sufixo '/') diverge do contrato do core
        self.write_response(self.ok_response(ownership="scripts"))
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9", owner="scripts")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("ownership", out["message"])

    # ---- provision + modify: tasks[] sem chaves extras, contrato no context ----

    def assert_task_schema_clean(self, task):
        """Nenhuma chave extra: schema de task aceita só goal/context/output_schema/images."""
        self.assertLessEqual(set(task), {"goal", "context", "output_schema", "images"})
        self.assertNotIn("worktree", task)
        self.assertNotIn("branch", task)
        self.assertNotIn("base_sha", task)
        self.assertNotIn("ownership", task)
        self.assertNotIn("task_id", task)
        self.assertNotIn("owner", task)

    def test_provision_and_modify_batch(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        wt = os.path.join(self.canonical, "flow-9")  # slug case-normalized
        task = out["args"]["tasks"][0]
        self.assert_task_schema_clean(task)
        self.assertEqual(task["goal"], "Implementar o export corrigido no AtendON.")
        self.assertIn("Arquivo: scripts/verify-blockers.ts", task["context"])  # context original
        self.assertIn("[ATENDON-MULTIAGENT]", task["context"])  # contrato injetado no context
        self.assertIn(wt, task["context"])
        self.assertIn("agent/flow-9", task["context"])
        self.assertIn("916c7ff7deadbeef", task["context"])
        self.assertIn("scripts/foo/*", task["context"])
        self.assertIn("PROIBIDO", task["context"])
        self.assertIn("git add .", task["context"])
        self.assertIn("Retorno obrigatório", task["context"])
        # argv repassado ao CLI core: provision individual com o slug normalizado
        argvs = self.recorded_argv()
        self.assertEqual(len(argvs), 1)
        argv = argvs[0]["argv"]
        self.assertIn("provision", argv)
        self.assertIn("--task-id", argv); self.assertIn("flow-9", argv)
        self.assertIn("--owner", argv); self.assertIn("scripts/foo/*", argv)
        self.assertIn("--goal", argv)

    def test_batch_two_tasks_distinct_worktrees(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", owner="scripts/a/*"),
            self.task("FLOW-7", owner="scripts/b/*"),
        ]})
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        tasks = out["args"]["tasks"]
        self.assertEqual(len(tasks), 2)
        wt9 = os.path.join(self.canonical, "flow-9")
        wt7 = os.path.join(self.canonical, "flow-7")
        self.assertNotEqual(wt9, wt7)
        self.assertEqual(tasks[0]["context"].count(wt9), 1)
        self.assertEqual(tasks[1]["context"].count(wt7), 1)
        self.assertNotIn(wt9, tasks[1]["context"])  # nunca a mesma worktree para múltiplos
        self.assertNotIn(wt7, tasks[0]["context"])
        for t in tasks:
            self.assert_task_schema_clean(t)
        self.assertEqual(self.task_ids_called(), ["flow-9", "flow-7"])  # provision individual

    def test_task_id_case_normalized(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={"tasks": [self.task("Flow-9")]})  # mixed case
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        self.assertEqual(self.task_ids_called(), ["flow-9"])
        self.assertIn(os.path.join(self.canonical, "flow-9"), out["args"]["tasks"][0]["context"])

    def test_task_id_owner_from_text_fallback(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={
            "goal": "Corrigir o bug do funil AtendON. task-id: FLOW-42 owner: scripts/funil/**",
        })
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        argv = self.recorded_argv()[0]["argv"]
        self.assertIn("flow-42", argv)
        self.assertIn("scripts/funil/**", argv)

    def test_single_goal_form_modify(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={
            "goal": "Implementar teste do export AtendON.",
            "context": "task_id: FLOW-9\nowner: scripts/verify-blockers.ts",
        })
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        self.assertEqual(out["args"]["goal"], "Implementar teste do export AtendON.")
        self.assertNotIn("tasks", out["args"])
        self.assertIn("[ATENDON-MULTIAGENT]", out["args"]["context"])
        self.assertIn("Retorno obrigatório", out["args"]["context"])

    def test_batch_passthrough_output_schema_images(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", output_schema={"type": "object"}, images=["x.png"]),
        ]})
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        task = out["args"]["tasks"][0]
        self.assertEqual(task["output_schema"], {"type": "object"})
        self.assertEqual(task["images"], ["x.png"])
        self.assert_task_schema_clean(task)

    def test_unknown_task_fields_dropped(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", evil_key="expandir permissões", cwd="/var/www"),
        ]})
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        task = out["args"]["tasks"][0]
        self.assert_task_schema_clean(task)
        self.assertNotIn("evil_key", task)
        self.assertNotIn("expandir permissões", proc.stdout)
        self.assertNotIn("expandir permissões", json.dumps(out))

    def test_unknown_provision_response_fields_dropped(self):
        self.write_response(dict(self.ok_response(), unknown_field="junk",
                                 integration_cmd="rm -rf /"))
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        task = out["args"]["tasks"][0]
        self.assert_task_schema_clean(task)
        self.assertNotIn("junk", task["context"])
        self.assertNotIn("rm -rf /", proc.stdout)
        self.assertNotIn("unknown_field", json.dumps(out))

    # ---- contrato entre camadas: multiagent.py REAL como fonte canônica ----

    def _load_module(self, path, name):
        self.assertTrue(os.path.exists(path), "módulo ausente: %s" % path)
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            self.fail("spec inválido para %s" % path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def _contract_env(self):
        env = self.env()
        env["CONTRACT_CORE"] = DEFAULT_CORE
        env["MOCK_PROVISION_MKDIR"] = "1"
        return env

    @unittest.skipUnless(os.path.exists(DEFAULT_CORE), "core multiagent.py ausente")
    def test_contract_real_core_norm_owner_matches_hook(self):
        # in-process: norm_owner REAL do core == canonical_owner do hook para toda owner
        core = self._load_module(DEFAULT_CORE, "core_multiagent")
        hook = self._load_module(HOOK, "hook_module")
        for owner in ("scripts", "scripts/foo", "scripts/foo/*", "scripts/funil/**",
                      "a.b-c/d_e/f", "scripts/", "scripts//foo/*", ".x/y"):
            self.assertEqual(core.norm_owner(owner), hook.canonical_owner(owner), msg=owner)
        # slug: conjunto aceito pelo hook == aceito pelo core ID_RE (case-normalized)
        for slug in ("flow-9", "a", "flow9", "9flow", "a-1-b"):
            self.assertTrue(core.ID_RE.match(slug), msg=slug)
            self.assertTrue(hook.SLUG_RE.match(slug), msg=slug)
        for slug in ("flow.9", "flow_9"):
            self.assertFalse(hook.SLUG_RE.match(slug), msg=slug)
        # "-" é aceito por AMBOS (core ID_RE casa com "-"): contrato simétrico
        self.assertTrue(hook.SLUG_RE.match("-"))
        self.assertTrue(core.ID_RE.match("-"))

    @unittest.skipUnless(os.path.exists(DEFAULT_CORE), "core multiagent.py ausente")
    def test_contract_e2e_real_core_batch_two_worktrees(self):
        # end-to-end: CLI de contrato roda o norm_owner/ID_RE REAL do core num batch
        # de 2 tasks com worktrees distintas; hook aceita o ownership canônico core.
        cli = os.path.join(self.tmp, "contract-multiagent.py")
        with open(cli, "w") as f:
            f.write(CONTRACT_CLI)
        os.chmod(cli, os.stat(cli).st_mode | stat.S_IEXEC)
        self.record = os.path.join(self.tmp, "argv-contract.json")
        env = self._contract_env()
        env["ATENDON_MULTIAGENT_CLI"] = cli
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", owner="scripts"),
            self.task("FLOW-7", owner="scripts/foo/*"),
        ]}, env=env)
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        t0, t1 = out["args"]["tasks"]
        self.assertIn("ownership: scripts/", t0["context"])          # canônico core
        self.assertIn("ownership: scripts/foo/*/", t1["context"])
        wt9 = os.path.join(self.canonical, "flow-9")
        wt7 = os.path.join(self.canonical, "flow-7")
        self.assertEqual(t0["context"].count(wt9), 1)
        self.assertEqual(t1["context"].count(wt7), 1)
        self.assertNotIn(wt9, t1["context"])
        self.assertNotIn(wt7, t0["context"])
        self.assertNotEqual(wt9, wt7)
        for t in (t0, t1):
            self.assert_task_schema_clean(t)
            self.assertIn("agent/flow-", t["context"])
        self.assertEqual(self.task_ids_called(), ["flow-9", "flow-7"])

    @unittest.skipUnless(os.path.exists(DEFAULT_CORE), "core multiagent.py ausente")
    def test_contract_e2e_real_core_rejects_unsafe_owner(self):
        # norm_owner REAL do core morre (exit 1) em owner inseguro → hook fail closed
        cli = os.path.join(self.tmp, "contract-multiagent.py")
        with open(cli, "w") as f:
            f.write(CONTRACT_CLI)
        os.chmod(cli, os.stat(cli).st_mode | stat.S_IEXEC)
        self.record = os.path.join(self.tmp, "argv-contract.json")
        env = self._contract_env()
        env["ATENDON_MULTIAGENT_CLI"] = cli
        env["MOCK_PROVISION_MKDIR"] = "1"
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", owner="scripts/../etc/*"),
        ]}, env=env)
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("fail closed", out["message"])

    # ---- fail closed: provision quebrado / resposta divergente / worktree errada ----

    def test_provision_exit_nonzero_blocks(self):
        self.write_response(self.ok_response())
        env = self.env()
        env["MOCK_PROVISION_FAIL_IDS"] = "flow-9"
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]}, env=env)
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("fail closed", out["message"])

    def test_provision_invalid_json_blocks(self):
        self.write_response(raw="isto não é json")
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("invalid JSON", out["message"])

    def test_provision_missing_keys_blocks(self):
        self.write_response({"task_id": "flow-9"})
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        self.assertEqual(self.out(proc)["action"], "block")

    def test_provision_task_id_mismatch_blocks(self):
        self.write_response(self.ok_response(task_id="flow-99"))  # fixo, divergente do solicitado
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("task_id", out["message"])

    def test_provision_branch_mismatch_blocks(self):
        self.write_response(self.ok_response(branch="agent/main"))  # branch sem o task_id
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("branch", out["message"])

    def test_provision_base_sha_invalid_blocks(self):
        self.write_response(self.ok_response(base_sha="not-a-sha"))
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        self.assertEqual(self.out(proc)["action"], "block")

    def test_provision_ownership_mismatch_blocks(self):
        self.write_response(self.ok_response(ownership="scripts/other/*"))  # divergente do owner
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("ownership", out["message"])

    def test_worktree_outside_task_id_blocks(self):
        self.write_response(self.ok_response(worktree="outra-pasta"))  # nome não bate com o ID
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("worktree", out["message"])

    def test_worktree_under_varwww_blocks(self):
        divergent = "/var/www/apps/atendon-wt-divergente"
        self.write_response(self.ok_response(worktree=divergent))
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("fail closed", out["message"])

    def test_worktree_missing_on_disk_blocks(self):
        env = self.env()
        env["MOCK_PROVISION_MKDIR"] = "0"  # CLI não criou o worktree
        self.write_response(self.ok_response(worktree="flow-ghost"))
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]}, env=env)
        self.assertEqual(self.out(proc)["action"], "block")

    # ---- fail closed: batch inteiro bloqueado + cleanup manual reportado ----

    def test_batch_second_task_fails_blocks_all_and_reports_first(self):
        self.write_response(self.ok_response())
        env = self.env()
        env["MOCK_PROVISION_FAIL_IDS"] = "flow-7"
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", owner="scripts/a/*"),
            self.task("FLOW-7", owner="scripts/b/*"),
        ]}, env=env)
        out = self.out(proc)
        self.assertEqual(out["action"], "block")  # batch INTEIRO bloqueado
        self.assertIn("fail closed", out["message"])
        self.assertIn("flow-9", out["message"])  # provision parcial reportado p/ cleanup manual
        self.assertIn("cleanup manual", out["message"])
        self.assertIn("flow-7", out["message"])
        self.assertEqual(self.task_ids_called(), ["flow-9", "flow-7"])

    def test_batch_member_without_identifier_blocks(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", owner="scripts/a/*"),
            {"goal": "Revisar arquivos alterados no AtendON e rodar testes."},  # sem task_id/owner
        ]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("tasks[1]", out["message"])
        self.assertIn("task_ids: flow-9", out["message"])  # cleanup manual do primeiro
        self.assertNotIn("action\": \"modify", proc.stdout)

    def test_duplicate_task_id_blocks(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", owner="scripts/a/*"),
            self.task("flow-9", owner="scripts/b/*"),  # mesmo ID (case-normalizado)
        ]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("duplicado", out["message"])
        self.assertEqual(self.task_ids_called(), ["flow-9"])  # 1 worktree por agente

    # ---- não vazar segredos ----

    def test_extra_secret_fields_do_not_leak(self):
        self.write_response(dict(self.ok_response(), token=SECRET_SENTINEL, env_password="x9!leak"))
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        self.assertNotIn(SECRET_SENTINEL, proc.stdout)
        self.assertNotIn("x9!leak", proc.stdout)


if __name__ == "__main__":
    unittest.main()


