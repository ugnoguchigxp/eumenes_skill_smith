# Pinned SKILL.md frontmatter contract

Source: https://agentskills.io/specification, retrieved 2026-11-07 JST. Upstream has no numeric spec version; this supported snapshot is `agent-skills-frontmatter.2026-11-07`. This local contract changes only by an explicit version update, not from a moving web page.

- Required `name`: string, ASCII lowercase alphanumeric kebab-case, 1–64 characters, no consecutive or leading/trailing hyphens, matches directory.
- Required `description`: nonblank string, at most 1024 characters.
- Optional `license`: string (upstream specifies no hard maximum).
- Optional `compatibility`: string, 1–500 characters.
- Optional `metadata`: mapping of string keys to string values, never an array, null, or nested/scalar typed values.
- Optional experimental `allowed-tools`: space-separated string (upstream specifies no hard maximum). It is metadata, not an authorization grant by this service.
- Other keys are outside this supported contract. Body must be nonempty Markdown.

The public format validator checks this shape only. Current model-text AST grammar checks are separate, as is the budgeted semantic review. Neither format conformance nor a positive LLM review proves safety, human approval, or successful execution.
