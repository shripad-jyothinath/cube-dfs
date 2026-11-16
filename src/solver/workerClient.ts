import type { CubeState } from '../cube/CubeState';
import type { SolverProgress } from './dfs';
import type {
  SolveDoneMessage,
  SolveRequest,
  WorkerResponse,
  WorkerSolveReason,
} from './protocol';

export interface AttemptResult {
  solution: string[] | null;
  reason: WorkerSolveReason;
  nodes: number;
  visited: number;
  pruned: number;
  elapsedMs: number;
  depthLimit: number;
}

interface PendingSolve {
  id: number;
  onProgress: (progress: SolverProgress) => void;
  resolve: (result: AttemptResult) => void;
  reject: (error: Error) => void;
}

export class SolverWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: PendingSolve | null = null;

  solve(
    state: CubeState,
    options: {
      depthLimit: number;
      nodeBudget: number;
      timeBudgetMs: number;
      onProgress: (progress: SolverProgress) => void;
    },
  ): Promise<AttemptResult> {
    this.cancel();
    const worker = this.ensureWorker();
    const id = this.nextId++;

    return new Promise<AttemptResult>((resolve, reject) => {
      this.pending = { id, onProgress: options.onProgress, resolve, reject };
      const request: SolveRequest = {
        type: 'solve',
        id,
        stickers: Array.from(state.stickers),
        depthLimit: options.depthLimit,
        nodeBudget: options.nodeBudget,
        timeBudgetMs: options.timeBudgetMs,
      };
      worker.postMessage(request);
    });
  }

  cancel(): void {
    if (!this.worker) {
      this.pending = null;
      return;
    }
    this.worker.terminate();
    this.worker = null;
    if (this.pending) {
      this.pending.reject(new Error('Solver cancelled'));
      this.pending = null;
    }
  }

  dispose(): void {
    this.cancel();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./dfs.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const pending = this.pending;
      if (!pending || message.id !== pending.id) return;

      if (message.type === 'progress') {
        pending.onProgress(message.progress);
        return;
      }

      const done = message as SolveDoneMessage;
      this.pending = null;
      pending.resolve({
        solution: done.solution,
        reason: done.reason,
        nodes: done.nodes,
        visited: done.visited,
        pruned: done.pruned,
        elapsedMs: done.elapsedMs,
        depthLimit: done.depthLimit,
      });
    };
    worker.onerror = (event) => {
      if (this.pending) {
        this.pending.reject(new Error(event.message || 'Solver worker crashed'));
        this.pending = null;
      }
    };
    this.worker = worker;
    return worker;
  }
}
