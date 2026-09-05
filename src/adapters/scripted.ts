import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerAdapter, WorkerRequest, WorkerResult } from "../types.js";

export class ScriptedAdapter implements WorkerAdapter {
  async run(request: WorkerRequest): Promise<WorkerResult> {
    const delay = request.prompt.match(/\[delay:(\d+)\]/)?.[1];
    if (delay) await abortableDelay(Number(delay), request.signal);
    if (!request.readOnly) {
      await writeFile(join(request.cwd, `${request.taskId}.txt`), `${request.prompt}\n`, "utf8");
    }
    return {
      sessionId: `scripted-${request.taskId}`,
      finalText: request.readOnly ? JSON.stringify({ accepted: true, evidence: "scripted verifier" }) : "scripted change written",
    };
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Scripted worker aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
