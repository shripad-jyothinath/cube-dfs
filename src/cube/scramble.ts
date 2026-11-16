import {
  FACES,
  MOVES,
  type Face,
  type Move,
  type MoveAmount,
} from './CubeState';

export interface ScrambleResult {
  /** The full sequence shown and applied to the cube. */
  readonly moves: Move[];
}

type Rng = () => number;

function randomInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function randomAmount(rng: Rng): MoveAmount {
  return (randomInt(rng, 3) + 1) as MoveAmount;
}

/**
 * A genuine random scramble. Consecutive turns on the same face are avoided
 * (they would trivially collapse), but no cancellation padding or precomputed
 * solution is inserted. Deep scrambles are expected to defeat the bounded DFS.
 */
export function generateScramble(targetMoves = 10, rng: Rng = Math.random): ScrambleResult {
  const count = Math.max(4, Math.min(7, Math.round(targetMoves)));
  const moves: Move[] = [];
  const recentFaces: Face[] = [];

  for (let index = 0; index < count; index += 1) {
    // Match the solver's pruning contract so the inverse scramble path is
    // always a legal route through the search tree.
    const excluded = new Set(recentFaces.slice(-2));
    const previous = recentFaces[recentFaces.length - 1];
    if (previous) excluded.add(oppositeFace(previous));
    const candidates = FACES.filter((face) => !excluded.has(face));
    const face = candidates[randomInt(rng, candidates.length)];
    const amount = randomAmount(rng);
    const move = MOVES.find(
      (candidate) => candidate.face === face && candidate.amount === amount,
    );
    if (!move) throw new Error(`Could not build scramble move ${face}${amount}`);
    moves.push(move);
    recentFaces.push(face);
  }

  return { moves };
}

function oppositeFace(face: Face): Face {
  switch (face) {
    case 'U': return 'D';
    case 'D': return 'U';
    case 'R': return 'L';
    case 'L': return 'R';
    case 'F': return 'B';
    case 'B': return 'F';
  }
}
