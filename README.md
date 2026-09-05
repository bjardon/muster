# Muster

Muster runs disposable TypeScript mission programs called sorties. A local orchestration agent turns a software spec into an acceptance contract and a sortie. After a human approves the contract, Muster coordinates coding agents in isolated Git worktrees, records the run in SQLite, verifies the result, and opens a draft PR only when every criterion passes.

This is a personal experiment for trusted local repositories. It currently targets Cursor and Codex running on the same machine as the repository. Cursor runs with its SDK sandbox enabled, project settings only, and a task-specific tool allowlist. Codex uses its SDK's read-only or workspace-write sandbox, which can still read user-level instructions outside the worktree on macOS.

## Install

Requirements: Node.js 24+, Git, GitHub CLI, an authenticated Codex CLI, and a Cursor plan with SDK access.

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

For unattended hosts, set `CURSOR_API_KEY` instead. Muster uses the existing Codex login. It does not manage provider keys or track spend.

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

The tests use a deterministic local worker. They do not call Cursor, Codex, or GitHub.
