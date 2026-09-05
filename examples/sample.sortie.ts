import { defineSortie } from "../src/types.js";

export default defineSortie({
  name: "Add a health endpoint",
  contract: {
    summary: "Add an unauthenticated health endpoint without changing existing application behavior.",
    criteria: [
      {
        id: "health-response",
        description: "GET /health returns HTTP 200 with a JSON status of ok.",
        evidence: { kind: "command", command: "pnpm test -- --runInBand health" },
      },
      {
        id: "existing-behavior",
        description: "The existing test suite still passes.",
        evidence: { kind: "command", command: "pnpm test" },
      },
      {
        id: "implementation-fit",
        description: "The endpoint follows the repository's existing routing conventions.",
        evidence: {
          kind: "agent",
          prompt: "Compare the endpoint with adjacent routes and cite the matching conventions.",
        },
      },
    ],
  },
  roles: {
    implementer: { taskType: "implementation" },
    verifier: { taskType: "verification" },
  },
  limits: {
    maxConcurrency: 2,
    maxTaskAttempts: 2,
    maxRepairRounds: 2,
  },
  tasks: [
    {
      id: "health-endpoint",
      title: "Implement the health endpoint",
      prompt: "Inspect the existing server conventions, add GET /health, and add focused automated coverage.",
    },
  ],
});
