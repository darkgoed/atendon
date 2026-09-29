#!/usr/bin/env python3
"""Hermes pre_tool_call shell hook: auto-provisiona worktree multiagent para
delegações de código AtendON marcadas explicitamente.

Protocolo oficial (https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks):
  stdin  : {"hook_event_name":"pre_tool_call","tool_name":"delegate_task","tool_input":{...},"cwd":...,"profile":...}
  stdout : {"action":"modify","args":{...}}   -> shallow merge nos tool args (só chaves aceitas por delegate_task)
           {"action":"block","message":...}   -> bloqueia
           {}                                 -> no-op (pass-through)
  exit 2 = block fallback (não usado; bloco sai sempre via stdout JSON).

Activación EXPLÍCITA: a delegação deve levar o marker literal [ATENDON-MULTIAGENT]
en goal/context da task (tasks[] de tool_input) para recibir provisioning. Sin
marker -> pass-through. Un única task por invocación (1 worktree por agente):
para N tareas paralelas lança N delegações separadas. goal/context top-level
e delegações sem tasks[] nunca ativan provisioning.

Fails closed no fluxo identificado (delegação marcada com [ATENDON-MULTIAGENT]):
task sem task_id/owner, provision com erro, JSON inválido,
resposta divergente do solicitado, slug/owner inválidos, ou worktree fora do
root canônico /home/deploy/atendon-agents (nunca sob /var/www divergente).
A worktree que um provision deixó atrás num fallo do validate é
reportada no bloco para cleanup manual (nunca removida automáticamente).
Delegações sem marker, controle (list/steer/stop) e tarefas de pesquisa passam.

Contrato com a API real: cada entrada de tasks[] do delegate_task aceita APENAS
goal, context, output_schema, images. task_id/owner NÃO são chaves de task —
vêm da string context/goal de cada task (`task_id: slug`, `owner: prefixo de
diretório relativo ao app, ex.: scripts/`) e o
worktree/branch/base_sha/ownership aprovados são entregues via contrato dentro
do context (nunca como chaves extras).

O integrador registra (não configurado por este script):
  hooks:
    pre_tool_call:
      - matcher: "delegate_task"
        command: "python /home/deploy/atendon-agents/integration/scripts/multiagent-hook.py"
        timeout: 180
        fail_closed: true   # cobre crash/timeout do próprio hook no nível do dispatcher

Runtime CLI: ATENDON_MULTIAGENT_CLI (env) sobrepõe
/home/deploy/atendon-agents/integration/scripts/multiagent.py.
"""
import json
import os
import re
import subprocess
import sys

CANONICAL_ROOT = os.environ.get("ATENDON_CANONICAL_ROOT", "/home/deploy/atendon-agents")   # raiz canônica dos worktrees de agente
FORBIDDEN_ROOT = "/var/www"                      # monorepo divergente — nunca provisionar aí
DEFAULT_CLI = "/home/deploy/atendon-agents/integration/scripts/multiagent.py"
PROVISION_TIMEOUT_S = 120

# Activación explícita: marker literal exigido en la delegação (nunca
# clasificador de lenguaje natural).
MARKER = "[ATENDON-MULTIAGENT]"
# task_id/owner por task: chaves extras em tasks[] NÃO são aceitas pela API
# (schema de task só permite goal/context/output_schema/images), então vêm da
# STRING context/goal de cada entrada.
TASK_ID_RE = re.compile(r"\btask[-_ ]?id\s*[:=]\s*([^\s,;]+)", re.I)
OWNER_RE = re.compile(r"\bowner\s*[:=]\s*([^\s,;]+)", re.I)
SLUG_RE = re.compile(r"^[a-z0-9-]+$")   # alinhado ao core multiagent.py ID_RE (sem ._)
GLOB_CHARS = "*?[]"

WORKER_CONTRACT = (
    "[ATENDON-MULTIAGENT] Regras do worker:\n"
    "Worktree: {worktree} (branch {branch}, base {base_sha}). Trabalhe APENAS neste worktree.\n"
    "task_id: {task_id} | ownership: {ownership} — não toque em arquivos fora do ownership.\n"
    "PROIBIDO: commit/push em main; 'git add .'/root-wide staging (use git add -- <paths> no escopo AtendON); "
    "push em main; build/lint/typecheck/E2E globais — rode apenas os checks mínimos do escopo alterado "
    "(testes do app/diretório modificado).\n"
    "Retorno obrigatório: branch, commit, arquivos alterados, testes executados, riscos."
)

# chaves permitidas em cada tasks[] entry do delegate_task (além de goal/context)
TASK_PASSTHROUGH_KEYS = ("output_schema", "images")


