/**
 * Logical 3x3x3 Rubik's Cube.
 *
 * The cube is stored as 6 faces x 9 stickers in a flat Uint8Array.
 * Facelet order is U, R, F, D, L, B; each face is row-major when viewed
 * from outside the cube.
 *
 * Every move permutation is generated from the actual sticker geometry, so
 * the logical model and the Three.js model share exactly the same convention.
 */

export const FACES = ['U', 'R', 'F', 'D', 'L', 'B'] as const;
export type Face = (typeof FACES)[number];

export type Vec3 = readonly [number, number, number];

export interface FaceInfo {
  readonly normal: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly color: string;
  readonly label: string;
}

/** Right = cross(up, normal) for every face. */
export const FACE_INFO: Record<Face, FaceInfo> = {
  U: {
    normal: [0, 1, 0],
    right: [1, 0, 0],
    up: [0, 0, -1],
    color: '#eae5d8',
    label: 'White',
  },
  R: {
    normal: [1, 0, 0],
    right: [0, 0, -1],
    up: [0, 1, 0],
    color: '#ed123c',
    label: 'Red',
  },
  F: {
    normal: [0, 0, 1],
    right: [1, 0, 0],
    up: [0, 1, 0],
    color: '#00b867',
    label: 'Green',
  },
  D: {
    normal: [0, -1, 0],
    right: [1, 0, 0],
    up: [0, 0, 1],
    color: '#f2b300',
    label: 'Yellow',
  },
  L: {
    normal: [-1, 0, 0],
    right: [0, 0, 1],
    up: [0, 1, 0],
    color: '#f06500',
    label: 'Orange',
  },
  B: {
    normal: [0, 0, -1],
    right: [-1, 0, 0],
    up: [0, 1, 0],
    color: '#0a57eb',
    label: 'Blue',
  },
};

const FACE_INDEX = Object.fromEntries(FACES.map((face, index) => [face, index])) as Record<
  Face,
  number
>;

export type MoveAmount = 1 | 2 | 3;

export interface Move {
  readonly face: Face;
  readonly amount: MoveAmount;
  readonly name: string;
}

function moveName(face: Face, amount: MoveAmount): string {
  return amount === 1 ? face : amount === 2 ? `${face}2` : `${face}'`;
}

function makeMove(face: Face, amount: MoveAmount): Move {
  return Object.freeze({ face, amount, name: moveName(face, amount) });
}

/** The 18 standard moves, in the classic presentation order. */
export const MOVES: readonly Move[] = Object.freeze(
  FACES.flatMap((face) => [
    makeMove(face, 1),
    makeMove(face, 3),
    makeMove(face, 2),
  ]),
);

export const MOVE_BY_NAME: ReadonlyMap<string, Move> = new Map(
  MOVES.map((move) => [move.name, move]),
);

export function parseMove(name: string): Move {
  const move = MOVE_BY_NAME.get(name);
  if (!move) throw new Error(`Unknown Rubik's move: ${name}`);
  return move;
}

export function inverseMove(move: Move): Move {
  return inverseFor(move.face, move.amount);
}

function inverseFor(face: Face, amount: MoveAmount): Move {
  const inverseAmount = (amount === 2 ? 2 : 4 - amount) as MoveAmount;
  return MOVE_BY_NAME.get(moveName(face, inverseAmount))!;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                     */
/* ------------------------------------------------------------------ */

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];

/** Rotate a vector by one clockwise quarter turn around the outward face normal. */
function clockwise(v: Vec3, face: Face): Vec3 {
  const [x, y, z] = v;
  switch (face) {
    case 'U':
      return [-z, y, x];
    case 'D':
      return [z, y, -x];
    case 'R':
      return [x, z, -y];
    case 'L':
      return [x, -z, y];
    case 'F':
      return [y, -x, z];
    case 'B':
      return [-y, x, z];
  }
}

const add3 = add;
const mul3 = scale;

export function faceFromNormal(normal: Vec3): Face {
  for (const face of FACES) {
    const candidate = FACE_INFO[face].normal;
    if (candidate[0] === normal[0] && candidate[1] === normal[1] && candidate[2] === normal[2]) {
      return face;
    }
  }
  throw new Error(`Not a face normal: ${normal.join(',')}`);
}

export function faceletPosition(face: Face, index: number): Vec3 {
  const info = FACE_INFO[face];
  const row = Math.floor(index / 3);
  const col = index % 3;
  return add3(
    info.normal,
    add3(mul3(info.right, col - 1), mul3(info.up, 1 - row)),
  );
}

export function faceletIndexFromPosition(face: Face, position: Vec3): number {
  const info = FACE_INFO[face];
  if (dot(position, info.normal) !== 1) {
    throw new Error(`Position is not on face ${face}`);
  }
  const row = 1 - dot(position, info.up);
  const col = 1 + dot(position, info.right);
  if (row < 0 || row > 2 || col < 0 || col > 2) {
    throw new Error(`Invalid facelet position on ${face}`);
  }
  return row * 3 + col;
}

