export type Provider = "cursor" | "codex" | "scripted";

export type Role = {
  taskType: string;
};

export type RouteCandidate = {
  provider: Provider;
  model?: string;
};

export type Criterion = {
  id: string;
  description: string;
  evidence:
    | { kind: "command"; command: string }
    | { kind: "agent"; prompt: string };
};

export type Task = {
  id: string;
  title: string;
  prompt: string;
  dependsOn?: string[];
};

export type Sortie = {
  name: string;
  contract: {
    summary: string;
    criteria: Criterion[];
  };
  roles: {
    implementer: Role;
    verifier: Role;
  };
  limits?: {
    maxConcurrency?: number;
    maxTaskAttempts?: number;
    maxRepairRounds?: number;
  };
  repository?: {
    baseBranch?: string;
  };
  tasks: Task[];
  pullRequest?: {
    enabled?: boolean;
    title?: string;
  };
};

export type ResolvedSortie = Sortie & {
  limits: {
    maxConcurrency: number;
    maxTaskAttempts: number;
    maxRepairRounds: number;
  };
  repository: {
    baseBranch: string;
  };
  pullRequest: {
    enabled: boolean;
    title: string;
  };
};

export type WorkerRequest = {
  runId: string;
  taskId: string;
  prompt: string;
  cwd: string;
  stateDir: string;
  model?: string;
  sessionId?: string;
  readOnly: boolean;
  signal: AbortSignal;
  onEvent: (type: string, payload: Record<string, unknown>) => void;
};

export type WorkerResult = {
  sessionId?: string;
  finalText: string;
};

export interface WorkerAdapter {
  run(request: WorkerRequest): Promise<WorkerResult>;
}

export function defineSortie(sortie: Sortie): ResolvedSortie {
  validateUnique(sortie.contract.criteria.map((item) => item.id), "criterion");
  validateUnique(sortie.tasks.map((item) => item.id), "task");

  const taskIds = new Set(sortie.tasks.map((task) => task.id));
  for (const task of sortie.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!taskIds.has(dependency)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      }
    }
  }

  return {
    ...sortie,
    limits: {
      maxConcurrency: positive(sortie.limits?.maxConcurrency ?? 2, "maxConcurrency"),
      maxTaskAttempts: positive(sortie.limits?.maxTaskAttempts ?? 2, "maxTaskAttempts"),
      maxRepairRounds: nonNegative(sortie.limits?.maxRepairRounds ?? 2, "maxRepairRounds"),
    },
    repository: {
      baseBranch: sortie.repository?.baseBranch ?? "HEAD",
    },
    pullRequest: {
      enabled: sortie.pullRequest?.enabled ?? true,
      title: sortie.pullRequest?.title ?? sortie.name,
    },
  };
}

function validateUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(value)) {
      throw new Error(`Invalid ${label} id: ${value}`);
    }
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label} id: ${value}`);
    }
    seen.add(value);
  }
}

function positive(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
