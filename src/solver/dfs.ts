import {
  CubeState,
  MOVES,
  getMovePermutation,
  inverseMove,
  type Face,
  type Move,
} from '../cube/CubeState';

export interface SolverProgress {
  nodes: number;
  visited: number;
  elapsedMs: number;
  depth: number;
}

export type SolveReason = 'solved' | 'exhausted' | 'budget' | 'timeout';

export interface SolveOptions {
  maxDepth: number;
  nodeBudget: number;
  timeBudgetMs: number;
  onProgress?: (progress: SolverProgress) => void;
  /** Called when this depth-limited search gives up (not when it succeeds). */
  now?: () => number;
}

export interface SolveResult {
  /** null when the bound was exhausted or the search was cut short. */
  solution: Move[] | null;
  reason: SolveReason;
  nodes: number;
  visited: number;
  pruned: number;
  elapsedMs: number;
  depthLimit: number;
}

/**
 * Depth-limited DFS over a single flat sticker array.
 *
 * - No allocation per node: moves are applied in place with cycles and undone.
 * - Visited transpositions are keyed by the exact 54-sticker state.
 * - A shortest seen path is cached per state so a state may be re-entered if a
 *   later path has more remaining depth.
 * - Pruning: inverse / same-face repetition, and a face repeat within the
 *   previous two plies are skipped as the brief specifies. The scramble
 *   generator mirrors this contract so short demos always retain a legal path.
 */
export function solveDepthLimited(start: CubeState, options: SolveOptions): SolveResult {
  const {
    maxDepth,
    nodeBudget,
    timeBudgetMs,
    onProgress,
    now = () => performance.now(),
  } = options;

  const startedAt = now();
  const stickers = Uint8Array.from(start.stickers);
  const path: Move[] = [];
  const visited = new Map<string, number>();
  let nodes = 0;
  let pruned = 0;
  let stopped: SolveReason | null = null;
  let solution: Move[] | null = null;
  let lastProgressAt = 0;

  const isSolved = (): boolean => {
    for (let index = 0; index < 54; index += 1) {
      if (stickers[index] !== Math.floor(index / 9)) return false;
    }
    return true;
  };

  const keyFor = (): string => {
    let key = '';
    for (let index = 0; index < 54; index += 2) {
      key += KEY_ALPHABET[stickers[index] | (stickers[index + 1] << 3)];
    }
    return key;
  };

  const emitProgress = (force = false): void => {
    if (!onProgress) return;
    const elapsed = now() - startedAt;
    if (!force && elapsed - lastProgressAt < 70) return;
    lastProgressAt = elapsed;
    onProgress({
      nodes,
      visited: visited.size,
      elapsedMs: elapsed,
      depth: path.length,
    });
  };

  const checkLimits = (): boolean => {
    if (stopped) return true;
    if (nodes > nodeBudget) {
      stopped = 'budget';
      return true;
    }
    if ((nodes & 2047) === 0 && now() - startedAt > timeBudgetMs) {
      stopped = 'timeout';
      return true;
    }
    return false;
  };

  const search = (
    remaining: number,
    prevFace: string | null,
    prevPrevFace: string | null,
  ): boolean => {
    nodes += 1;
    emitProgress();
    if (checkLimits()) return false;

    if (isSolved()) {
      stopped = 'solved';
      solution = path.slice();
      return true;
    }

    if (remaining <= 0) return false;

    // The legal-move set depends on the previous two faces, so the
    // transposition key must include them to keep pruning sound.
    const key = `${keyFor()}${prevFace ?? '-'}${prevPrevFace ?? '-'}`;
    const seenDepth = visited.get(key);
    if (seenDepth !== undefined && seenDepth >= remaining) {
      pruned += 1;
      return false;
    }
    visited.set(key, remaining);

    for (const move of MOVES) {
      if (move.face === prevFace || move.face === prevPrevFace) {
        pruned += 1;
        continue;
      }
      if (prevFace && OPPOSITE[prevFace as Face] === move.face) {
        pruned += 1;
        continue;
      }
      const previous = path[path.length - 1];
      if (previous && previous.face === move.face && (previous.amount + move.amount) % 4 === 0) {
        pruned += 1;
        continue;
      }

      applyForward(stickers, move);
      path.push(move);
      const solved = search(remaining - 1, move.face, prevFace);
      path.pop();
      applyBackward(stickers, move);

      if (solved) return true;
      if (stopped === 'budget' || stopped === 'timeout') return false;
    }

    return false;
  };

  const solved = search(maxDepth, null, null);
  const elapsedMs = now() - startedAt;
  emitProgress(true);

  return {
    solution: solved && stopped === 'solved' ? solution : null,
    reason: stopped ?? 'exhausted',
    nodes,
    visited: visited.size,
    pruned,
    elapsedMs,
    depthLimit: maxDepth,
  };
}

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const OPPOSITE: Record<Face, Face> = {
  U: 'D',
  D: 'U',
  R: 'L',
  L: 'R',
  F: 'B',
  B: 'F',
};

function applyForward(stickers: Uint8Array, move: Move): void {
  const { cycles } = getMovePermutation(move);
  for (const cycle of cycles) {
    const last = stickers[cycle[cycle.length - 1]];
    for (let index = cycle.length - 1; index > 0; index -= 1) {
      stickers[cycle[index]] = stickers[cycle[index - 1]];
    }
    stickers[cycle[0]] = last;
  }
}

function applyBackward(stickers: Uint8Array, move: Move): void {
  const { cycles } = getMovePermutation(inverseMove(move));
  for (const cycle of cycles) {
    const last = stickers[cycle[cycle.length - 1]];
    for (let index = cycle.length - 1; index > 0; index -= 1) {
      stickers[cycle[index]] = stickers[cycle[index - 1]];
    }
    stickers[cycle[0]] = last;
  }
}
