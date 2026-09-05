import type { Provider, WorkerAdapter } from "../types.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { ScriptedAdapter } from "./scripted.js";

export function adapterFor(provider: Provider): WorkerAdapter {
  if (provider === "cursor") return new CursorAdapter();
  if (provider === "codex") return new CodexAdapter();
  return new ScriptedAdapter();
}
