import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { command } from "../src/process.js";
import { loadRouting, routesFor } from "../src/routing.js";
import { contractSnapshot, executeRun, loadSortie } from "../src/runtime.js";
import { EventStore } from "../src/store.js";

test("a passing sortie produces an isolated accepted branch", async () => {
  const fixture = await createFixture({ failingCheck: false, maxRepairRounds: 1 });
  await executeRun(fixture.repo, fixture.runId);

  const store = new EventStore(fixture.repo);
  const run = store.getRun(fixture.runId);
  assert.equal(run?.status, "succeeded");
  assert.match(run?.message ?? "", /Acceptance passed/);
  assert.deepEqual(store.checks(fixture.runId).map((check) => check.status), ["passed", "passed"]);
  assert.equal(store.task(fixture.runId, "verify-criterion-review")?.status, "completed");
  store.close();

  const created = await command("git", ["show", `${fixture.branch}:implement.txt`], { cwd: fixture.repo });
  assert.match(created.stdout, /Create the requested fixture/);
  await assert.rejects(readFile(join(fixture.repo, "implement.txt"), "utf8"));
});

test("a failed contract preserves work but does not report success", async () => {
  const fixture = await createFixture({ failingCheck: true, maxRepairRounds: 0 });
  await executeRun(fixture.repo, fixture.runId);

  const store = new EventStore(fixture.repo);
  const run = store.getRun(fixture.runId);
  assert.equal(run?.status, "failed");
  assert.match(run?.message ?? "", /Acceptance failed/);
  store.close();

  const report = await readFile(join(fixture.repo, ".muster", "runs", `${fixture.runId}-failure.md`), "utf8");
  assert.match(report, /criterion-file: failed/);
  const created = await command("git", ["show", `${fixture.branch}:implement.txt`], { cwd: fixture.repo });
  assert.ok(created.stdout.length > 0);
});

test("a paused run resumes from its safe boundary", async () => {
  const fixture = await createFixture({ failingCheck: false, maxRepairRounds: 0 });
  const store = new EventStore(fixture.repo);
  store.updateRun(fixture.runId, { pause_requested: 1, status: "draining" });
  store.close();
  await executeRun(fixture.repo, fixture.runId);

  const reopened = new EventStore(fixture.repo);
  assert.equal(reopened.getRun(fixture.runId)?.status, "paused");
  assert.equal(reopened.tasks(fixture.runId).filter((task) => task.status === "running").length, 0);
  reopened.updateRun(fixture.runId, { pause_requested: 0, status: "queued" });
  reopened.close();
  await executeRun(fixture.repo, fixture.runId);
  const resumed = new EventStore(fixture.repo);
  assert.equal(resumed.getRun(fixture.runId)?.status, "succeeded");
  resumed.close();
});

test("a bounded repair round can satisfy a failed criterion", async () => {
  const fixture = await createFixture({ failingCheck: false, maxRepairRounds: 1, repairRequired: true });
  await executeRun(fixture.repo, fixture.runId);
  const store = new EventStore(fixture.repo);
  assert.equal(store.getRun(fixture.runId)?.status, "succeeded");
  assert.equal(store.task(fixture.runId, "repair-1")?.status, "completed");
  store.close();
});

test("the CLI launches a sortie in a detached background runner", async () => {
  const fixture = await createCliFixture("Create it");
  assert.equal(await waitForStatus(fixture.repo, fixture.runId, ["succeeded", "failed", "cancelled"]), "succeeded");
});

test("cancel stops a detached runner and its active worker", async () => {
  const fixture = await createCliFixture("[delay:5000] Create it");
  assert.equal(await waitForStatus(fixture.repo, fixture.runId, ["running"]), "running");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  await command(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "cancel", fixture.runId], { cwd: fixture.repo });
  assert.equal(await waitForStatus(fixture.repo, fixture.runId, ["cancelled", "failed"]), "cancelled");
});

test("routing accepts Cursor and Claude and rejects unknown providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muster-routing-test-"));
  const routingPath = join(directory, "routing.json");
  const previousPath = process.env.MUSTER_ROUTING_FILE;
  process.env.MUSTER_ROUTING_FILE = routingPath;

  try {
    await writeFile(routingPath, JSON.stringify({
      taskTypes: {
        implementation: [{ provider: "cursor", model: "grok-4.6" }],
      },
    }), "utf8");
    assert.deepEqual(routesFor({ taskType: "implementation" }, loadRouting()), [
      { provider: "cursor", model: "grok-4.6" },
    ]);

    await writeFile(routingPath, JSON.stringify({
      taskTypes: {
        implementation: [{ provider: "claude" }],
      },
    }), "utf8");
    assert.deepEqual(routesFor({ taskType: "implementation" }, loadRouting()), [{ provider: "claude" }]);
    await writeFile(routingPath, JSON.stringify({ taskTypes: { verification: [{ provider: "unknown" }] } }));
    assert.throws(() => loadRouting(), /Invalid provider/);
  } finally {
    if (previousPath === undefined) delete process.env.MUSTER_ROUTING_FILE;
    else process.env.MUSTER_ROUTING_FILE = previousPath;
  }
});