export interface MovePermutation {
  /** old index -> new index */
  readonly map: Uint8Array;
  /** non-trivial cycles used by the in-place solver */
  readonly cycles: readonly (readonly number[])[];
}

function toPermutation(map: Uint8Array): MovePermutation {
  const seen = new Uint8Array(map.length);
  const cycles: number[][] = [];
  for (let start = 0; start < map.length; start += 1) {
    if (seen[start]) continue;
    const cycle: number[] = [];
    let index = start;
    while (!seen[index]) {
      seen[index] = 1;
      cycle.push(index);
      index = map[index];
    }
    if (cycle.length > 1) cycles.push(cycle);
  }
  return { map, cycles };
}

function buildPermutation(face: Face, turns: 1 | 2 | 3): MovePermutation {
  const info = FACE_INFO[face];
  const map = new Uint8Array(54);
  for (let index = 0; index < 54; index += 1) map[index] = index;

  for (let sourceFaceIndex = 0; sourceFaceIndex < FACES.length; sourceFaceIndex += 1) {
    const stickerFace = FACES[sourceFaceIndex];
    const stickerNormal = FACE_INFO[stickerFace].normal;
    for (let facelet = 0; facelet < 9; facelet += 1) {
      const position = faceletPosition(stickerFace, facelet);
      if (dot(position, info.normal) !== 1) continue;

      let nextPosition = position;
      let nextNormal = stickerNormal;
      for (let turn = 0; turn < turns; turn += 1) {
        nextPosition = clockwise(nextPosition, face);
        nextNormal = clockwise(nextNormal, face);
      }

      const nextFace = faceFromNormal(nextNormal);
      const nextFacelet = faceletIndexFromPosition(nextFace, nextPosition);
      map[sourceFaceIndex * 9 + facelet] = FACE_INDEX[nextFace] * 9 + nextFacelet;
    }
  }

  return toPermutation(map);
}

const permutationCache = new Map<string, MovePermutation>();

export function getMovePermutation(move: Move): MovePermutation {
  const key = `${move.face}${move.amount}`;
  let permutation = permutationCache.get(key);
  if (!permutation) {
    permutation = buildPermutation(move.face, move.amount);
    permutationCache.set(key, permutation);
  }
  return permutation;
}

/* ------------------------------------------------------------------ */
/* The logical cube                                                     */
/* ------------------------------------------------------------------ */

export class CubeState {
  readonly stickers: Uint8Array;

  constructor(stickers?: Uint8Array | ArrayLike<number>) {
    if (stickers) {
      this.stickers = Uint8Array.from(stickers);
    } else {
      this.stickers = new Uint8Array(54);
      for (let index = 0; index < 54; index += 1) {
        this.stickers[index] = Math.floor(index / 9);
      }
    }
  }

  static solved(): CubeState {
    return new CubeState();
  }

  clone(): CubeState {
    return new CubeState(this.stickers);
  }

  apply(move: Move): this {
    const { map } = getMovePermutation(move);
    const next = new Uint8Array(54);
    for (let source = 0; source < 54; source += 1) next[map[source]] = this.stickers[source];
    this.stickers.set(next);
    return this;
  }

  applySequence(moves: readonly Move[]): this {
    for (const move of moves) this.apply(move);
    return this;
  }

  isSolved(): boolean {
    for (let index = 0; index < 54; index += 1) {
      if (this.stickers[index] !== Math.floor(index / 9)) return false;
    }
    return true;
  }

  /** Compact, exact 27-character key (two stickers per base64 character). */
  key(): string {
    let key = '';
    for (let index = 0; index < 54; index += 2) {
      key += KEY_ALPHABET[this.stickers[index] | (this.stickers[index + 1] << 3)];
    }
    return key;
  }

  colorAt(face: Face, row: number, col: number): string {
    const index = FACE_INDEX[face] * 9 + row * 3 + col;
    return FACE_INFO[FACES[this.stickers[index]]].color;
  }

  faceColors(face: Face): string[] {
    const base = FACE_INDEX[face] * 9;
    return Array.from(
      { length: 9 },
      (_, index) => FACE_INFO[FACES[this.stickers[base + index]]].color,
    );
  }

  toString(): string {
    return FACES.map((face) => {
      const start = FACE_INDEX[face] * 9;
      return `${face}:${Array.from(this.stickers.slice(start, start + 9)).join('')}`;
    }).join(' ');
  }

  equals(other: CubeState): boolean {
    for (let index = 0; index < 54; index += 1) {
      if (this.stickers[index] !== other.stickers[index]) return false;
    }
    return true;
  }
}

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function notation(moves: readonly Move[]): string[] {
  return moves.map((move) => move.name);
}

export function toMoves(names: readonly string[]): Move[] {
  return names.map(parseMove);
}
