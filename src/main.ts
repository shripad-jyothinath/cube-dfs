import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

import {
  CubeState,
  type Move,
  notation,
  toMoves,
} from './cube/CubeState';
import { generateScramble } from './cube/scramble';
import { CubeView, type PlaybackSpeed } from './cube/CubeView';
import { SolverWorkerClient, type AttemptResult } from './solver/workerClient';
import type { SolverProgress } from './solver/dfs';

type AppMode = 'idle' | 'scrambling' | 'searching' | 'executing' | 'solved' | 'failed';

type StatusTone = 'idle' | 'scrambling' | 'searching' | 'executing' | 'solved' | 'failed';

const DEFAULT_SCRAMBLE_LENGTH = 5;
const DEFAULT_MAX_DEPTH = 100;
const MAX_DEPTH = 100;
const NODE_CAP = 15_000_000;

/**
 * Iterative deepening normally visits every bound. Above a small demo ceiling
 * that would produce dozens of futile attempts, so deeper probes are sampled.
 * The bounds still increase monotonically and every attempt is a real DFS.
 */
function buildAttemptSchedule(maxDepth: number): number[] {
  if (maxDepth <= 12) {
    return Array.from({ length: maxDepth }, (_, index) => index + 1);
  }

  const bounds = Array.from({ length: 8 }, (_, index) => index + 1);
  const probeCount = 5;
  for (let probe = 1; probe <= probeCount; probe += 1) {
    const bound = Math.round(8 + ((maxDepth - 8) * probe) / probeCount);
    if (!bounds.includes(bound)) bounds.push(bound);
  }
  if (bounds[bounds.length - 1] !== maxDepth) bounds.push(maxDepth);
  return bounds;
}
function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
}

