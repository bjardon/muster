import { Agent, Cursor, JsonlLocalAgentStore } from "@cursor/sdk";
import { join } from "node:path";
import type { SDKAgent, ToolName } from "@cursor/sdk";
import type { WorkerAdapter, WorkerRequest, WorkerResult } from "../types.js";

export const DEFAULT_CURSOR_MODEL = "grok-4.6";
const IMPLEMENTATION_TOOLS: ToolName[] = [
  "read",
  "edit",
  "write",
  "delete",
  "grep",
  "glob",
  "ls",
  "shell",
  "semSearch",
  "readLints",
  "updateTodos",
  "readTodos",
];
const VERIFICATION_TOOLS: ToolName[] = ["read", "grep", "glob", "ls", "semSearch", "readLints"];

export class CursorAdapter implements WorkerAdapter {
  async run(request: WorkerRequest): Promise<WorkerResult> {
    if (request.signal.aborted) throw new Error("Cursor run was cancelled before it started");

    const model = request.model ?? DEFAULT_CURSOR_MODEL;
    const store = new JsonlLocalAgentStore(join(request.stateDir, "cursor", request.runId));
    const options = {
      model: { id: model },
      name: `Muster ${request.runId}/${request.taskId}`,
      tools: request.readOnly ? VERIFICATION_TOOLS : IMPLEMENTATION_TOOLS,
      local: {
        cwd: request.cwd,
        store,
        settingSources: ["project" as const],
        sandboxOptions: { enabled: true },
      },
      mode: "agent" as const,
    };

    let agent: SDKAgent | undefined;
    let run: Awaited<ReturnType<SDKAgent["send"]>> | undefined;
    const abort = () => {
      if (run) void run.cancel();
    };
    request.signal.addEventListener("abort", abort, { once: true });

    try {
      agent = request.sessionId
        ? await Agent.resume(request.sessionId, options)
        : await Agent.create(options);
      request.onEvent("worker.session", { provider: "cursor", sessionId: agent.agentId });

      run = await agent.send(scopedPrompt(request), {
        local: request.sessionId ? { force: true } : undefined,
      });
      request.onEvent("worker.run", { provider: "cursor", runId: run.id, model });

      for await (const event of run.stream()) {
        if (event.type === "tool_call") {
          request.onEvent("worker.tool", {
            provider: "cursor",
            name: event.name,
            status: event.status,
          });
        }
      }

      const result = await run.wait();
      if (result.status !== "finished") {
        throw new Error(result.error?.message ?? `Cursor run ${result.status}`);
      }
      return { sessionId: agent.agentId, finalText: result.result ?? "" };
    } finally {
      request.signal.removeEventListener("abort", abort);
      agent?.close();
    }
  }
}

export async function assertCursorReady(requestedModels: Array<string | undefined>): Promise<void> {
  let catalog;
  try {
    catalog = await Cursor.models.list();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor SDK is not ready: ${message}. Run muster cursor-login or set CURSOR_API_KEY.`);
  }

  const available = new Set(catalog.flatMap((model) => [model.id, ...(model.aliases ?? [])]));
  for (const requested of requestedModels) {
    const model = requested ?? DEFAULT_CURSOR_MODEL;
    if (!available.has(model)) {
      throw new Error(`Cursor model ${model} is not available to the authenticated account`);
    }
  }
}

function scopedPrompt(request: WorkerRequest): string {
  const authority = request.readOnly
    ? "Inspect the assigned worktree without changing files or Git state."
    : "Implement the task only inside the assigned worktree.";
  return [
    authority,
    "Do not push, open a pull request, access secrets, or change the acceptance criteria.",
    request.prompt,
  ].join("\n\n");
}
