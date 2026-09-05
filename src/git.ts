import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { command } from "./process.js";

export async function assertGitRepository(repoRoot: string): Promise<void> {
  const result = await command("git", ["rev-parse", "--show-toplevel"], { cwd: repoRoot });
  if (result.stdout.trim() !== repoRoot) {
    throw new Error(`Run Muster from the repository root: ${result.stdout.trim()}`);
  }
}

export async function assertClean(repoRoot: string): Promise<void> {
  const result = await command("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (result.stdout.trim()) {
    throw new Error("The repository has uncommitted changes. Commit or stash them before launching a sortie.");
  }
}

export async function ensureRef(repoRoot: string, ref: string): Promise<void> {
  await command("git", ["rev-parse", "--verify", ref], { cwd: repoRoot });
}

export async function createWorktree(repoRoot: string, path: string, branch: string, startPoint: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await command("git", ["worktree", "add", "-b", branch, path, startPoint], { cwd: repoRoot });
}

export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  await command("git", ["worktree", "remove", "--force", path], { cwd: repoRoot, allowFailure: true });
  await rm(path, { recursive: true, force: true });
}

export async function commitChanges(worktree: string, message: string): Promise<string | null> {
  await command("git", ["add", "-A"], { cwd: worktree });
  const diff = await command("git", ["diff", "--cached", "--quiet"], { cwd: worktree, allowFailure: true });
  if (diff.exitCode === 0) return null;
  await command("git", [
    "-c", "user.name=Muster",
    "-c", "user.email=muster@local",
    "commit", "-m", message,
  ], { cwd: worktree });
  const result = await command("git", ["rev-parse", "HEAD"], { cwd: worktree });
  return result.stdout.trim();
}

export async function cherryPick(worktree: string, sha: string): Promise<void> {
  const result = await command("git", ["cherry-pick", sha], { cwd: worktree, allowFailure: true });
  if (result.exitCode !== 0) {
    await command("git", ["cherry-pick", "--abort"], { cwd: worktree, allowFailure: true });
    throw new Error(`Integration conflict for ${sha}\n${result.stderr || result.stdout}`);
  }
}

export async function containsCommit(worktree: string, sha: string): Promise<boolean> {
  const result = await command("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: worktree, allowFailure: true });
  return result.exitCode === 0;
}

export async function currentSha(worktree: string): Promise<string> {
  return (await command("git", ["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
}

export async function pushBranch(worktree: string, branch: string): Promise<void> {
  await command("git", ["push", "-u", "origin", branch], { cwd: worktree });
}

export async function createDraftPr(
  worktree: string,
  input: { title: string; base: string; head: string; body: string },
): Promise<string> {
  const existing = await command("gh", ["pr", "view", input.head, "--json", "url", "--jq", ".url"], {
    cwd: worktree,
    allowFailure: true,
  });
  if (existing.exitCode === 0 && existing.stdout.trim()) return existing.stdout.trim();
  const result = await command("gh", [
    "pr", "create", "--draft",
    "--title", input.title,
    "--base", input.base,
    "--head", input.head,
    "--body", input.body,
  ], { cwd: worktree });
  return result.stdout.trim();
}

export function worktreePaths(repoRoot: string, runId: string): { root: string; integration: string; task: (id: string) => string } {
  const root = join(repoRoot, ".muster", "worktrees", runId);
  return {
    root,
    integration: join(root, "integration"),
    task: (id: string) => join(root, id),
  };
}
