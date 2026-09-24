import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkerAdapter, WorkerRequest, WorkerResult } from "../types.js";

type Query = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & { close(): void };

export class ClaudeAdapter implements WorkerAdapter {
  constructor(private readonly startQuery: Query = query) {}

  async run(request: WorkerRequest): Promise<WorkerResult> {
    request.signal.throwIfAborted();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    let sessionId = request.sessionId;
    let finalText: string | undefined;
    let stream: ReturnType<Query> | undefined;
    const tools = request.readOnly ? ["Read", "Glob", "Grep"] : ["Read", "Glob", "Grep", "Edit", "Write"];

    try {
      stream = this.startQuery({
        prompt: request.prompt,
        options: {
          abortController,
          cwd: request.cwd,
          model: request.model,
          resume: request.sessionId,
          maxTurns: 40,
          persistSession: true,
          permissionMode: "dontAsk",
          tools,
          allowedTools: tools,
          // Hooks run even for reads the SDK would otherwise auto-approve.
          hooks: { PreToolUse: [{ hooks: [async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const allowed = claudeToolAllowed(request.cwd, request.readOnly, input.tool_name, input.tool_input);
            request.onEvent("worker.tool", { provider: "claude", name: input.tool_name, allowed });
            return { hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: allowed ? "allow" : "deny",
              permissionDecisionReason: allowed ? "Within assigned authority" : "Muster denied a tool or path outside assigned authority",
            } };
          }] }] },
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: "Work only inside the assigned Git worktree. Never push, open a pull request, access secrets, or change acceptance criteria. Shell commands are unavailable; the runtime runs command checks."
              + (request.readOnly ? " You are a read-only verifier. Do not change files or Git state." : " Implement using Read, Glob, Grep, Edit, and Write."),
          },
          // Do not load user/project hooks, plugins, or permission overrides.
          settingSources: [],
        },
      });
      for await (const message of stream) {
        request.signal.throwIfAborted();
        if ("session_id" in message) sessionId = message.session_id;
        if (message.type === "system" && message.subtype === "init") {
          request.onEvent("worker.session", { provider: "claude", sessionId: message.session_id });
        }
        if (message.type === "result") {
          if (message.subtype !== "success") throw new Error(message.errors.join("\n") || message.subtype);
          if (message.is_error) throw new Error(message.result || "Claude reported an error");
          finalText = message.result;
        }
      }
      request.signal.throwIfAborted();
      if (finalText === undefined) throw new Error("Claude stream ended without a result");
      return { sessionId, finalText };
    } finally {
      request.signal.removeEventListener("abort", abort);
      stream?.close();
    }
  }
}

export function claudeToolAllowed(cwd: string, readOnly: boolean, tool: string, input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const fileTool = ["Read", "Edit", "Write"].includes(tool);
  if (!fileTool && tool !== "Glob" && tool !== "Grep") return false;
  if (readOnly && (tool === "Edit" || tool === "Write")) return false;
  const candidate = fileTool ? ("file_path" in input ? input.file_path : undefined) : ("path" in input ? input.path : cwd);
  if (typeof candidate !== "string" || !candidate) return false;
  if (tool === "Glob" && "pattern" in input && typeof input.pattern === "string"
    && (isAbsolute(input.pattern) || input.pattern.split(/[\\/]/).includes(".."))) return false;
  try {
    const root = realpathSync(cwd);
    const absolute = resolve(cwd, candidate);
    if (!inside(root, absolute) && !inside(resolve(cwd), absolute)) return false;
    // Resolve existing ancestors too, so a new file through an escaping symlink is denied.
    let ancestor = absolute;
    while (true) {
      try {
        const real = realpathSync(ancestor);
        const target = resolve(real, relative(ancestor, absolute));
        if (!inside(root, target) || relative(root, target).split(sep).includes(".git")) return false;
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || dirname(ancestor) === ancestor) return false;
        ancestor = dirname(ancestor);
      }
    }
    return !relative(resolve(cwd), absolute).split(sep).includes(".git");
  } catch {
    return false;
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
