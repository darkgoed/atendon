## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Writing standard: no-ai-slop

The skill `no-ai-slop` lives at `.agents/skills/no-ai-slop/SKILL.md` (also linked into the Hermes daybreak profile). Any agent that writes or edits user-facing prose — UI copy, README text, PR/release descriptions, findings or report sections, emails, marketing text (PT or EN) — must read that SKILL.md before writing and apply its rules: active voice, concrete facts over abstraction, no banned filler words (delve, leverage, robust, ...), no throat-clearing, no colon reveals, no summary-recap endings. It is an editing standard, not a content redesign: preserve the writer's voice and the project's existing terminology. Code, tests and migrations are out of its scope.
