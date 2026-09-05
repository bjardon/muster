# Muster agent notes

Muster is a Personal Experiment. Build outcome-first with disposable code and minimal process.

- Read `README.md` for purpose and run instructions.
- Read `TODO.md` for the only repository-level build status.
- Use the [Notion devlog](https://app.notion.com/p/muster-Agent-Orchestration-3cad5cfe81be804192f2cdd63a479c70) for durable decisions, learnings, and dead ends.
- Run `pnpm check && pnpm test && pnpm build` to verify user-visible behavior.
- Preserve the contract boundary: the orchestration agent decides, the sortie encodes, and the runtime executes and enforces.
- Keep workers inside isolated worktrees. Run Cursor through its local SDK with the sandbox enabled and Grok 4.6 as the default implementation model. A verifier has read-only authority. A passing run may open a draft PR and never merges it.
- Treat repositories as trusted while Codex's SDK sandbox can read user-level instructions outside its assigned worktree.
- Keep spend tracking, remote transport, dashboards, named routing profiles, and live steering outside this experiment until explicitly requested.

Implement and verify freely. Ship only after the user accepts the behavior or asks to wrap up. Before shipping, rerun the relevant behavior, refresh `TODO.md`, integrate accepted work into `main`, and push it. A pull request alone is not wrap-up. Consider the devlog on every wrap-up; append only durable decisions, learnings, or dead ends. If integration or push is blocked, report wrap-up as incomplete and do not record the work as shipped.