def _no_op():
    print("{}")
    return 0


def _block(message):
    print(json.dumps({"action": "block", "message": message}))
    return 0


def _args_text(args):
    """Texto p/ identificación (marker): SOLO das entradas de tasks[] (contrato
    delegate_task). goal/context top-level não faz parte do protocolo de
    provisioning — a delegação multiagente passa SEMPRE por tasks[]."""
    parts = []
    tasks = args.get("tasks")
    if isinstance(tasks, list):
        parts.extend(_task_text(t) for t in tasks if isinstance(t, dict))
    return "\n".join(parts)


def _slug(raw):
    """task_id case-normalized (lowercase) e validado como slug. None quando inválido/ausente."""
    if not isinstance(raw, str):
        return None
    m = TASK_ID_RE.search(raw)
    if not m:
        return None
    slug = m.group(1).strip("`\"'").strip().lower()
    return slug if SLUG_RE.match(slug) else None


def _check_owner(owner):
    """Owner é PREFIXO DE DIRETÓRIO relativo à raiz do app, ex.: scripts/ ou apps/backend/.

    O core casa ownership por prefixo de diretório (f.startswith(owner)); globs
    (* ? [ ]) nunca casam com nenhum caminho, então rejeita QUALQUER glob ANTES
    de provision. Recusa também os caminhos inseguros do norm_owner do core
    (absoluto, '.', '..', '/', backslash, NUL) além de ~ e prefixo do monorepo
    apps/atendon/. Levanta RuntimeError.
    """
    if not owner or owner in (".", "..", "/"):
        raise RuntimeError("owner ausente ou inseguro: %r" % owner)
    if owner.startswith(("/", "~")) or "\\" in owner or "\x00" in owner or ".." in owner.split("/"):
        raise RuntimeError("owner deve ser caminho relativo ao app root, não %r" % owner)
    if owner == "apps/atendon" or owner.startswith("apps/atendon/"):
        raise RuntimeError("owner deve ser relativo ao app root (ex.: scripts/), não ao monorepo (%r)" % owner)
    if any(c in owner for c in GLOB_CHARS):
        raise RuntimeError("owner é prefixo de diretório; globs (* ? [ ]) não são aceitos (%r)" % owner)
    segs = owner.split("/")
    if not [p for p in segs if p not in ("", ".")]:
        raise RuntimeError("owner inválido: %r" % owner)


def _provision(task_id, owner, goal):
    """Roda provision; retorna dict JSON. Levanta RuntimeError com mensagem curta em qualquer falha."""
    cli = os.environ.get("ATENDON_MULTIAGENT_CLI")
    if cli:
        # override (testes): caminho absoluto, cwd = diretório do CLI
        tail, cwd = [cli], os.path.dirname(os.path.abspath(cli))
    else:
        # interface oficial: `python scripts/multiagent.py provision ...` a partir da raiz do worktree
        root = os.path.dirname(os.path.dirname(os.path.abspath(DEFAULT_CLI)))
        tail, cwd = ["scripts/multiagent.py"], root
    cmd = [sys.executable] + tail + ["provision", "--task-id", task_id, "--owner", owner, "--goal", goal]
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=PROVISION_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise RuntimeError("provision timed out (%ds)" % PROVISION_TIMEOUT_S)
    if proc.returncode != 0:
        raise RuntimeError("provision exited %d" % proc.returncode)
    try:
        info = json.loads(proc.stdout)
    except ValueError:
        raise RuntimeError("provision returned invalid JSON")
    if not isinstance(info, dict):
        raise RuntimeError("provision JSON is not an object")
    for key in ("task_id", "branch", "worktree", "base_sha", "ownership"):
        if not isinstance(info.get(key), str) or not info[key]:
            raise RuntimeError("provision JSON missing key %r" % key)
    return info