function formatCount(value: number): string {
  if (value < 10_000) return value.toLocaleString('en-US');
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}m`;
}

function formatTime(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  } catch {
    return fallback;
  }
}

function readStoredSpeed(): PlaybackSpeed {
  try {
    const raw = window.localStorage.getItem('cubedfs.speed');
    if (raw === 'turbo') return 'turbo';
    const numeric = Number(raw);
    if (numeric === 1 || numeric === 2 || numeric === 4) return numeric;
  } catch {
    // local storage can be unavailable in hardened browser contexts
  }
  return 2;
}

class CubeDfsApp {
  private cube = CubeState.solved();
  private readonly view: CubeView;
  private readonly workerClient = new SolverWorkerClient();

  private readonly stage = must<HTMLElement>('#stage');
  private readonly enginePill = must<HTMLElement>('#enginePill');
  private readonly engineLabel = must<HTMLElement>('#engineLabel');
  private readonly statusPill = must<HTMLElement>('#statusPill');
  private readonly statusText = must<HTMLElement>('#statusText');
  private readonly stageStatus = must<HTMLElement>('#stageStatus');
  private readonly turnReadout = must<HTMLElement>('#turnReadout');
  private readonly stageFlash = must<HTMLElement>('#stageFlash');
  private readonly toast = must<HTMLElement>('#toast');

  private readonly scrambleBtn = must<HTMLButtonElement>('#scrambleBtn');
  private readonly solveBtn = must<HTMLButtonElement>('#solveBtn');
  private readonly resetBtn = must<HTMLButtonElement>('#resetBtn');
  private readonly solveLabel = must<HTMLElement>('#solveLabel');
  private readonly solveSub = must<HTMLElement>('#solveSub');
  private readonly scrambleMeta = must<HTMLElement>('#scrambleMeta');
  private readonly scrambleLength = must<HTMLInputElement>('#scrambleLength');
  private readonly maxDepth = must<HTMLInputElement>('#maxDepth');
  private readonly scrambleLengthValue = must<HTMLElement>('#scrambleLengthValue');
  private readonly maxDepthValue = must<HTMLElement>('#maxDepthValue');
  private readonly speedControl = must<HTMLElement>('#speedControl');

  private readonly metricNodes = must<HTMLElement>('#metricNodes');
  private readonly metricDepth = must<HTMLElement>('#metricDepth');
  private readonly metricDepthMax = must<HTMLElement>('#metricDepthMax');
  private readonly metricTime = must<HTMLElement>('#metricTime');
  private readonly metricVisited = must<HTMLElement>('#metricVisited');

  private readonly scrambleChips = must<HTMLElement>('#scrambleChips');
  private readonly solutionChips = must<HTMLElement>('#solutionChips');
  private readonly scrambleCount = must<HTMLElement>('#scrambleCount');
  private readonly solutionCount = must<HTMLElement>('#solutionCount');
  private readonly copyBtn = must<HTMLButtonElement>('#copyBtn');

  private playbackSpeed: PlaybackSpeed = readStoredSpeed();
  private scrambleLengthValueState = readStoredNumber(
    'cubedfs.scrambleLength',
    DEFAULT_SCRAMBLE_LENGTH,
    4,
    7,
  );
  private maxDepthState = readStoredNumber('cubedfs.maxDepth.v2', DEFAULT_MAX_DEPTH, 3, MAX_DEPTH);

  private mode: AppMode = 'idle';
  private busy = false;
  private runToken = 0;
  private toastTimer = 0;

  private baseNodes = 0;
  private baseVisited = 0;
  private baseTimeMs = 0;

  private solutionMoves: Move[] = [];

  constructor() {
    this.view = new CubeView(this.stage);
    this.view.syncToState(this.cube);
    this.applySettingsToInputs();
    this.bindEvents();
    this.resetMetrics();
    this.renderPlaceholder(this.scrambleChips, 'Scramble the cube to populate this trace.');
    this.renderPlaceholder(this.solutionChips, 'DFS output will appear here.');
    this.setStatus('READY', 'idle');
    this.stageStatus.textContent = 'STANDBY';
    this.turnReadout.textContent = '—';
  }

  private bindEvents(): void {
    this.scrambleBtn.addEventListener('click', () => {
      void this.scramble();
    });

    this.solveBtn.addEventListener('click', () => {
      if (this.busy && (this.mode === 'searching' || this.mode === 'executing')) {
        this.abortRun('RUN ABORTED');
        return;
      }
      void this.solve();
    });

    this.resetBtn.addEventListener('click', () => this.reset());

    this.scrambleLength.addEventListener('input', () => {
      this.scrambleLengthValueState = Number(this.scrambleLength.value);
      this.updateRangeVisual(this.scrambleLength);
      this.updateSettingLabels();
      this.persistSettings();
    });

    this.maxDepth.addEventListener('input', () => {
      this.maxDepthState = Number(this.maxDepth.value);
      this.updateRangeVisual(this.maxDepth);
      this.updateSettingLabels();
      this.metricDepthMax.textContent = `/${this.maxDepthState}`;
      this.persistSettings();
    });

    for (const button of Array.from(
      this.speedControl.querySelectorAll<HTMLButtonElement>('button[data-speed]'),
    )) {
      button.addEventListener('click', () => {
        const raw = button.dataset.speed;
        const speed: PlaybackSpeed = raw === 'turbo' ? 'turbo' : (Number(raw) as 1 | 2 | 4);
        this.setSpeed(speed);
      });
    }

    this.copyBtn.addEventListener('click', () => {
      void this.copySolution();
    });

    this.scrambleLength.addEventListener('change', () => this.scrambleLength.blur());
    this.maxDepth.addEventListener('change', () => this.maxDepth.blur());

    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.scramble();
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        this.reset();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (this.busy && (this.mode === 'searching' || this.mode === 'executing')) {
          this.abortRun('RUN ABORTED');
        } else {
          void this.solve();
        }
      }
    });

    window.addEventListener('beforeunload', () => {
      this.workerClient.dispose();
      this.view.dispose();
    });
  }

  private applySettingsToInputs(): void {
    this.scrambleLength.value = String(this.scrambleLengthValueState);
    this.maxDepth.value = String(this.maxDepthState);
    this.updateRangeVisual(this.scrambleLength);
    this.updateRangeVisual(this.maxDepth);
    this.updateSettingLabels();
    this.metricDepthMax.textContent = `/${this.maxDepthState}`;
    this.setSpeedButtonActive();
  }

  private updateSettingLabels(): void {
    this.scrambleLengthValue.textContent = String(this.scrambleLengthValueState);
    this.maxDepthValue.textContent = String(this.maxDepthState);
    this.scrambleMeta.textContent = `${this.scrambleLengthValueState} random moves`;
  }

  private updateRangeVisual(input: HTMLInputElement): void {
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    const percentage = ((value - min) / Math.max(1, max - min)) * 100;
    input.style.setProperty('--pct', `${percentage}%`);
  }

  private persistSettings(): void {
    try {
      window.localStorage.setItem('cubedfs.scrambleLength', String(this.scrambleLengthValueState));
      window.localStorage.setItem('cubedfs.maxDepth.v2', String(this.maxDepthState));
      window.localStorage.setItem('cubedfs.speed', String(this.playbackSpeed));
    } catch {
      // Settings persistence is a nicety, not a requirement.
    }
  }

  private setSpeed(speed: PlaybackSpeed): void {
    this.playbackSpeed = speed;
    this.setSpeedButtonActive();
    this.persistSettings();
  }

  private setSpeedButtonActive(): void {
    for (const button of Array.from(
      this.speedControl.querySelectorAll<HTMLButtonElement>('button[data-speed]'),
    )) {
      const raw = button.dataset.speed;
      const value: PlaybackSpeed | null =
        raw === 'turbo' ? 'turbo' : raw ? (Number(raw) as 1 | 2 | 4) : null;
      const isActive = value === this.playbackSpeed;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    }
  }

  private setStatus(label: string, tone: StatusTone): void {
    this.statusPill.dataset.state = tone;
    this.statusText.textContent = label;
    const working = tone === 'searching' || tone === 'scrambling' || tone === 'executing';
    this.enginePill.dataset.state = working ? 'working' : tone === 'failed' ? 'error' : 'idle';
    this.engineLabel.textContent =
      tone === 'failed'
        ? 'BOUND EXHAUSTED'
        : working
          ? 'ENGINE ACTIVE'
          : 'ENGINE READY';
  }

  private setBusyUI(): void {
    const isBusy = this.mode === 'scrambling' || this.mode === 'searching' || this.mode === 'executing';
    this.busy = isBusy;
    this.scrambleBtn.disabled = isBusy;
    this.scrambleLength.disabled = isBusy;
    this.maxDepth.disabled = isBusy;
    this.solveBtn.disabled = isBusy && this.mode === 'scrambling';
    this.solveBtn.classList.toggle(
      'is-stop',
      isBusy && (this.mode === 'searching' || this.mode === 'executing'),
    );
    this.solveLabel.textContent =
      isBusy && (this.mode === 'searching' || this.mode === 'executing') ? 'Stop' : 'Solve';
    this.solveSub.textContent =
      isBusy && this.mode === 'searching'
        ? 'Abort current search'
        : isBusy && this.mode === 'executing'
          ? 'Abort playback'
          : 'Start DFS search';
  }

  private resetMetrics(): void {
    this.baseNodes = 0;
    this.baseVisited = 0;
    this.baseTimeMs = 0;
    this.metricNodes.textContent = '0';
    this.metricDepth.textContent = '—';
    this.metricTime.textContent = '0.00';
    this.metricVisited.textContent = '0';
    this.metricNodes.title = '0 nodes explored';
    this.metricVisited.title = '0 unique states in the visited set';
    this.metricDepthMax.textContent = `/${this.maxDepthState}`;
  }

  private paintMetrics(
    nodes: number,
    depth: number,
    timeMs: number,
    visited: number,
  ): void {
    this.metricNodes.textContent = formatCount(nodes);
    this.metricNodes.title = `${nodes.toLocaleString('en-US')} nodes explored`;
    this.metricDepth.textContent = depth > 0 ? String(depth) : '—';
    this.metricTime.textContent = formatTime(timeMs);
    this.metricVisited.textContent = formatCount(visited);
    this.metricVisited.title = `${visited.toLocaleString('en-US')} unique states in the visited set`;
  }

  private renderPlaceholder(container: HTMLElement, text: string): void {
    container.replaceChildren();
    const node = document.createElement('span');
    node.className = 'chips-empty';
    node.textContent = text;
    container.appendChild(node);
  }

  private renderChips(container: HTMLElement, moves: readonly Move[]): void {
    container.replaceChildren();
    moves.forEach((move, index) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = move.name;
      chip.style.animationDelay = `${Math.min(index * 18, 160)}ms`;
      container.appendChild(chip);
    });
  }

  private activateChip(container: HTMLElement, index: number): void {
    const chips = Array.from(container.querySelectorAll<HTMLElement>('.chip'));
    chips.forEach((chip, chipIndex) => {
      chip.classList.toggle('is-active', chipIndex === index);
      if (chipIndex < index) chip.classList.add('is-done');
      if (chipIndex > index) chip.classList.remove('is-done');
    });
  }

  private finishChips(container: HTMLElement): void {
    container.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
      chip.classList.remove('is-active');
      chip.classList.add('is-done');
    });
  }

  private showTurn(name: string): void {
    this.turnReadout.textContent = name;
    this.turnReadout.classList.remove('is-turning');
    // Force the text animation to restart for back-to-back quarter turns.
    void this.turnReadout.offsetWidth;
    this.turnReadout.classList.add('is-turning');
  }

  private clearTurn(): void {
    this.turnReadout.textContent = '—';
    this.turnReadout.classList.remove('is-turning');
  }

  private prepareRunBase(): void {
    this.baseNodes = 0;
    this.baseVisited = 0;
    this.baseTimeMs = 0;
    this.solutionMoves = [];
    this.resetMetrics();
    this.renderPlaceholder(this.solutionChips, 'DFS output will appear here.');
    this.solutionCount.textContent = '0 MOVES';
    this.copyBtn.disabled = true;
    this.stage.classList.remove('is-solved', 'is-searching');
    this.stageFlash.classList.remove('is-flashing');
  }

  private async scramble(): Promise<void> {
    if (this.busy) return;

    const token = ++this.runToken;
    this.mode = 'scrambling';
    this.setBusyUI();
    this.setStatus('SCRAMBLING', 'scrambling');
    this.stageStatus.textContent = 'SCRAMBLING';
    this.clearTurn();

    this.cube = CubeState.solved();
    this.view.reset(this.cube);
    this.prepareRunBase();
    this.renderPlaceholder(this.scrambleChips, 'Generating scramble…');
    this.scrambleCount.textContent = 'BUILDING';

    const scramble = generateScramble(this.scrambleLengthValueState);
    this.renderChips(this.scrambleChips, scramble.moves);
    this.scrambleCount.textContent = `${scramble.moves.length} MOVES`;

    await this.wait(90);
    if (token !== this.runToken) return;

    for (let index = 0; index < scramble.moves.length; index += 1) {
      if (token !== this.runToken) return;
      const move = scramble.moves[index];
      this.activateChip(this.scrambleChips, index);
      this.showTurn(move.name);
      this.cube.apply(move);
      await this.view.animateMove(move, { speed: this.playbackSpeed });
      if (token !== this.runToken) return;
      this.view.syncToState(this.cube);
      await this.wait(38);
    }

    if (token !== this.runToken) return;
    this.finishChips(this.scrambleChips);
    this.clearTurn();
    this.mode = 'idle';
    this.setBusyUI();
    this.setStatus('SCRAMBLED', 'idle');
    this.stageStatus.textContent = 'SCRAMBLED';
    this.showToast(`Scrambled with ${scramble.moves.length} moves. Ready to solve.`);
  }

  private async solve(): Promise<void> {
    if (this.busy) return;
    if (this.cube.isSolved()) {
      this.showToast('Cube is already solved. Scramble it first.');
      return;
    }

    const token = ++this.runToken;
    this.prepareRunBase();
    this.mode = 'searching';
    this.setBusyUI();
    this.stage.classList.add('is-searching');
    this.stageStatus.textContent = 'SEARCHING';
    this.setStatus('SEARCHING', 'searching');

    await nextFrame();
    if (token !== this.runToken) return;

    const bounds = buildAttemptSchedule(this.maxDepthState);
    let hitBudget = false;
    let nodesRemaining = NODE_CAP;

    for (const depth of bounds) {
      if (token !== this.runToken) return;
      if (nodesRemaining < 1_000) {
        hitBudget = true;
        break;
      }

      this.metricDepth.textContent = String(depth);
      this.setStatus(`SEARCHING · D${depth}`, 'searching');
      this.stageStatus.textContent = `SEARCH D${depth}`;
      this.turnReadout.textContent = `D${depth}`;

      const attemptBudget = Math.min(this.nodeBudgetForDepth(depth), nodesRemaining);
      let result: AttemptResult;
      try {
        result = await this.workerClient.solve(this.cube, {
          depthLimit: depth,
          nodeBudget: attemptBudget,
          timeBudgetMs: this.timeBudgetForDepth(depth),
          onProgress: (progress) => this.onSolverProgress(progress, depth, token),
        });
      } catch (error) {
        if (token !== this.runToken) return;
        this.handleSolverFailure(error);
        return;
      }

      if (token !== this.runToken) return;

      nodesRemaining = Math.max(0, nodesRemaining - result.nodes);
      this.baseNodes += result.nodes;
      this.baseVisited += result.visited;
      this.baseTimeMs += result.elapsedMs;
      this.paintMetrics(this.baseNodes, depth, this.baseTimeMs, this.baseVisited);

      if (result.solution) {
        this.stage.classList.remove('is-searching');
        await this.playSolution(result.solution, token);
        return;
      }

      if (result.reason === 'budget' || result.reason === 'timeout') hitBudget = true;
    }

    if (token !== this.runToken) return;
    this.mode = 'failed';
    this.setBusyUI();
    this.stage.classList.remove('is-searching');
    this.stageStatus.textContent = hitBudget ? 'BUDGET SPENT' : 'NO ROUTE';
    this.clearTurn();
    this.setStatus(hitBudget ? 'SEARCH CAPPED' : 'NO ROUTE', 'failed');
    this.showToast(
      hitBudget
        ? `DFS used its ${formatCount(NODE_CAP)} node run budget without a route. Try a 4–5 move scramble.`
        : 'Every searched bound was exhausted.',
    );
  }

  private onSolverProgress(progress: SolverProgress, depth: number, token: number): void {
    if (token !== this.runToken) return;
    this.paintMetrics(
      this.baseNodes + progress.nodes,
      depth,
      this.baseTimeMs + progress.elapsedMs,
      this.baseVisited + progress.visited,
    );
  }

  private nodeBudgetForDepth(depth: number): number {
    if (depth <= 4) return 1_000_000;
    if (depth <= 6) return 4_000_000;
    return NODE_CAP;
  }

  private timeBudgetForDepth(depth: number): number {
    if (depth <= 4) return 3_000;
    if (depth <= 6) return 8_000;
    return 30_000;
  }

  private async playSolution(solutionNames: string[], token: number): Promise<void> {
    const moves = toMoves(solutionNames);
    this.solutionMoves = moves;
    this.renderChips(this.solutionChips, moves);
    this.solutionCount.textContent = `${moves.length} MOVES`;
    this.mode = 'executing';
    this.setBusyUI();
    this.stageStatus.textContent = 'APPLYING ROUTE';
    this.setStatus('APPLYING', 'executing');
    this.copyBtn.disabled = false;

    await this.wait(430);
    if (token !== this.runToken) return;

    for (let index = 0; index < moves.length; index += 1) {
      if (token !== this.runToken) return;
      const move = moves[index];
      this.activateChip(this.solutionChips, index);
      this.showTurn(move.name);
      this.stageStatus.textContent = `APPLY ${index + 1}/${moves.length}`;
      this.cube.apply(move);
      await this.view.animateMove(move, { speed: this.playbackSpeed });
      if (token !== this.runToken) return;
      this.view.syncToState(this.cube);
      await this.wait(58);
    }

    if (token !== this.runToken) return;
    this.finishChips(this.solutionChips);
    this.clearTurn();

    if (!this.cube.isSolved()) {
      this.mode = 'failed';
      this.setBusyUI();
      this.setStatus('STATE ERROR', 'failed');
      this.stageStatus.textContent = 'STATE ERROR';
      this.showToast('The solution did not restore the cube. Reset and retry.');
      return;
    }

    this.mode = 'solved';
    this.setBusyUI();
    this.stage.classList.add('is-solved');
    this.stageStatus.textContent = 'SOLVED';
    this.setStatus('SOLVED', 'solved');
    this.triggerSuccessFlash();

    if (this.playbackSpeed !== 'turbo') {
      await this.view.pulse();
    }
    if (token !== this.runToken) return;

    this.showToast(
      `Solved in ${moves.length} moves · ${formatCount(this.baseNodes)} nodes explored.`,
    );
  }

  private triggerSuccessFlash(): void {
    this.stageFlash.classList.remove('is-flashing');
    void this.stageFlash.offsetWidth;
    this.stageFlash.classList.add('is-flashing');
  }

  private handleSolverFailure(error: unknown): void {
    this.mode = 'failed';
    this.setBusyUI();
    this.stage.classList.remove('is-searching');
    this.stageStatus.textContent = 'ENGINE ERROR';
    this.clearTurn();
    this.setStatus('ENGINE ERROR', 'failed');
    const message = error instanceof Error ? error.message : 'Unknown search error';
    this.showToast(`Search failed: ${message}`);
    console.error(error);
  }

  private abortRun(message: string): void {
    if (!this.busy) return;
    this.runToken += 1;
    this.workerClient.cancel();
    this.view.cancelAnimations();
    this.mode = 'idle';
    this.busy = false;
    this.setBusyUI();
    this.stage.classList.remove('is-searching');
    this.stageStatus.textContent = 'PAUSED';
    this.clearTurn();
    this.view.reset(this.cube);
    this.finishChips(this.scrambleChips);
    this.solutionChips.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
      chip.classList.remove('is-active');
    });
    this.setStatus('READY', 'idle');
    this.showToast(message);
  }

  private reset(): void {
    this.runToken += 1;
    this.workerClient.cancel();
    this.view.cancelAnimations();

    this.cube = CubeState.solved();
    this.view.reset(this.cube);
    this.mode = 'idle';
    this.busy = false;
    this.solutionMoves = [];
    this.prepareRunBase();
    this.renderPlaceholder(this.scrambleChips, 'Scramble the cube to populate this trace.');
    this.scrambleCount.textContent = 'EMPTY';
    this.stageStatus.textContent = 'STANDBY';
    this.clearTurn();
    this.setStatus('READY', 'idle');
    this.setBusyUI();
    this.showToast('Cube restored to solved state.');
  }

  private async copySolution(): Promise<void> {
    if (this.solutionMoves.length === 0) return;
    const text = notation(this.solutionMoves).join(' ');
    try {
      await navigator.clipboard.writeText(text);
      this.showToast('Solution copied to clipboard.');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      this.showToast(copied ? 'Solution copied to clipboard.' : 'Unable to copy solution.');
    }
  }

  private showToast(message: string): void {
    window.clearTimeout(this.toastTimer);
    this.toast.textContent = message;
    this.toast.classList.add('is-visible');
    this.toastTimer = window.setTimeout(() => {
      this.toast.classList.remove('is-visible');
    }, 3200);
  }

  private wait(ms: number): Promise<void> {
    const speed = this.playbackSpeed;
    if (speed === 'turbo' || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => window.setTimeout(resolve, ms / speed));
  }
}

new CubeDfsApp();
