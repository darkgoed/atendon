#!/usr/bin/env python3
"""Hermes pre_tool_call shell hook: auto-provisiona worktree multiagent para delegações de código AtendON.

Protocolo oficial (https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks):
  stdin  : {"hook_event_name":"pre_tool_call","tool_name":"delegate_task","tool_input":{...},"cwd":...,"profile":...}
  stdout : {"action":"modify","args":{...}}   -> shallow merge nos tool args (só chaves aceitas por delegate_task)
           {"action":"block","message":...}   -> bloqueia
           {}                                 -> no-op (pass-through)
  exit 2 = block fallback (não usado; bloco sai sempre via stdout JSON).

Fails closed no fluxo identificado (delegação AtendON + intenção de código):
sem task_id/owner em ALGUMA task do batch, provision com erro, JSON inválido,
resposta divergente do solicitado, slug/owner inválidos, ou worktree fora do
root canônico /home/deploy/atendon-agents (nunca sob /var/www divergente).
Um batch com QUALQUER task problemática é bloqueado inteiro; provisions já
feitos são reportados no bloco para cleanup manual (worktrees NUNCA são
removidas automaticamente). Delegações não-AtendON, controle (list/steer/stop)
e tarefas de pesquisa passam.

Contrato com a API real: cada entrada de tasks[] do delegate_task aceita APENAS
goal, context, output_schema, images. task_id/owner NÃO são chaves de task —
vêm da string context/goal de cada task (`task_id: slug`, `owner: path`) e o
worktree/branch/base_sha/ownership aprovados são entregues via contrato dentro
do context (nunca como chaves extras).

O integrador registra (não configurado por este script):
  hooks:
    pre_tool_call:
      - matcher: "delegate_task"
        command: "python /home/deploy/atendon-agents/flow-tests/scripts/multiagent-hook.py"
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

# intenção de código (qualquer match basta). Pesquisa pura não casa.
CODE_RE = re.compile(
    r"\b(implement\w*|refator\w*|corrig\w*|fix\w*|criar|edit\w*|escrev\w*|migr\w*|"
    r"commit\w*|test\w*|build\w*|deploy\w*|instal\w*|configur\w*|adicion\w*|"
    r"atualiz\w*|remov\w*|desenvolv\w*|bug|lint)\b",
    re.I,
)
# task_id/owner por task: chaves extras em tasks[] NÃO são aceitas pela API
# (schema de task só permite goal/context/output_schema/images), então vêm da
# STRING context/goal de cada entrada.
TASK_ID_RE = re.compile(r"\btask[-_ ]?id\s*[:=]\s*([^\s,;]+)", re.I)
OWNER_RE = re.compile(r"\bowner\s*[:=]\s*([^\s,;]+)", re.I)
SLUG_RE = re.compile(r"^[a-z0-9-]+$")   # alinhado ao core multiagent.py ID_RE (sem ._)
GLOB_CHARS = "*?["


def _owner_segments(owner):
    return owner.split("/")

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
    """Concatena goal/context (topo e por tarefa) numa só string para os filtros."""
    parts = []
    for key in ("goal", "context"):
        val = args.get(key)
        if isinstance(val, str):
            parts.append(val)
    tasks = args.get("tasks")
    if isinstance(tasks, list):
        for t in tasks:
            if isinstance(t, dict):
                for key in ("goal", "context"):
                    val = t.get(key)
                    if isinstance(val, str):
                        parts.append(val)
    return "\n".join(parts)


def _is_atendon(text, cwd):
    if "atendon" in text.lower():
        return True
    if not cwd or not isinstance(cwd, str):
        return False
    real = os.path.realpath(cwd)
    return (real.startswith(os.path.realpath("/var/www/apps/atendon") + os.sep)
            or real.startswith(os.path.realpath(CANONICAL_ROOT) + os.sep)
            or real == os.path.realpath("/var/www/apps/atendon"))


def _slug(raw):
    """task_id case-normalized (lowercase) e validado como slug. None quando inválido/ausente."""
    if not isinstance(raw, str):
        return None
    m = TASK_ID_RE.search(raw)
    if not m:
        return None
    slug = m.group(1).strip("`\"'").strip().lower()
    return slug if SLUG_RE.match(slug) else None


def _extract_owner(text):
    if not isinstance(text, str):
        return None
    m = OWNER_RE.search(text)
    if not m:
        return None
    return m.group(1).strip("`\"'").strip()


def _check_owner(owner):
    """Owner é relativo à raiz do app (app root canônico remoto), ex.: scripts/foo/*.

    Recusa os mesmos caminhos inseguros do norm_owner do core (absoluto, '.', '..',
    '/', backslash, NUL) além de ~, prefixo do monorepo apps/atendon/ e glob
    inválido (caracteres de glob fora do último segmento). Levanta RuntimeError.
    """
    if not owner or owner in (".", "..", "/"):
        raise RuntimeError("owner ausente ou inseguro: %r" % owner)
    if owner.startswith(("/", "~")) or "\\" in owner or "\x00" in owner or ".." in owner.split("/"):
        raise RuntimeError("owner deve ser caminho relativo ao app root, não %r" % owner)
    if owner == "apps/atendon" or owner.startswith("apps/atendon/"):
        raise RuntimeError("owner deve ser relativo ao app root (ex.: scripts/*), não ao monorepo (%r)" % owner)
    segs = _owner_segments(owner)
    if any(any(c in seg for c in GLOB_CHARS) for seg in segs[:-1]):
        raise RuntimeError("owner com glob inválido: globs só no último segmento (%r)" % owner)
    if not [p for p in segs if p not in ("", ".")]:
        raise RuntimeError("owner inválido: %r" % owner)


def canonical_owner(owner):
    """Ownership canônico do core (multiagent.py norm_owner): `owner.rstrip('/') + '/'`.

    Exige owner seguro relativo (sem glob inválido) antes de canonicar.
    """
    _check_owner(owner)
    return "/".join(p for p in owner.split("/") if p not in ("", ".")) + "/"


def _task_text(t):
    return "\n".join(t[k] for k in ("goal", "context") if isinstance(t.get(k), str))


def _cli_command():
    """([argv-tail], cwd) para chamar o CLI de provision conforme a interface documentada."""
    cli = os.environ.get("ATENDON_MULTIAGENT_CLI")
    if cli:
        # override (testes): caminho absoluto, cwd = diretório do CLI
        return [cli], os.path.dirname(os.path.abspath(cli))
    # interface oficial: `python scripts/multiagent.py provision ...` a partir da raiz do worktree
    root = os.path.dirname(os.path.dirname(os.path.abspath(DEFAULT_CLI)))
    return ["scripts/multiagent.py"], root


def _provision(task_id, owner, goal):
    """Roda provision; retorna dict JSON. Levanta RuntimeError com mensagem curta em qualquer falha."""
    tail, cwd = _cli_command()
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

    Contrato core (multiagent.py): ownership canônico `owner.rstrip('/') + '/'`,
    branch exatamente `agent/{task_id}`, worktree exatamente
    `{CANONICAL_ROOT}/{task_id}` (comparação via realpath).
    """
    expected_owner = canonical_owner(owner)  # valida owner seguro relativo sem glob inválido
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


def _contract(info):
    return WORKER_CONTRACT.format(**info)


def _new_task(t, info):
    """Nova entrada de task com APENAS chaves aceitas pelo schema: goal, context
    (+ output_schema/images se vierem) — nunca worktree/branch/task_id/owner como chaves."""
    nt = {}
    if isinstance(t.get("goal"), str) and t["goal"].strip():
        nt["goal"] = t["goal"]
    contract = _contract(info)
    ctx = t.get("context")
    nt["context"] = (ctx + "\n\n" + contract) if isinstance(ctx, str) and ctx.strip() else contract
    for key in TASK_PASSTHROUGH_KEYS:
        if key in t:
            nt[key] = t[key]
    return nt


def _modify_batch_args(args, parsed):
    """parsed: lista de (task_original, info). Retorna {"tasks": [...]} sem chaves extras."""
    return {"tasks": [_new_task(t, info) for t, info in parsed]}


def _provision_one(task_id, owner, goal, provisioned):
    """Provisiona + valida; registra task_id em provisioned (para cleanup manual em erro)."""
    info = _provision(task_id, owner, goal)
    _validate_response(task_id, owner, info)
    provisioned.append(task_id)
    return info


def handle_batch(args):
    """Caminho tasks[]: extrai task_id/owner INDIVIDUAIS por task, provisiona uma a uma.

    Qualquer membro problemático (sem identificador, slug/owner inválido, provision com
    erro, resposta divergente, worktree errada, task_id duplicado) bloqueia o batch inteiro.
    Provisions já feitos são listados no bloco para cleanup manual — nunca removidos aqui.
    """
    tasks = args.get("tasks")
    provisioned = []
    try:
        parsed = []
        seen = set()
        for idx, t in enumerate(tasks):
            if not isinstance(t, dict):
                raise RuntimeError("tasks[%d] não é um objeto" % idx)
            ttext = _task_text(t)
            task_id = _slug(ttext)
            if not task_id:
                raise RuntimeError("tasks[%d]: task_id ausente ou slug inválido (esperado `task_id: slug` em goal/context)" % idx)
            if task_id in seen:
                raise RuntimeError("tasks[%d]: task_id %r duplicado — 1 worktree por agente" % (idx, task_id))
            seen.add(task_id)
            owner = _extract_owner(ttext)
            _check_owner(owner)
            goal = (t.get("goal") if isinstance(t.get("goal"), str) else "") or ttext.strip()[:500]
            try:
                info = _provision_one(task_id, owner, goal, provisioned)
            except Exception as exc:
                raise RuntimeError("tasks[%d] (task_id=%s): %s" % (idx, task_id, exc))
            parsed.append((t, info))
        return _emit_modify(_modify_batch_args(args, parsed))
    except Exception as exc:  # fail closed no caminho identificado
        msg = "AtendON multiagent hook fail closed: %s" % exc
        if provisioned:
            msg += (" | Provisions JÁ FEITOS nesta execução (cleanup manual: worktrees sob %s — "
                    "NÃO removidos automaticamente): task_ids: %s" % (CANONICAL_ROOT, ", ".join(provisioned)))
        return _block(msg)


def handle_single(args, text):
    """Forma legacy single-goal: um provision só; task_id/owner do texto de topo."""
    try:
        task_id = _slug(text)
        if not task_id:
            raise RuntimeError("delegação de código requer task_id (ex.: `task_id: FLOW-123`)")
        owner = _extract_owner(text)
        _check_owner(owner)
        goal = (args.get("goal") if isinstance(args.get("goal"), str) else "") or text.strip()[:500]
        info = _provision_one(task_id, owner, goal, [])
        contract = _contract(info)
        ctx = args.get("context")
        context = (ctx + "\n\n" + contract) if isinstance(ctx, str) and ctx.strip() else contract
        return _emit_modify({"goal": args.get("goal"), "context": context})
    except Exception as exc:  # fail closed no caminho identificado
        return _block("AtendON multiagent hook fail closed: %s" % exc)


def handle(payload):
    """Um evento pre_tool_call -> (stdout_json, exit_code)."""
    if not isinstance(payload, dict):
        return _no_op()
    if payload.get("tool_name") != "delegate_task":
        return _no_op()
    args = payload.get("tool_input") or payload.get("args") or {}
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
        try:
            atendon = _is_atendon(text, payload.get("cwd"))
        except Exception:
            atendon = False
        if not atendon:
            return _no_op()
        try:
            code_intent = bool(CODE_RE.search(text))
        except Exception:
            code_intent = False
        if not code_intent:
            return _no_op()  # pesquisa/análise não-código passa
        if isinstance(args.get("tasks"), list) and args["tasks"]:
            return handle_batch(args)
        return handle_single(args, text)
    except Exception as exc:  # fail closed no caminho identificado
        return _block("AtendON multiagent hook fail closed: %s" % exc)


def _emit_modify(modify_args):
    print(json.dumps({"action": "modify", "args": modify_args}))
    return 0


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(_no_op())
    sys.exit(handle(payload))


if __name__ == "__main__":
    main()
