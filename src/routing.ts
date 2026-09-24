import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Provider, Role, RouteCandidate, Sortie, Task } from "./types.js";

export type RoutingConfig = {
  taskTypes: Record<string, RouteCandidate[]>;
};

const defaults: RoutingConfig = {
  taskTypes: {
    implementation: [{ provider: "cursor", model: "grok-4.6" }],
    verification: [{ provider: "codex" }],
  },
};

export function routingPath(): string {
  return process.env.MUSTER_ROUTING_FILE
    ? resolve(process.env.MUSTER_ROUTING_FILE)
    : resolve(homedir(), ".config", "muster", "routing.json");
}

export function loadRouting(): RoutingConfig {
  const path = routingPath();
  if (!existsSync(path)) return defaults;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RoutingConfig>;
  if (!parsed.taskTypes || typeof parsed.taskTypes !== "object") {
    throw new Error(`Invalid routing file ${path}: taskTypes is required`);
  }
  for (const [taskType, candidates] of Object.entries(parsed.taskTypes)) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`Invalid routing file ${path}: ${taskType} needs at least one route`);
    }
    for (const candidate of candidates) validateCandidate(candidate, path, taskType);
  }
  return parsed as RoutingConfig;
}

export function routesFor(role: Role, config = loadRouting()): RouteCandidate[] {
  const candidates = config.taskTypes[role.taskType];
  if (!candidates?.length) {
    throw new Error(`No approved route configured for task type: ${role.taskType}`);
  }
  return candidates;
}

export function implementationRole(task: Task, fallback: Role): Role {
  return { taskType: task.taskType ?? fallback.taskType };
}

export function resolveSortieRouting(sortie: Sortie, config = loadRouting()) {
  const resolveRole = (role: Role) => ({ taskType: role.taskType, routes: routesFor(role, config) });
  return {
    roles: {
      implementer: resolveRole(sortie.roles.implementer),
      verifier: resolveRole(sortie.roles.verifier),
    },
    tasks: sortie.tasks.map((task) => ({
      id: task.id,
      ...resolveRole(implementationRole(task, sortie.roles.implementer)),
    })),
  };
}

function validateCandidate(candidate: RouteCandidate, path: string, taskType: string): void {
  const providers: Provider[] = ["cursor", "codex", "claude", "scripted"];
  if (!candidate || !providers.includes(candidate.provider)) {
    throw new Error(`Invalid provider for ${taskType} in ${path}`);
  }
}
