# neuromcp — Session Memory Rules

You have access to neuromcp MCP tools for persistent memory across sessions.

## At session start

1. Call `search_memory` with a query describing the current project or task to load relevant context
2. Call `search_verbatim` with the project name to find recent session notes
3. Use this context to orient yourself — if the user asks "where were we?", summarize what you find

## During the session

When you learn something that should persist across sessions:
- **Facts about the user** (role, preferences, expertise): `store_memory` with category "user"
- **Project decisions** (architecture choices, trade-offs): `store_memory` with category "project"
- **Corrections/feedback** (user says "don't do X"): `store_memory` with category "feedback"
- **Raw conversation context**: `store_verbatim` for exact quotes or detailed context

## Before session ends

When the user says goodbye, or you're wrapping up:
1. `store_memory` with a session summary — what was accomplished, key decisions, next steps
2. `store_verbatim` with raw notes if there's important context to preserve

## Rules

- Search before storing — avoid duplicates
- Use namespaces to isolate per-project memory (pass `namespace` parameter)
- Trust levels: use "high" for verified facts, "medium" for reasonable inferences, "low" for uncertain
- Don't store ephemeral info (temp debug output, one-off questions)
- Do store: user preferences, project context, decisions with rationale, error patterns and fixes
