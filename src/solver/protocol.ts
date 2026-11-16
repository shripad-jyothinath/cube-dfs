import type { SolverProgress } from './dfs';

export interface SolveRequest {
  type: 'solve';
  id: number;
  stickers: number[];
  depthLimit: number;
  nodeBudget: number;
  timeBudgetMs: number;
}

export interface SolveProgressMessage {
  type: 'progress';
  id: number;
  progress: SolverProgress;
}

export type WorkerSolveReason = 'solved' | 'exhausted' | 'budget' | 'timeout';

export interface SolveDoneMessage {
  type: 'done';
  id: number;
  solution: string[] | null;
  reason: WorkerSolveReason;
  nodes: number;
  visited: number;
  pruned: number;
  elapsedMs: number;
  depthLimit: number;
}

export type WorkerResponse = SolveProgressMessage | SolveDoneMessage;
