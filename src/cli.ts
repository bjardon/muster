#!/usr/bin/env node
import { Cursor } from "@cursor/sdk";
import { randomBytes } from "node:crypto";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { assertClean, assertGitRepository, ensureRef } from "./git.js";
import { assertCursorReady } from "./adapters/cursor.js";
import { command } from "./process.js";
import { contractSnapshot, executeRun, loadSortie } from "./runtime.js";
import { routesFor, routingPath } from "./routing.js";
import { EventStore } from "./store.js";
import type { RunRecord } from "./store.js";

const [subcommand, ...args] = process.argv.slice(2);

try {
  if (subcommand === "inspect") await inspect(args);
  else if (subcommand === "launch") await launch(args);
  else if (subcommand === "status") await status(args);
  else if (subcommand === "pause") await pause(args);
  else if (subcommand === "resume") await resume(args);
  else if (subcommand === "cancel") await cancel(args);
  else if (subcommand === "cursor-login") await cursorLogin();
  else if (subcommand === "cursor-status") await cursorStatus();
  else if (subcommand === "_execute") await internalExecute(args);
  else usage(subcommand ? `Unknown command: ${subcommand}` : undefined);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function inspect(args: string[]): Promise<void> {
  const path = requiredArg(args[0], "sortie path");
  const sortie = await loadSortie(path);
  const snapshot = contractSnapshot(sortie);
  console.log(JSON.stringify({
    name: sortie.name,
    contractHash: snapshot.hash,
    contract: sortie.contract,
    routingFile: routingPath(),
    roles: Object.fromEntries(Object.entries(sortie.roles).map(([name, role]) => [name, {
      taskType: role.taskType,
      routes: routesFor(role),
    }])),
    limits: sortie.limits,
    pullRequest: sortie.pullRequest,
  }, null, 2));
}

async function launch(args: string[]): Promise<void> {
  const sortieArg = requiredArg(args.find((arg) => !arg.startsWith("--")), "sortie path");
  if (!args.includes("--approve")) {
    throw new Error("Approval is required. Inspect the sortie contract, obtain human approval, then launch with --approve.");
  }
  const repoRoot = await repositoryRoot();
  await assertGitRepository(repoRoot);
  await assertClean(repoRoot);
  const sortiePath = resolve(sortieArg);
  const sortie = await loadSortie(sortiePath);
  const baseBranch = sortie.repository.baseBranch === "HEAD"
    ? (await command("git", ["branch", "--show-current"], { cwd: repoRoot })).stdout.trim()
    : sortie.repository.baseBranch;
  if (!baseBranch) throw new Error("The repository is on a detached HEAD. Set repository.baseBranch in the sortie.");
  await ensureRef(repoRoot, baseBranch);
  const cursorRoutes = Object.values(sortie.roles)
    .flatMap((role) => routesFor(role))
    .filter((route) => route.provider === "cursor");
  if (cursorRoutes.length > 0) {
    await assertCursorReady(cursorRoutes.map((route) => route.model));
  }

  const runId = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const branch = `muster/${runId}`;
  const snapshot = contractSnapshot(sortie);
  const store = new EventStore(repoRoot);
  store.createRun({
    id: runId,
    status: "queued",
    repo_root: repoRoot,
    sortie_path: sortiePath,
    contract_hash: snapshot.hash,
    contract_json: snapshot.json,
    branch,
    base_branch: baseBranch,
  });
  store.event(runId, "contract.approved", { hash: snapshot.hash, source: "human-via-orchestrator" });
  store.close();
  await spawnRunner(repoRoot, runId);
  console.log(JSON.stringify({ runId, status: "queued", branch }, null, 2));
}

async function status(args: string[]): Promise<void> {
  const repoRoot = await repositoryRoot();
  const store = new EventStore(repoRoot);
  const run = args[0] ? store.getRun(args[0]) : store.latestRun();
  if (!run) throw new Error(args[0] ? `Unknown run: ${args[0]}` : "No Muster runs found");
  console.log(JSON.stringify({
    run: cleanRun(run),
    tasks: store.tasks(run.id),
    checks: store.checks(run.id),
    events: store.events(run.id).reverse().map((event) => ({ ...event, payload: JSON.parse(event.payload) })),
  }, null, 2));
  store.close();
}

async function pause(args: string[]): Promise<void> {
  const { store, run } = await selectedRun(args[0]);
  if (terminal(run.status)) throw new Error(`Run ${run.id} is already ${run.status}`);
  store.updateRun(run.id, { pause_requested: 1, status: "draining", message: "Pause requested; active work is draining" });
  store.event(run.id, "run.pause_requested");
  store.close();
  console.log(`Run ${run.id} is draining.`);
}

async function resume(args: string[]): Promise<void> {
  const { store, run } = await selectedRun(args[0]);
  if (terminal(run.status)) throw new Error(`Run ${run.id} cannot resume from ${run.status}`);
  if (run.pid && isAlive(run.pid)) throw new Error(`Run ${run.id} is still active with PID ${run.pid}`);
  store.updateRun(run.id, { pause_requested: 0, cancel_requested: 0, status: "queued", pid: null, message: "Resume queued" });
  store.event(run.id, "run.resume_requested");
  store.close();
  await spawnRunner(run.repo_root, run.id);
  console.log(`Run ${run.id} resumed.`);
}

async function cancel(args: string[]): Promise<void> {
  const { store, run } = await selectedRun(args[0]);
  if (terminal(run.status)) throw new Error(`Run ${run.id} is already ${run.status}`);
  store.updateRun(run.id, { cancel_requested: 1, status: "cancelling", message: "Cancellation requested" });
  store.event(run.id, "run.cancel_requested");
  store.close();
  if (run.pid && isAlive(run.pid)) {
    try {
      process.kill(-run.pid, "SIGTERM");
    } catch {
      process.kill(run.pid, "SIGTERM");
    }
  }
  console.log(`Cancellation requested for ${run.id}.`);
}

async function cursorLogin(): Promise<void> {
  const result = await Cursor.auth.login();
  console.log(`Cursor SDK authenticated${result.email ? ` as ${result.email}` : ""}.`);
}

async function cursorStatus(): Promise<void> {
  if (process.env.CURSOR_API_KEY) {
    console.log("Cursor SDK will authenticate with CURSOR_API_KEY.");
    return;
  }
  const status = await Cursor.auth.status();
  if (status.status === "logged-in") {
    console.log(`Cursor SDK authenticated${status.email ? ` as ${status.email}` : ""}.`);
  } else {
    console.log("Cursor SDK is not authenticated. Run: muster cursor-login");
  }
}

async function internalExecute(args: string[]): Promise<void> {
  const repoRoot = requiredArg(args[0], "repository root");
  const runId = requiredArg(args[1], "run ID");
  await executeRun(repoRoot, runId);
}

async function spawnRunner(repoRoot: string, runId: string): Promise<void> {
  const logPath = resolve(repoRoot, ".muster", "runs", `${runId}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");
  const entry = fileURLToPath(import.meta.url);
  const runnerArgs = entry.endsWith(".ts")
    ? ["--import", import.meta.resolve("tsx"), entry, "_execute", repoRoot, runId]
    : [entry, "_execute", repoRoot, runId];
  const child = spawn(process.execPath, runnerArgs, {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
}

async function repositoryRoot(): Promise<string> {
  return (await command("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })).stdout.trim();
}

async function selectedRun(id?: string): Promise<{ store: EventStore; run: RunRecord }> {
  const repoRoot = await repositoryRoot();
  const store = new EventStore(repoRoot);
  const run = id ? store.getRun(id) : store.latestRun();
  if (!run) {
    store.close();
    throw new Error(id ? `Unknown run: ${id}` : "No Muster runs found");
  }
  return { store, run };
}

function requiredArg(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminal(status: RunRecord["status"]): boolean {
  return status === "cancelled" || status === "failed" || status === "succeeded";
}

function cleanRun(run: RunRecord): Omit<RunRecord, "contract_json"> {
  const { contract_json: _, ...clean } = run;
  return clean;
}

function usage(error?: string): never {
  if (error) console.error(error);
  console.error(`Usage:
  muster inspect <sortie.ts>
  muster launch <sortie.ts> --approve
  muster status [run-id]
  muster pause [run-id]
  muster resume [run-id]
  muster cancel [run-id]
  muster cursor-login
  muster cursor-status`);
  process.exit(error ? 1 : 0);
}
