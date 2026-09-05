import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { adapterFor } from "./adapters/index.js";
import {
  cherryPick,
  commitChanges,
  containsCommit,
  createDraftPr,
  createWorktree,
  currentSha,
  pushBranch,
  removeWorktree,
  worktreePaths,
} from "./git.js";
import { command, shell } from "./process.js";
import { routesFor } from "./routing.js";
import { EventStore } from "./store.js";
import type { RunRecord } from "./store.js";
import { defineSortie } from "./types.js";
import type { Criterion, ResolvedSortie, Role, RouteCandidate, Task, WorkerResult } from "./types.js";

class CancelledError extends Error {}
class PausedError extends Error {}
class VerifierMutationError extends Error {}

export async function loadSortie(path: string): Promise<ResolvedSortie> {
  const absolute = resolve(path);
  const imported = await tsImport(`${pathToFileURL(absolute).href}?loaded=${Date.now()}`, import.meta.url) as { default?: unknown };
  let candidate = imported.default as Record<string, unknown> | undefined;
  if (candidate && !candidate.contract && candidate.default && typeof candidate.default === "object") {
    candidate = candidate.default as Record<string, unknown>;
  }
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Sortie ${absolute} must have a default export`);
  }
  return defineSortie(candidate as Parameters<typeof defineSortie>[0]);
}

export function contractSnapshot(sortie: ResolvedSortie): { json: string; hash: string } {
  const json = JSON.stringify(sortie.contract);
  const hash = createHash("sha256").update(json).digest("hex");
  return { json, hash };
}

export async function executeRun(repoRoot: string, runId: string): Promise<void> {
  const store = new EventStore(repoRoot);
  const abortController = new AbortController();
  let stopping = false;
  const cancel = () => {
    if (stopping) return;
    stopping = true;
    store.updateRun(runId, { status: "cancelling", cancel_requested: 1, message: "Cancellation requested" });
    store.event(runId, "run.cancelling");
    abortController.abort();
  };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);

  try {
    const run = requiredRun(store, runId);
    const sortie = await loadSortie(run.sortie_path);
    const snapshot = contractSnapshot(sortie);
    if (snapshot.hash !== run.contract_hash) {
      throw new Error("The sortie acceptance contract changed after approval. Launch a new run and approve it again.");
    }
    store.updateRun(runId, { status: "running", pid: process.pid, message: "Running" });
    store.event(runId, "run.started", { pid: process.pid });

    await runMission(store, requiredRun(store, runId), sortie, abortController.signal);
  } catch (error) {
    if (error instanceof PausedError) {
      store.updateRun(runId, { status: "paused", pid: null, message: "Paused at a safe boundary" });
      store.event(runId, "run.paused");
    } else if (error instanceof CancelledError || abortController.signal.aborted) {
      store.updateRun(runId, { status: "cancelled", pid: null, message: "Cancelled; branch and evidence preserved" });
      store.event(runId, "run.cancelled");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      store.updateRun(runId, { status: "failed", pid: null, message });
      store.event(runId, "run.failed", { message });
      await writeFailureReport(repoRoot, runId, message, store);
    }
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    store.close();
  }
}

async function runMission(store: EventStore, run: RunRecord, sortie: ResolvedSortie, signal: AbortSignal): Promise<void> {
  const paths = worktreePaths(run.repo_root, run.id);
  if (!existsSync(paths.integration)) {
    await createWorktree(run.repo_root, paths.integration, run.branch, run.base_branch);
    store.event(run.id, "integration.created", { branch: run.branch, worktree: paths.integration });
  }

  for (const task of sortie.tasks) store.ensureTask(run.id, task.id);
  await controlPoint(store, run.id, signal);
  await executeTaskGraph(store, run, sortie, paths.integration, signal);

  let repairRound = await recoverRepairTasks(store, run, paths.integration);
  let verification = await verifyContract(store, run, sortie, paths.integration, signal);
  while (!verification.passed && repairRound < sortie.limits.maxRepairRounds) {
    repairRound += 1;
    await controlPoint(store, run.id, signal);
    const repairTask: Task = {
      id: `repair-${repairRound}`,
      title: `Repair acceptance failures, round ${repairRound}`,
      prompt: repairPrompt(sortie, verification.failures),
    };
    store.ensureTask(run.id, repairTask.id);
    const produced = await produceTask(store, run, repairTask, sortie.roles.implementer, await currentSha(paths.integration), sortie.limits.maxTaskAttempts, signal);
    await cherryPick(paths.integration, produced.commitSha);
    store.updateTask(run.id, repairTask.id, { status: "completed" });
    store.event(run.id, "task.integrated", { taskId: repairTask.id, commitSha: produced.commitSha });
    verification = await verifyContract(store, run, sortie, paths.integration, signal);
  }

  if (!verification.passed) {
    throw new Error(`Acceptance failed after ${repairRound} repair round(s):\n${verification.failures.join("\n")}`);
  }

  await controlPoint(store, run.id, signal);
  let prUrl: string | undefined;
  if (sortie.pullRequest.enabled) {
    await pushBranch(paths.integration, run.branch);
    prUrl = await createDraftPr(paths.integration, {
      title: sortie.pullRequest.title,
      base: run.base_branch,
      head: run.branch,
      body: prBody(run, sortie, store),
    });
    store.event(run.id, "pull_request.created", { url: prUrl });
  }

  store.updateRun(run.id, {
    status: "succeeded",
    pid: null,
    message: prUrl ? `Draft PR: ${prUrl}` : `Acceptance passed on branch ${run.branch}`,
  });
  store.event(run.id, "run.succeeded", { branch: run.branch, prUrl: prUrl ?? null });
  await removeWorktree(run.repo_root, paths.integration);
}

async function recoverRepairTasks(store: EventStore, run: RunRecord, integration: string): Promise<number> {
  const repairs = store.tasks(run.id)
    .filter((task) => /^repair-\d+$/.test(String(task.task_id)))
    .sort((a, b) => Number(String(a.task_id).split("-")[1]) - Number(String(b.task_id).split("-")[1]));
  let completed = 0;
  for (const repair of repairs) {
    if (repair.status === "produced") {
      const sha = String(repair.commit_sha ?? "");
      if (!sha) throw new Error(`Repair ${repair.task_id} is produced without a commit`);
      if (!(await containsCommit(integration, sha))) await cherryPick(integration, sha);
      store.updateTask(run.id, String(repair.task_id), { status: "completed" });
      store.event(run.id, "task.integrated", { taskId: repair.task_id, commitSha: sha, resumed: true });
      completed += 1;
    } else if (repair.status === "completed") {
      completed += 1;
    }
  }
  return completed;
}

async function executeTaskGraph(
  store: EventStore,
  run: RunRecord,
  sortie: ResolvedSortie,
  integration: string,
  signal: AbortSignal,
): Promise<void> {
  const byId = new Map(sortie.tasks.map((task) => [task.id, task]));
  while (true) {
    await controlPoint(store, run.id, signal);
    const records = new Map(store.tasks(run.id).map((record) => [String(record.task_id), record]));
    const produced = sortie.tasks.filter((task) => records.get(task.id)?.status === "produced");
    if (produced.length > 0) {
      for (const task of produced) {
        const sha = String(records.get(task.id)?.commit_sha ?? "");
        if (!sha) throw new Error(`Task ${task.id} is produced without a commit`);
        if (!(await containsCommit(integration, sha))) await cherryPick(integration, sha);
        store.updateTask(run.id, task.id, { status: "completed" });
        store.event(run.id, "task.integrated", { taskId: task.id, commitSha: sha, resumed: true });
      }
      continue;
    }
    const pending = sortie.tasks.filter((task) => records.get(task.id)?.status !== "completed");
    if (pending.length === 0) return;

    const ready = pending.filter((task) =>
      (task.dependsOn ?? []).every((dependency) => records.get(dependency)?.status === "completed"),
    ).slice(0, sortie.limits.maxConcurrency);
    if (ready.length === 0) {
      const blocked = pending.map((task) => `${task.id} -> ${(task.dependsOn ?? []).join(", ")}`).join("; ");
      throw new Error(`Task graph cannot make progress: ${blocked}`);
    }

    const baseSha = await currentSha(integration);
    const results = await Promise.all(ready.map((task) =>
      produceTask(store, run, task, sortie.roles.implementer, baseSha, sortie.limits.maxTaskAttempts, signal),
    ));
    for (const result of results) {
      await cherryPick(integration, result.commitSha);
      store.updateTask(run.id, result.task.id, { status: "completed" });
      store.event(run.id, "task.integrated", { taskId: result.task.id, commitSha: result.commitSha });
    }
  }
}

async function produceTask(
  store: EventStore,
  run: RunRecord,
  task: Task,
  role: Role,
  startPoint: string,
  maxAttempts: number,
  signal: AbortSignal,
): Promise<{ task: Task; commitSha: string }> {
  const paths = worktreePaths(run.repo_root, run.id);
  const existing = store.task(run.id, task.id);
  const routes = routesFor(role);
  let attempts = Number(existing?.attempts ?? 0);
  let lastError = "";
  while (attempts < maxAttempts) {
    await controlPoint(store, run.id, signal);
    attempts += 1;
    const branch = `muster-worker/${run.id}/${task.id}-a${attempts}`;
    const worktree = paths.task(task.id);
    store.updateTask(run.id, task.id, { status: "running", attempts, branch, worktree, last_error: null });
    const route = routes[Math.min(attempts - 1, routes.length - 1)];
    store.event(run.id, "task.started", { taskId: task.id, attempt: attempts, taskType: role.taskType, provider: route.provider, model: route.model ?? null });
    try {
      await createWorktree(run.repo_root, worktree, branch, startPoint);
      const result = await runWorker(store, run.id, task, route, worktree, false, signal);
      if (result.sessionId) store.updateTask(run.id, task.id, { session_id: result.sessionId });
      const commitSha = await commitChanges(worktree, `muster: ${task.title}`);
      if (!commitSha) throw new Error("Worker completed without producing a Git change");
      store.updateTask(run.id, task.id, { status: "produced", commit_sha: commitSha });
      store.event(run.id, "task.produced", { taskId: task.id, commitSha });
      await removeWorktree(run.repo_root, worktree);
      return { task, commitSha };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      store.updateTask(run.id, task.id, { status: "pending", last_error: lastError });
      store.event(run.id, "task.failed", { taskId: task.id, attempt: attempts, message: lastError });
      await removeWorktree(run.repo_root, worktree);
    }
  }
  throw new Error(`Task ${task.id} exhausted ${maxAttempts} attempt(s): ${lastError}`);
}

async function runWorker(
  store: EventStore,
  runId: string,
  task: Task,
  route: RouteCandidate,
  cwd: string,
  readOnly: boolean,
  signal: AbortSignal,
): Promise<WorkerResult> {
  const record = store.task(runId, task.id);
  const adapter = adapterFor(route.provider);
  return await adapter.run({
    runId,
    taskId: task.id,
    prompt: task.prompt,
    cwd,
    stateDir: dirname(store.path),
    model: route.model,
    sessionId: typeof record?.session_id === "string" ? record.session_id : undefined,
    readOnly,
    signal,
    onEvent: (type, payload) => {
      if (type === "worker.session" && typeof payload.sessionId === "string") {
        store.updateTask(runId, task.id, { session_id: payload.sessionId });
      }
      store.event(runId, type, { taskId: task.id, ...payload });
    },
  });
}

async function verifyContract(
  store: EventStore,
  run: RunRecord,
  sortie: ResolvedSortie,
  integration: string,
  signal: AbortSignal,
): Promise<{ passed: boolean; failures: string[] }> {
  const failures: string[] = [];
  store.event(run.id, "verification.started");
  for (const criterion of sortie.contract.criteria) {
    await controlPoint(store, run.id, signal);
    if (criterion.evidence.kind === "command") {
      const result = await shell(criterion.evidence.command, { cwd: integration, signal, allowFailure: true });
      const output = `${result.stdout}${result.stderr}`.trim();
      const passed = result.exitCode === 0;
      store.saveCheck(run.id, criterion.id, passed ? "passed" : "failed", result.exitCode, output);
      store.event(run.id, "criterion.checked", { criterionId: criterion.id, passed, exitCode: result.exitCode });
      if (!passed) failures.push(`${criterion.id}: command failed (${result.exitCode})\n${output}`);
    } else {
      const task: Task = {
        id: `verify-${criterion.id}`,
        title: `Verify ${criterion.id}`,
        prompt: verifierPrompt(sortie, criterion),
      };
      store.ensureTask(run.id, task.id);
      store.updateTask(run.id, task.id, { status: "running" });
      let result: WorkerResult;
      try {
        result = await runVerifier(store, run.id, task, sortie.roles.verifier, integration, signal);
        store.updateTask(run.id, task.id, { status: "completed", last_error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.updateTask(run.id, task.id, { status: "failed", last_error: message });
        throw error;
      }
      const verdict = parseVerdict(result.finalText);
      store.saveCheck(run.id, criterion.id, verdict.accepted ? "passed" : "failed", null, verdict.evidence);
      store.event(run.id, "criterion.checked", { criterionId: criterion.id, passed: verdict.accepted });
      if (!verdict.accepted) failures.push(`${criterion.id}: ${verdict.evidence}`);
    }
  }
  store.event(run.id, "verification.completed", { passed: failures.length === 0, failures: failures.length });
  return { passed: failures.length === 0, failures };
}

async function runVerifier(
  store: EventStore,
  runId: string,
  task: Task,
  role: Role,
  cwd: string,
  signal: AbortSignal,
): Promise<WorkerResult> {
  const failures: string[] = [];
  for (const route of routesFor(role)) {
    const beforeSha = await currentSha(cwd);
    const beforeStatus = (await command("git", ["status", "--porcelain"], { cwd })).stdout;
    try {
      store.event(runId, "verifier.selected", { taskId: task.id, taskType: role.taskType, provider: route.provider, model: route.model ?? null });
      const result = await runWorker(store, runId, task, route, cwd, true, signal);
      const afterSha = await currentSha(cwd);
      const afterStatus = (await command("git", ["status", "--porcelain"], { cwd })).stdout;
      if (beforeSha !== afterSha || beforeStatus !== afterStatus) {
        throw new VerifierMutationError(`Verifier ${route.provider} modified the integration worktree`);
      }
      return result;
    } catch (error) {
      if (error instanceof VerifierMutationError) throw error;
      failures.push(`${route.provider}${route.model ? `/${route.model}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No verifier route completed ${task.id}: ${failures.join("; ")}`);
}

