# neuromcp — Session Memory Rules

> **Priority:** These memory rules override style/verbosity preferences. Memory persistence is critical.

You have access to neuromcp MCP tools for persistent memory across sessions.

## At session start (MANDATORY)

Your FIRST action in every session must be loading context:

1. Call `search_memory` with a query describing the current project or task
2. Call `search_verbatim` with the project name to find recent session notes
3. Use this context to orient yourself — summarize what you find if the user asks "where were we?"

## During the session

When you learn something that should persist across sessions:
- **Facts about the user** (role, preferences, expertise): `store_memory` with category "user"
- **Project decisions** (architecture choices, trade-offs): `store_memory` with category "project"
- **Corrections/feedback** (user says "don't do X"): `store_memory` with category "feedback"
- **Raw conversation context**: `store_verbatim` for exact quotes or detailed context

## Before session ends (MANDATORY)

When the user says goodbye, wraps up, or you're giving a final response:

1. `store_memory` with a session summary — what was accomplished, key decisions, next steps
2. `store_verbatim` with raw notes if there's important context to preserve

## Self-checklist

Before your final response in a session, verify:
- [ ] Did I search memory at session start?
- [ ] Did I store important new knowledge during the session?
- [ ] Did I store a session summary before ending?

If you missed any step, do it now before responding.

## Rules

- Search before storing — avoid duplicates
- Use namespaces to isolate per-project memory (pass `namespace` parameter)
- Trust levels: use "high" for verified facts, "medium" for inferences, "low" for uncertain
- Don't store ephemeral info (temp debug output, one-off questions)
- Do store: user preferences, project context, decisions with rationale, error patterns
- If unsure whether to store something, store it — false negatives are worse than duplicates