async function createCliFixture(prompt: string): Promise<{ repo: string; runId: string }> {
  const repo = await mkdtemp(join(tmpdir(), "muster-cli-test-"));
  await command("git", ["init", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, ".gitignore"), ".muster/\n", "utf8");
  await writeFile(join(repo, "README.md"), "fixture\n", "utf8");
  const sortiePath = join(repo, "background.sortie.ts");
  await writeFile(sortiePath, `export default {
    name: "Background fixture",
    contract: { summary: "Create a background artifact", criteria: [{
      id: "artifact", description: "The artifact exists", evidence: { kind: "command", command: "test -f background.txt" }
    }] },
    roles: { implementer: { taskType: "implementation" }, verifier: { taskType: "verification" } },
    limits: { maxConcurrency: 1, maxTaskAttempts: 1, maxRepairRounds: 0 },
    tasks: [{ id: "background", title: "Create artifact", prompt: ${JSON.stringify(prompt)} }],
    pullRequest: { enabled: false }
  };`, "utf8");
  await command("git", ["add", "."], { cwd: repo });
  await command("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: repo });
  const routing = join(repo, ".muster", "routing.json");
  await mkdir(join(repo, ".muster"), { recursive: true });
  await writeFile(routing, JSON.stringify({ taskTypes: {
    implementation: [{ provider: "scripted" }],
    verification: [{ provider: "scripted" }],
  } }), "utf8");
  process.env.MUSTER_ROUTING_FILE = routing;
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const launched = await command(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "launch", sortiePath, "--approve"], { cwd: repo });
  return { repo, runId: (JSON.parse(launched.stdout) as { runId: string }).runId };
}

async function waitForStatus(repo: string, runId: string, statuses: string[]): Promise<string> {
  let status = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const store = new EventStore(repo);
    status = store.getRun(runId)?.status ?? "";
    store.close();
    if (statuses.includes(status)) return status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return status;
}

async function createFixture(options: { failingCheck: boolean; maxRepairRounds: number; repairRequired?: boolean }): Promise<{
  repo: string;
  runId: string;
  branch: string;
}> {
  const repo = await mkdtemp(join(tmpdir(), "muster-test-"));
  await command("git", ["init", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, ".gitignore"), ".muster/\n", "utf8");
  await writeFile(join(repo, "README.md"), "fixture\n", "utf8");
  const sortiePath = join(repo, "fixture.sortie.ts");
  await writeFile(sortiePath, `
    export default {
      name: "Fixture change",
      contract: {
        summary: "Create an implementation artifact without changing main",
        criteria: [{
          id: "criterion-file",
          description: "The implementation artifact exists",
          evidence: { kind: "command", command: ${JSON.stringify(options.failingCheck ? "exit 7" : options.repairRequired ? "test -f repair-1.txt" : "test -f implement.txt")} }
        }, {
          id: "criterion-review",
          description: "An independent verifier accepts the result",
          evidence: { kind: "agent", prompt: "Confirm the requested artifact is coherent." }
        }]
      },
      roles: {
        implementer: { taskType: "implementation" },
        verifier: { taskType: "verification" }
      },
      limits: { maxConcurrency: 1, maxTaskAttempts: 1, maxRepairRounds: ${options.maxRepairRounds} },
      tasks: [{ id: "implement", title: "Implement fixture", prompt: "Create the requested fixture" }],
      pullRequest: { enabled: false }
    };
  `, "utf8");
  await command("git", ["add", "."], { cwd: repo });
  await command("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: repo });

  const routingPath = join(repo, "routing.json");
  await writeFile(routingPath, JSON.stringify({
    taskTypes: {
      implementation: [{ provider: "scripted" }],
      verification: [{ provider: "scripted" }],
    },
  }), "utf8");
  process.env.MUSTER_ROUTING_FILE = routingPath;

  const sortie = await loadSortie(sortiePath);
  const snapshot = contractSnapshot(sortie);
  const runId = `test-${Math.random().toString(16).slice(2)}`;
  const branch = `muster/${runId}`;
  const store = new EventStore(repo);
  store.createRun({
    id: runId,
    status: "queued",
    repo_root: repo,
    sortie_path: sortiePath,
    contract_hash: snapshot.hash,
    contract_json: snapshot.json,
    branch,
    base_branch: "main",
  });
  store.event(runId, "contract.approved", { source: "test" });
  store.close();
  return { repo, runId, branch };
}
