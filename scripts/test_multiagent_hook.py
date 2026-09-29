#!/usr/bin/env python3
"""Testes unitários de scripts/multiagent-hook.py (subprocess puro, sem depender do CLI core).

O CLI de provision é mockado via ATENDON_MULTIAGENT_CLI: um script que grava o argv
recebido (acumulando por provision) e cospe um JSON canônico com substituição
{task_id}/{owner} controlada pelo teste — ownership no formato CANÔNICO do core
(`owner.rstrip('/') + '/'`, cf. norm_owner; owner é PREFIXO DE DIRETÓRIO, ex.:
`scripts/`; a política de owner — globs, ~, monorepo prefix — vive no core
norm_owner e o hook valida só a RESPOSTA do provision).
Rodar: python scripts/test_multiagent_hook.py   (ou python -m unittest)
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "multiagent-hook.py")

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
owner = owner.rstrip("/")  # forma canônica do core norm_owner (prefixo + '/')
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

    def task(self, tid, owner="scripts/", goal=None, **extra):
        d = {"goal": goal or "Implementar o export corrigido no AtendON.",
             "context": "Arquivo: scripts/verify-blockers.ts\n"
                        "task_id: %s\nowner: %s\n[ATENDON-MULTIAGENT]" % (tid, owner)}
        d.update(extra)
        return d

    # ---- pass-through: el hook global no puede bloquear delegações sin marker ----

    def test_pass_through_cases(self):
        # sin marker (o shape sin tasks[]) -> pass-through, sea cual sea cwd/goal
        self.write_response(self.ok_response())
        cases = [
            ({"goal": "Refatorar export del CRM y corregir bug de pasajeros en crm-whatsapp."},
             "/var/www/apps/crm-whatsapp", "delegate_task", None),
            ({"goal": "Pesquisar la arquitectura AtendON y comparar abordajes de export."},
             "/var/www/apps/atendon", "delegate_task", None),
            ({"action": "list"}, "/var/www/apps/atendon", "delegate_task", None),
            ({"command": "ls"}, "/var/www/apps/atendon", "terminal", None),
            ({"goal": "Implementar validação. [ATENDON-MULTIAGENT]",
              "context": "task_id: FLOW-9\nowner: scripts/"},
             "/var/www/apps/atendon", "delegate_task", None),  # marker top-level, sem tasks[]
            (None, "/var/www/apps/atendon", "delegate_task", "isto não é json {"),  # stdin malformado
        ]
        for tool_input, cwd, tool_name, raw_stdin in cases:
            with self.subTest(tool_input=tool_input, tool_name=tool_name):
                proc = self.run_hook(tool_input=tool_input or {}, tool_name=tool_name,
                                     cwd=cwd, raw_stdin=raw_stdin)
                self.assertEqual(self.out(proc), {})
                self.assertEqual(proc.returncode, 0)
                self.assertFalse(os.path.exists(self.record))  # zero provisions

    # ---- activación por marker: exactamente UNA task ----

    def test_marker_shape_blocks(self):
        # contrato singleton: 1 worktree por agente -> exactamente UNA task por invocação
        self.write_response(self.ok_response())
        cases = [
            ({"tasks": [self.task("FLOW-9", owner="scripts/a"),
                        self.task("FLOW-7", owner="scripts/b")]},
             "EXACTAMENTE UNA"),                                   # >1 task
            ({"tasks": [{"goal": "Implementar validação no export AtendON.",
                         "context": "[ATENDON-MULTIAGENT]\ntask_id: FLOW-9"}]},
             "owner"),                                            # sem owner
            ({"tasks": [self.task("bug!!")]}, "task_id"),         # slug inválido
            ({"tasks": [self.task("flow.9")]}, "task_id"),        # slug com ponto
            ({"tasks": [self.task("flow_9")]}, "task_id"),        # slug com underscore
        ]
        for tool_input, fragment in cases:
            with self.subTest(fragment=fragment):
                if os.path.exists(self.record):
                    os.remove(self.record)
                proc = self.run_hook(tool_input=tool_input, cwd="/var/www/apps/atendon")
                out = self.out(proc)
                self.assertEqual(out["action"], "block")
                self.assertIn(fragment, out["message"])
                self.assertFalse(os.path.exists(self.record))  # zero provisions

    def test_provision_failure_blocks(self):
        # owner inválido/sem-owner é rejeitado PELO CORE (norm_owner) antes de
        # criar worktree; o hook bloqueia fail-closed quando o provision falha.
        self.write_response(self.ok_response())
        env = self.env()
        env["MOCK_PROVISION_FAIL_IDS"] = "flow-9"
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]}, env=env)
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("fail closed", out["message"])

    def test_ownership_canonical_contract(self):
        # contrato do core norm_owner: `scripts` -> `scripts/` aceito;
        # resposta sem o sufixo '/' canônico diverge e bloqueia.
        cases = [
            ("scripts", dict(ownership="scripts/"), "modify"),    # canônico aceito
            ("scripts", dict(ownership="scripts"), "block"),      # sem sufixo diverge
        ]
        for owner, resp, expected in cases:
            with self.subTest(resp=resp):
                self.write_response(self.ok_response(**resp))
                proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9", owner=owner)]})
                out = self.out(proc)
                self.assertEqual(out["action"], expected)
                if expected == "block":
                    self.assertIn("ownership", out["message"])

    # ---- provision + modify: tasks[] sem chaves extras, contrato no context ----

    def assert_task_schema_clean(self, task):
        """Nenhuna chave extra: schema de task aceita só goal/context/output_schema/images."""
        self.assertLessEqual(set(task), {"goal", "context", "output_schema", "images"})
        self.assertNotIn("worktree", task)
        self.assertNotIn("branch", task)
        self.assertNotIn("base_sha", task)
        self.assertNotIn("ownership", task)
        self.assertNotIn("task_id", task)
        self.assertNotIn("owner", task)

    def test_provision_and_modify_single_task(self):
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
        self.assertIn("ownership: scripts/", task["context"])
        self.assertIn("PROIBIDO", task["context"])
        self.assertIn("git add .", task["context"])
        self.assertIn("Retorno obrigatório", task["context"])
        # argv repassado ao CLI core: provision individual com o slug normalizado
        argvs = self.recorded_argv()
        self.assertEqual(len(argvs), 1)
        argv = argvs[0]["argv"]
        self.assertIn("provision", argv)
        self.assertIn("--task-id", argv); self.assertIn("flow-9", argv)
        self.assertIn("--owner", argv); self.assertIn("scripts/", argv)
        self.assertIn("--goal", argv)

    def test_task_id_case_normalized(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={"tasks": [self.task("Flow-9")]})  # mixed case
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        self.assertEqual(self.task_ids_called(), ["flow-9"])
        self.assertIn(os.path.join(self.canonical, "flow-9"), out["args"]["tasks"][0]["context"])

    def test_task_id_owner_from_task_goal_text(self):
        self.write_response(self.ok_response())
        proc = self.run_hook(tool_input={
            "tasks": [{"goal": "Corrigir o bug do funil AtendON. task-id: FLOW-42 owner: scripts/funil [ATENDON-MULTIAGENT]"}],
        })
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        argv = self.recorded_argv()[0]["argv"]
        self.assertIn("flow-42", argv)
        self.assertIn("scripts/funil", argv)

    def test_passthrough_output_schema_images(self):
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

    def test_unknown_and_secret_fields_never_leak(self):
        # qualquer campo extra (task input, resposta do provision, segredo)
        # cai fora do schema limpo e não vaza para o subprocesso nem stdout.
        self.write_response(self.ok_response(unknown_field="junk", integration_cmd="rm -rf /",
                                             token=SECRET_SENTINEL, env_password="x9!leak"))
        proc = self.run_hook(tool_input={"tasks": [
            self.task("FLOW-9", evil_key="expandir permissões", cwd="/var/www"),
        ]})
        out = self.out(proc)
        self.assertEqual(out["action"], "modify")
        task = out["args"]["tasks"][0]
        self.assert_task_schema_clean(task)
        for needle in ("evil_key", "expandir permissões", "junk", "rm -rf /",
                       "unknown_field", SECRET_SENTINEL, "x9!leak"):
            self.assertNotIn(needle, proc.stdout)
            self.assertNotIn(needle, json.dumps(out))

    # ---- fail closed: provision quebrado / resposta divergente / worktree errada ----

    def test_provision_divergent_responses_block(self):
        # table-driven: cada case desvia a resposta/ambiente do mock CLI; hook bloqueia fail closed.
        cases = [
            ("exit nonzero", {}, {"MOCK_PROVISION_FAIL_IDS": "flow-9"}, "fail closed"),
            ("invalid JSON", {"raw": "isto não é json"}, {}, "invalid JSON"),
            ("missing keys", {"raw": '{"task_id": "flow-9"}'}, {}, None),
            ("task_id mismatch", {"task_id": "flow-99"}, {}, "task_id"),
            ("branch mismatch", {"branch": "agent/main"}, {}, "branch"),
            ("base_sha invalid", {"base_sha": "not-a-sha"}, {}, None),
            ("ownership mismatch", {"ownership": "apps/backend/"}, {}, "ownership"),
            ("worktree fora do task_id", {"worktree": "outra-pasta"}, {}, "worktree"),
            ("worktree sob /var/www", {"worktree": "/var/www/apps/atendon-wt-divergente"}, {}, "fail closed"),
            ("worktree ausente no disco", {"worktree": "flow-ghost"}, {"MOCK_PROVISION_MKDIR": "0"}, None),
        ]
        for name, resp, env_over, fragment in cases:
            with self.subTest(name):
                if os.path.exists(self.record):  # teardown do mock por case: sem vazamento
                    os.remove(self.record)
                env = dict(self.env(), **env_over)
                if "raw" in resp:
                    self.write_response(raw=resp["raw"])
                else:
                    self.write_response(self.ok_response(**resp))
                proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]}, env=env)
                out = self.out(proc)
                self.assertEqual(out["action"], "block")
                if fragment:
                    self.assertIn(fragment, out["message"])

    # ---- fail closed: provision OK deixa worktree, resposta divergente reporta cleanup ----

    def test_divergent_response_after_provision_reports_cleanup(self):
        # contrato: worktrees NUNCA são removidas pelo hook; provision já feito é
        # reportado para cleanup manual no bloco.
        self.write_response(self.ok_response(branch="agent/main"))  # divergente
        proc = self.run_hook(tool_input={"tasks": [self.task("FLOW-9")]})
        out = self.out(proc)
        self.assertEqual(out["action"], "block")
        self.assertIn("fail closed", out["message"])
        self.assertIn("flow-9", out["message"])        # task_id reportado
        self.assertIn("cleanup manual", out["message"])
        self.assertIn("nunca removida", out["message"])

if __name__ == "__main__":
    unittest.main()