async function controlPoint(store: EventStore, runId: string, signal: AbortSignal): Promise<void> {
  const run = requiredRun(store, runId);
  if (signal.aborted || run.cancel_requested) throw new CancelledError();
  if (run.pause_requested) throw new PausedError();
}

function verifierPrompt(sortie: ResolvedSortie, criterion: Criterion): string {
  return [
    "You are an independent acceptance verifier. Do not modify files.",
    `Product summary: ${sortie.contract.summary}`,
    `Criterion: ${criterion.description}`,
    `Verification instructions: ${criterion.evidence.kind === "agent" ? criterion.evidence.prompt : ""}`,
    "Inspect the current worktree. Return only JSON with this shape:",
    '{"accepted": boolean, "evidence": "specific observations and file paths"}',
  ].join("\n\n");
}

function parseVerdict(text: string): { accepted: boolean; evidence: string } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { accepted: false, evidence: `Verifier did not return JSON: ${text}` };
  try {
    const parsed = JSON.parse(match[0]) as { accepted?: unknown; evidence?: unknown };
    return {
      accepted: parsed.accepted === true,
      evidence: typeof parsed.evidence === "string" ? parsed.evidence : "Verifier returned no evidence",
    };
  } catch {
    return { accepted: false, evidence: `Verifier returned invalid JSON: ${text}` };
  }
}

