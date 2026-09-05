import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RunStatus =
  | "queued"
  | "running"
  | "draining"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "succeeded";

export type RunRecord = {
  id: string;
  status: RunStatus;
  repo_root: string;
  sortie_path: string;
  contract_hash: string;
  contract_json: string;
  branch: string;
  base_branch: string;
  pause_requested: number;
  cancel_requested: number;
  pid: number | null;
  message: string | null;
  created_at: string;
  updated_at: string;
};

export class EventStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(repoRoot: string) {
    this.path = join(repoRoot, ".muster", "muster.sqlite");
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        sortie_path TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        pause_requested INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        pid INTEGER,
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        branch TEXT,
        worktree TEXT,
        commit_sha TEXT,
        session_id TEXT,
        last_error TEXT,
        PRIMARY KEY (run_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS checks (
        run_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        output TEXT NOT NULL,
        PRIMARY KEY (run_id, check_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createRun(input: Omit<RunRecord, "pause_requested" | "cancel_requested" | "pid" | "message" | "created_at" | "updated_at">): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO runs (id, status, repo_root, sortie_path, contract_hash, contract_json, branch, base_branch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.status, input.repo_root, input.sortie_path, input.contract_hash, input.contract_json, input.branch, input.base_branch, now, now);
    this.event(input.id, "run.created", { branch: input.branch });
  }

  getRun(id: string): RunRecord | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRecord | undefined;
  }

  latestRun(): RunRecord | undefined {
    return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 1").get() as RunRecord | undefined;
  }

  updateRun(id: string, values: Partial<Pick<RunRecord, "status" | "pause_requested" | "cancel_requested" | "pid" | "message">>): void {
    const entries = Object.entries(values);
    if (entries.length === 0) return;
    const fields = entries.map(([key]) => `${key} = ?`).join(", ");
    this.db.prepare(`UPDATE runs SET ${fields}, updated_at = ? WHERE id = ?`).run(...entries.map(([, value]) => value), new Date().toISOString(), id);
  }

  event(runId: string, type: string, payload: Record<string, unknown> = {}): void {
    this.db.prepare("INSERT INTO events (run_id, at, type, payload) VALUES (?, ?, ?, ?)")
      .run(runId, new Date().toISOString(), type, JSON.stringify(payload));
  }

  events(runId: string, limit = 30): Array<{ seq: number; at: string; type: string; payload: string }> {
    return this.db.prepare("SELECT seq, at, type, payload FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?")
      .all(runId, limit) as Array<{ seq: number; at: string; type: string; payload: string }>;
  }

  ensureTask(runId: string, taskId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO tasks (run_id, task_id, status) VALUES (?, ?, 'pending')").run(runId, taskId);
  }

  task(runId: string, taskId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE run_id = ? AND task_id = ?").get(runId, taskId) as Record<string, unknown> | undefined;
  }

  tasks(runId: string): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id").all(runId) as Array<Record<string, unknown>>;
  }

  updateTask(runId: string, taskId: string, values: Record<string, string | number | null>): void {
    const entries = Object.entries(values);
    const fields = entries.map(([key]) => `${key} = ?`).join(", ");
    this.db.prepare(`UPDATE tasks SET ${fields} WHERE run_id = ? AND task_id = ?`).run(...entries.map(([, value]) => value), runId, taskId);
  }

  saveCheck(runId: string, checkId: string, status: string, exitCode: number | null, output: string): void {
    this.db.prepare(`
      INSERT INTO checks (run_id, check_id, status, exit_code, output) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, check_id) DO UPDATE SET status = excluded.status, exit_code = excluded.exit_code, output = excluded.output
    `).run(runId, checkId, status, exitCode, output);
  }

  checks(runId: string): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM checks WHERE run_id = ? ORDER BY check_id").all(runId) as Array<Record<string, unknown>>;
  }
}
