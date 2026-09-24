# Build status

Iteration status: unverified first iteration. Deterministic checks pass, but no live Cursor Grok and Codex sortie has completed against a real repository.

- [x] An orchestration agent can define an explicit acceptance contract in a typed sortie.
- [x] A human-approved sortie launches as a resumable local background run.
- [x] Implementation work runs in isolated Git worktrees with bounded concurrency, retries, and repair rounds.
- [x] Command checks and independent read-only agent judgments produce criterion-level evidence.
- [x] Passing work can open an evidence-bearing draft PR; failed work produces a report without a PR.
- [x] Runs can drain into pause, resume from durable state, or cancel while preserving work.
- [x] Personal task-type routing selects Cursor, Claude, or Codex without embedding providers in sorties.
- [x] Claude provider restored with scoped file tools, read-only verification, session resume, and cancellation checks. A live Claude smoke test wrote a file, resumed the session with read-only tools, and verified it without mutation. The full first sortie is still pending.
- [x] Project audit recorded in `reports/project-audit.html`, with 11 findings and eight reproduction probes.
- [ ] Resolve the audit's acceptance and recovery failures, including checks against uncommitted files, lost unfinished work on resume, and workers outliving the event store.
- [ ] A live Cursor Grok implementation worker and live Codex verifier complete one accepted local run.
- [ ] Prove the runtime on a moderate real-world spec using live Cursor Grok and Codex workers.
- [ ] Confirm recovery by terminating and resuming a live provider run mid-task.
- [ ] Restrict Codex reads to its assigned worktree or keep the trusted-host limitation explicit.