function repairPrompt(sortie: ResolvedSortie, failures: string[]): string {
  return [
    `Repair the implementation so it satisfies the approved contract: ${sortie.contract.summary}`,
    "Do not weaken or reinterpret the criteria.",
    "Current failures:",
    failures.join("\n\n"),
    "Inspect the existing implementation, make the smallest coherent repair, and verify your changes locally.",
  ].join("\n\n");
}

function prBody(run: RunRecord, sortie: ResolvedSortie, store: EventStore): string {
  const checks = new Map(store.checks(run.id).map((check) => [String(check.check_id), check]));
  const evidence = sortie.contract.criteria.map((criterion) => {
    const check = checks.get(criterion.id);
    const output = String(check?.output ?? "No evidence recorded").slice(0, 4000);
    return `### ${criterion.id}: ${criterion.description}\n\n**${check?.status ?? "unknown"}**\n\n\`\`\`text\n${output}\n\`\`\``;
  }).join("\n\n");
  return [
    "## Accepted contract",
    sortie.contract.summary,
    "## Acceptance evidence",
    evidence,
    "## Muster run",
    `Run ID: \`${run.id}\``,
    "This draft PR passed the factory contract. Human acceptance is still required.",
  ].join("\n\n");
}

async function writeFailureReport(repoRoot: string, runId: string, message: string, store: EventStore): Promise<void> {
  const path = resolve(repoRoot, ".muster", "runs", `${runId}-failure.md`);
  await mkdir(dirname(path), { recursive: true });
  const checks = store.checks(runId).map((check) => `- ${check.check_id}: ${check.status}`).join("\n") || "- No checks completed";
  await writeFile(path, `# Muster failure report\n\nRun: \`${runId}\`\n\n## Reason\n\n${message}\n\n## Acceptance checks\n\n${checks}\n`, "utf8");
}

function requiredRun(store: EventStore, runId: string): RunRecord {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  return run;
}
