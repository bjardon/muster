# Muster

Muster runs disposable TypeScript mission programs called sorties. A local orchestration agent turns a software spec into an acceptance contract and a sortie. After a human approves the contract, Muster coordinates coding agents in isolated Git worktrees, records the run in SQLite, verifies the result, and opens a draft PR only when every criterion passes.

This is a personal experiment for trusted local repositories. It currently targets Cursor, Claude Code, and Codex running on the same machine as the repository. Cursor runs with its SDK sandbox enabled, project settings only, and a task-specific tool allowlist. Codex uses its SDK's read-only or workspace-write sandbox, which can still read user-level instructions outside the worktree on macOS.

## Install

Requirements: Node.js 24+, Git, GitHub CLI, authentication for the providers you route to: Codex CLI, Cursor with SDK access, or Claude Code.

```sh
pnpm install
pnpm build
pnpm link --global
```

Authenticate Cursor's SDK once through Muster:

```sh
muster cursor-login
muster cursor-status
```

For unattended hosts, set `CURSOR_API_KEY` instead. For Claude, run `claude auth login` and confirm with `claude auth status`. Muster uses the existing Claude Code and Codex logins. It does not manage provider keys or track spend.

## Model routing

A sortie requests task types rather than naming providers. Muster reads `~/.config/muster/routing.json` and uses each list in order. Without this file, implementation defaults to Cursor Grok 4.6 and verification defaults to Codex.

```json
{
  "taskTypes": {
    "implementation": [
      { "provider": "cursor", "model": "grok-4.6" },
      { "provider": "codex", "model": "your-approved-fallback" }
    ],
    "verification": [
      { "provider": "codex", "model": "your-preferred-model" }
    ]
  }
}
```

Cursor's supported Grok model IDs are `grok-4.6` and `grok-4.5`. Grok 4.6 is the default. Model access still depends on the Cursor account used to authenticate the SDK.

To split logic and UI work between Grok and Opus, with Astra verifying both, save this as `~/.config/muster/routing.json`:

```json
{
  "taskTypes": {
    "implementation": [{ "provider": "claude", "model": "claude-opus-5-5" }],
    "logic-implementation": [{ "provider": "cursor", "model": "grok-4.6" }],
    "ui-implementation": [{ "provider": "claude", "model": "claude-opus-5-5" }],
    "verification": [{ "provider": "codex", "model": "gpt-6-astra" }]
  }
}
```

Each task can set `taskType`. Omitted values use `roles.implementer.taskType`, so existing sorties keep their default. The orchestrator assigns task types and dependencies; the runtime does not classify tasks or restrict implementation routes to particular directories. For example, inside a sortie:

```ts
roles: {
  implementer: { taskType: "implementation" },
  verifier: { taskType: "verification" },
},
tasks: [
  {
    id: "health-endpoint",
    title: "Implement health endpoint",
    taskType: "logic-implementation",
    prompt: "Add GET /health and focused tests.",
  },
  {
    id: "health-ui",
    title: "Show service health",
    taskType: "ui-implementation",
    dependsOn: ["health-endpoint"],
    prompt: "Build a health indicator using GET /health and the existing UI conventions.",
  },
],
```

`muster inspect` shows each task's effective type and ordered routes. Launch checks every task's mapping, including Cursor access for per-task routes, before dispatch. Missing mappings fail; they do not fall back to the default implementer. Automatic contract repair rounds use the sortie's default implementer, which is Opus in this configuration. Verification always uses `roles.verifier` with read-only authority. Routing remains local configuration and is read again during execution and resume.

Claude uses its default model unless a route includes `model`. Claude workers have Read, Glob, Grep, Edit, and Write tools; Claude verifiers have only Read, Glob, and Grep. A pre-tool hook checks paths against the assigned worktree, including symlink targets, and denies Git metadata access. Shell, MCP, and delegation tools are unavailable. The runtime runs command checks. The adapter persists sessions, forwards cancellation, and rejects failed or incomplete SDK results.

Claude does not load user or project settings, hooks, or plugins. Its tool checks are application permissions, not an OS sandbox; the trusted-host and trusted-repository assumption still applies.

Set `MUSTER_ROUTING_FILE` to use a different file. Muster has one routing configuration for now; named profiles are deferred.

## Run a sortie

The orchestration agent generates a file shaped like [sample.sortie.ts](./examples/sample.sortie.ts), normally under the ignored `.muster/sorties/` directory in the target repository. First inspect the exact contract and resolved routing:

```sh
muster inspect ./path/to/change.sortie.ts
```

After the human approves the acceptance criteria, launch it in the target repository:

```sh
muster launch ./path/to/change.sortie.ts --approve
```

Launch returns a run ID while a local background process continues. The target repository must be clean so its base commit is unambiguous.

```sh
muster status [run-id]
muster pause [run-id]
muster resume [run-id]
muster cancel [run-id]
```

Pause lets active assignments finish, records their work, prevents downstream dispatch, and stops at a safe boundary. Resume continues from the SQLite event log and saved agent sessions. Cancel interrupts the runner and preserves the run branch and evidence.

On success, Muster pushes `muster/<run-id>` and opens a draft PR containing the approved contract and its evidence. A failed run writes `.muster/runs/<run-id>-failure.md` and does not open a PR.

## Develop

```sh
pnpm check
pnpm test
pnpm build
```

The tests use a deterministic local worker. They do not call Cursor, Claude, Codex, or GitHub.
