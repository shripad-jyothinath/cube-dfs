import { describe, expect, it } from 'vitest';
import {
  CubeState,
  FACES,
  MOVES,
  faceletIndexFromPosition,
  faceletPosition,
  getMovePermutation,
  inverseMove,
  parseMove,
  type Move,
} from '../cube/CubeState';
import { generateScramble } from '../cube/scramble';
import { solveDepthLimited } from '../solver/dfs';

const seededRng = (seed: number) => {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
};

function toMoves(names: string[]): Move[] {
  return names.map(parseMove);
}

describe('logical cube', () => {
  it('maps every facelet to a unique 3D face position and back', () => {
    const positions = new Set<string>();
    for (const face of FACES) {
      for (let index = 0; index < 9; index += 1) {
        const position = faceletPosition(face, index);
        positions.add(`${face}:${position.join(',')}`);
        expect(faceletIndexFromPosition(face, position)).toBe(index);
      }
    }
    expect(positions.size).toBe(54);
  });

  it('builds bijective permutations for every move', () => {
    for (const move of MOVES) {
      const map = getMovePermutation(move).map;
      expect(new Set(map).size).toBe(54);
    }
  });

  it('solves after every move and its inverse', () => {
    for (const move of MOVES) {
      const cube = CubeState.solved().apply(move).apply(inverseMove(move));
      expect(cube.isSolved()).toBe(true);
    }
  });

  it('preserves the same cube through a sequence and its inverse', () => {
    const moves = toMoves(['R', 'U', "R'", 'U2', 'F', "D'", 'L2', 'B']);
    const cube = CubeState.solved().applySequence(moves);
    const unscramble = [...moves].reverse().map(inverseMove);
    cube.applySequence(unscramble);
    expect(cube.isSolved()).toBe(true);
  });

  it('round-trips every move through the compact state key', () => {
    const state = CubeState.solved();
    for (const move of MOVES) {
      const moved = state.clone().apply(move);
      expect(moved.key()).toHaveLength(27);
      expect(moved.key()).not.toBe(state.key());
      const restored = moved.clone().apply(inverseMove(move));
      expect(restored.key()).toBe(state.key());
    }
  });
});

describe('scramble generation and DFS', () => {
  it('creates genuine full-length random scrambles with no precomputed solution', () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      const scramble = generateScramble(7, seededRng(seed));
      expect(scramble.moves).toHaveLength(7);
      expect('knownSolution' in scramble).toBe(false);
      for (let index = 1; index < scramble.moves.length; index += 1) {
        expect(scramble.moves[index].face).not.toBe(scramble.moves[index - 1].face);
        if (index >= 2) {
          expect(scramble.moves[index].face).not.toBe(scramble.moves[index - 2].face);
        }
        const opposite: Record<string, string> = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };
        expect(scramble.moves[index].face).not.toBe(opposite[scramble.moves[index - 1].face]);
      }
      const state = CubeState.solved().applySequence(scramble.moves);
      expect(state.isSolved()).toBe(false);
    }
  });

  it('finds a solution for a short depth-3 state', () => {
    const state = CubeState.solved().applySequence(toMoves(['R', 'U', "F'"]));
    const result = solveDepthLimited(state, {
      maxDepth: 3,
      nodeBudget: 200_000,
      timeBudgetMs: 5_000,
    });
    expect(result.reason).toBe('solved');
    expect(result.solution).not.toBeNull();
    expect(state.clone().applySequence(result.solution!).isSolved()).toBe(true);
    expect(result.solution!.length).toBeLessThanOrEqual(3);
  });

  it('exhausts a too-shallow bound without mutating the input', () => {
    const state = CubeState.solved().applySequence(toMoves(['R', 'U', "F'", 'L2']));
    const snapshot = state.clone();
    const result = solveDepthLimited(state, {
      maxDepth: 1,
      nodeBudget: 200_000,
      timeBudgetMs: 5_000,
    });
    expect(result.solution).toBeNull();
    expect(result.reason).toBe('exhausted');
    expect(state.equals(snapshot)).toBe(true);
  });

  it('finds solutions for genuinely random short scrambles by full search', () => {
    for (let seed = 1; seed <= 4; seed += 1) {
      const scramble = generateScramble(4, seededRng(seed * 31));
      const state = CubeState.solved().applySequence(scramble.moves);
      const result = solveDepthLimited(state, {
        maxDepth: 4,
        nodeBudget: 500_000,
        timeBudgetMs: 4_000,
      });
      expect(result.reason).toBe('solved');
      expect(result.solution).not.toBeNull();
      expect(state.clone().applySequence(result.solution!).isSolved()).toBe(true);
    }
  });

  it('honestly stops at its node budget on a deep bound', () => {
    const scramble = generateScramble(7, seededRng(88));
    const state = CubeState.solved().applySequence(scramble.moves);
    const result = solveDepthLimited(state, {
      maxDepth: 100,
      nodeBudget: 2_000,
      timeBudgetMs: 10_000,
    });
    expect(result.solution).toBeNull();
    expect(result.reason).toBe('budget');
    expect(result.nodes).toBeGreaterThanOrEqual(2_000);
  });

  it('uses the inverse/recent-face pruning rules in returned paths', () => {
    const state = CubeState.solved().applySequence(toMoves(['R', 'U', "F'", 'L2']));
    const result = solveDepthLimited(state, {
      maxDepth: 4,
      nodeBudget: 500_000,
      timeBudgetMs: 5_000,
    });
    expect(result.solution).not.toBeNull();
    for (let index = 1; index < result.solution!.length; index += 1) {
      expect(result.solution![index].face).not.toBe(result.solution![index - 1].face);
      if (index >= 2) {
        expect(result.solution![index].face).not.toBe(result.solution![index - 2].face);
      }
    }
  });
});
