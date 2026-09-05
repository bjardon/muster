import { Codex } from "@openai/codex-sdk";
import type { WorkerAdapter, WorkerRequest, WorkerResult } from "../types.js";

export class CodexAdapter implements WorkerAdapter {
  async run(request: WorkerRequest): Promise<WorkerResult> {
    const codex = new Codex();
    const options = {
      model: request.model,
      workingDirectory: request.cwd,
      sandboxMode: request.readOnly ? "read-only" as const : "workspace-write" as const,
      approvalPolicy: "never" as const,
      networkAccessEnabled: false,
    };
    const thread = request.sessionId
      ? codex.resumeThread(request.sessionId, options)
      : codex.startThread(options);
    const streamed = await thread.runStreamed(request.prompt, { signal: request.signal });
    let finalText = "";
    for await (const event of streamed.events) {
      if (event.type === "thread.started") {
        request.onEvent("worker.session", { provider: "codex", sessionId: event.thread_id });
      } else if (event.type === "item.completed" && event.item.type === "agent_message") {
        finalText = event.item.text;
      } else if (event.type === "item.completed" && event.item.type === "command_execution") {
        request.onEvent("worker.command", {
          provider: "codex",
          command: event.item.command,
          exitCode: event.item.exit_code ?? null,
        });
      }
    }
    return { sessionId: thread.id ?? request.sessionId, finalText };
  }
}
