import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, claudeToolAllowed } from "../src/adapters/claude.js";
import type { WorkerRequest } from "../src/types.js";

const request = (overrides: Partial<WorkerRequest> = {}): WorkerRequest => ({
  runId: "test", taskId: "test", prompt: "Inspect", cwd: process.cwd(), stateDir: tmpdir(),
  readOnly: true, signal: new AbortController().signal, onEvent: () => {}, ...overrides,
});

function fakeQuery(messages: unknown[], inspect: (options: Options) => void = () => {}) {
  let closed = false;
  const start = ({ options }: { prompt: string; options: Options }) => {
    inspect(options);
    return {
      async *[Symbol.asyncIterator]() { for (const message of messages) yield message as SDKMessage; },
      close() { closed = true; },
    };
  };
  return { start, closed: () => closed };
}

test("Claude limits tools by role and denies paths escaping the worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muster-claude-permissions-"));
  const cwd = join(directory, "worktree");
  await mkdir(cwd);
  await writeFile(join(directory, "outside.txt"), "private");
  await symlink(directory, join(cwd, "escape"));
  await mkdir(join(cwd, ".git"));
  await symlink(join(cwd, ".git"), join(cwd, "git-alias"));
  assert.equal(claudeToolAllowed(cwd, true, "Read", { file_path: "README.md" }), true);
  assert.equal(claudeToolAllowed(cwd, true, "Write", { file_path: "README.md" }), false);
  assert.equal(claudeToolAllowed(cwd, false, "Write", { file_path: "src/new.ts" }), true);
  assert.equal(claudeToolAllowed(cwd, false, "Write", { file_path: "../outside.txt" }), false);
  assert.equal(claudeToolAllowed(cwd, true, "Read", { file_path: "escape/outside.txt" }), false);
  assert.equal(claudeToolAllowed(cwd, false, "Write", { file_path: "escape/new.txt" }), false);
  assert.equal(claudeToolAllowed(cwd, false, "Write", { file_path: ".git/config" }), false);
  assert.equal(claudeToolAllowed(cwd, true, "Grep", { path: directory }), false);
  assert.equal(claudeToolAllowed(cwd, true, "Glob", {}), true);
  assert.equal(claudeToolAllowed(cwd, true, "Glob", { pattern: "../*" }), false);
  assert.equal(claudeToolAllowed(cwd, false, "Write", { file_path: "git-alias/config" }), false);
  assert.equal(claudeToolAllowed(cwd, false, "Bash", { command: "touch file" }), false);
  assert.equal(claudeToolAllowed(cwd, false, "Agent", {}), false);
});

test("Claude returns final output and persists the session for resume", async () => {
  const events: unknown[] = [];
  const fake = fakeQuery([
    { type: "system", subtype: "init", session_id: "session" },
    { type: "result", subtype: "success", is_error: false, result: "accepted", session_id: "session" },
  ], (options) => {
    assert.equal(options.resume, "previous");
    assert.equal(options.model, "sonnet");
    assert.deepEqual(options.tools, ["Read", "Glob", "Grep"]);
    assert.equal(options.permissionMode, "dontAsk");
    assert.ok(options.hooks?.PreToolUse?.length);
  });
  const result = await new ClaudeAdapter(fake.start).run(request({ sessionId: "previous", model: "sonnet", onEvent: (...args) => events.push(args) }));
  assert.deepEqual(result, { sessionId: "session", finalText: "accepted" });
  assert.deepEqual(events, [["worker.session", { provider: "claude", sessionId: "session" }]]);
  assert.equal(fake.closed(), true);
});

test("Claude rejects provider errors and incomplete streams", async () => {
  for (const messages of [
    [{ type: "result", subtype: "error_max_turns", errors: ["turn limit"] }],
    [{ type: "result", subtype: "success", is_error: true, result: "account unavailable" }],
    [],
  ]) {
    const fake = fakeQuery(messages);
    await assert.rejects(new ClaudeAdapter(fake.start).run(request()), /turn limit|account unavailable|without a result/);
    assert.equal(fake.closed(), true);
  }
});

test("Claude cancels before startup and forwards cancellation during a run", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new ClaudeAdapter(() => { throw new Error("must not start"); }).run(request({ signal: controller.signal })), { name: "AbortError" });
  const active = new AbortController();
  let sdkSignal: AbortSignal | undefined;
  const fake = fakeQuery([], options => { sdkSignal = options.abortController?.signal; active.abort(); });
  await assert.rejects(new ClaudeAdapter(fake.start).run(request({ signal: active.signal })), { name: "AbortError" });
  assert.equal(sdkSignal?.aborted, true);
  assert.equal(fake.closed(), true);
});