def _validate_response(task_id, owner, info):
    """Resposta do provision tem que BATER com o solicitado. Levanta RuntimeError.

    Contrato core (multiagent.py): ownership canônico `owner.rstrip('/') + '/'`
    (owner já validado por _check_owner), branch exatamente `agent/{task_id}`,
    worktree exatamente `{CANONICAL_ROOT}/{task_id}` (comparação via realpath).
    """
    expected_owner = owner.rstrip("/") + "/"
    if info["task_id"].strip().lower() != task_id:
        raise RuntimeError("provision devolveu task_id %r, solicitado %r" % (info["task_id"], task_id))
    if info["ownership"].strip().lower() != expected_owner.lower():
        raise RuntimeError("provision devolveu ownership %r, solicitado %r" % (info["ownership"], expected_owner))
    if info["branch"].lower() != ("agent/" + task_id):
        raise RuntimeError("branch %r não corresponde exatamente a %r" % (info["branch"], "agent/" + task_id))
    if not re.fullmatch(r"[0-9a-f]{7,40}", info["base_sha"].lower()):
        raise RuntimeError("base_sha %r não é um sha git válido" % info["base_sha"])
    worktree = info["worktree"]
    if not os.path.isabs(worktree):
        raise RuntimeError("provision worktree is not absolute")
    real = os.path.realpath(worktree)
    expected_wt = os.path.realpath(CANONICAL_ROOT) + os.sep + task_id
    if real != expected_wt:
        raise RuntimeError("provision worktree %r não corresponde exatamente a %r" % (worktree, expected_wt))
    if real == os.path.realpath(FORBIDDEN_ROOT) or (real + os.sep).startswith(os.path.realpath(FORBIDDEN_ROOT) + os.sep):
        raise RuntimeError("refusing worktree under divergent %s" % FORBIDDEN_ROOT)
    if not os.path.isdir(real):
        raise RuntimeError("provision worktree does not exist: %s" % worktree)


def _new_task(t, info):
    """Nova entrada de task com APENAS chaves aceitas pelo schema: goal, context
    (+ output_schema/images se vierem) — nunca worktree/branch/task_id/owner como chaves."""
    nt = {}
    if isinstance(t.get("goal"), str) and t["goal"].strip():
        nt["goal"] = t["goal"]
    contract = WORKER_CONTRACT.format(**info)
    ctx = t.get("context")
    nt["context"] = (ctx + "\n\n" + contract) if isinstance(ctx, str) and ctx.strip() else contract
    for key in TASK_PASSTHROUGH_KEYS:
        if key in t:
            nt[key] = t[key]
    return nt


def _task_text(t):
    return "\n".join(t[k] for k in ("goal", "context") if isinstance(t.get(k), str))


def handle(payload):
    """Um evento pre_tool_call -> (stdout_json, exit_code)."""
    if not isinstance(payload, dict):
        return _no_op()
    if payload.get("tool_name") != "delegate_task":
        return _no_op()
    args = payload.get("tool_input") or {}
    if not isinstance(args, dict):
        args = {}
    # delegação sem spawn (controle de subagentes vivos): não provisiona, não bloqueia
    if str(args.get("action") or "").strip().lower() in ("list", "steer", "stop"):
        return _no_op()
    try:
        # identificação: falha aqui NUNCA bloqueia (hook global — outras delegações devem passar)
        try:
            text = _args_text(args)
        except Exception:
            text = ""
        if not (isinstance(text, str) and MARKER in text):
            return _no_op()  # sin marker -> pass-through (pesquisa/análisis no-multiagente)
        tasks = args.get("tasks")
        if not (isinstance(tasks, list) and len(tasks) == 1 and isinstance(tasks[0], dict)):
            return _block("AtendON multiagent hook fail closed: delegação [ATENDON-MULTIAGENT] "
                          "requiere EXACTAMENTE UNA task em tasks[] (1 worktree por agente; "
                          "para N tareas paralelas lança N delegações) em vez de %r" % (
                              "spawn top-level" if not isinstance(tasks, list) else
                              "tasks[] com %d entradas" % len(tasks)))
        t = tasks[0]
        ttext = _task_text(t)
        task_id = _slug(ttext)
        if not task_id:
            return _block("AtendON multiagent hook fail closed: task_id ausente ou slug inválido "
                          "(esperado `task_id: slug` em goal/context)")
        m = OWNER_RE.search(ttext)
        owner = m.group(1).strip("`\"'").strip() if m else None
        try:
            _check_owner(owner)
        except RuntimeError as exc:
            return _block("AtendON multiagent hook fail closed: %s" % exc)
        goal = (t.get("goal") if isinstance(t.get("goal"), str) else "") or ttext.strip()[:500]
        provisioned = False
        try:
            info = _provision(task_id, owner, goal)
            provisioned = True
            _validate_response(task_id, owner, info)
        except Exception as exc:
            msg = "AtendON multiagent hook fail closed: %s" % exc
            if provisioned:
                msg += (" | Worktree DEIXADA (cleanup manual — nunca removida "
                        "automáticamente): task_id=%s" % task_id)
            return _block(msg)
        print(json.dumps({"action": "modify", "args": {"tasks": [_new_task(t, info)]}}))
        return 0
    except Exception as exc:  # fail closed no caminho identificado
        return _block("AtendON multiagent hook fail closed: %s" % exc)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(_no_op())
    sys.exit(handle(payload))


if __name__ == "__main__":
    main()