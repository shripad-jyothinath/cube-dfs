/// <reference lib="webworker" />
import { CubeState, notation } from '../cube/CubeState';
import { solveDepthLimited } from './dfs';
import type {
  SolveDoneMessage,
  SolveProgressMessage,
  SolveRequest,
} from './protocol';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<SolveRequest>) => {
  const request = event.data;
  if (request.type !== 'solve') return;

  const state = new CubeState(request.stickers);
  let lastSent = 0;

  const result = solveDepthLimited(state, {
    maxDepth: request.depthLimit,
    nodeBudget: request.nodeBudget,
    timeBudgetMs: request.timeBudgetMs,
    onProgress: (progress) => {
      const now = performance.now();
      if (now - lastSent < 55) return;
      lastSent = now;
      const message: SolveProgressMessage = { type: 'progress', id: request.id, progress };
      workerScope.postMessage(message);
    },
  });

  const done: SolveDoneMessage = {
    type: 'done',
    id: request.id,
    solution: result.solution ? notation(result.solution) : null,
    reason: result.reason,
    nodes: result.nodes,
    visited: result.visited,
    pruned: result.pruned,
    elapsedMs: result.elapsedMs,
    depthLimit: result.depthLimit,
  };
  workerScope.postMessage(done);
};

export {};
