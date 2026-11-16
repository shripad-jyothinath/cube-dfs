import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CubeState,
  FACE_INFO,
  FACES,
  type Face,
  type Move,
  type Vec3,
} from './CubeState';

export type PlaybackSpeed = 1 | 2 | 4 | 'turbo';

export interface AnimateOptions {
  speed?: PlaybackSpeed;
  onMoveStart?: (move: Move) => void;
}

const CUBIE_SPACING = 1.022;
const BODY_SIZE = 0.952;
const STICKER_SIZE = 0.788;

const FACE_AXIS: Record<Face, 'x' | 'y' | 'z'> = {
  U: 'y',
  D: 'y',
  R: 'x',
  L: 'x',
  F: 'z',
  B: 'z',
};

const AXIS_VECTOR = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

interface Cubie extends THREE.Group {
  userData: {
    stickers: THREE.Mesh[];
    spawn: THREE.Vector3;
  };
}

class Ease {
  static inOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  static outBack(t: number): number {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
}

export class CubeView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly container: HTMLElement;
  private readonly cubeGroup = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly cubies: Cubie[] = [];
  private readonly stickerMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly clock = new THREE.Clock();
  private readonly dust: THREE.Points;
  private readonly rings: THREE.Group;
  private readonly resizeObserver: ResizeObserver;
  private frameId = 0;
  private activeAnimationToken = 0;
  private disposed = false;
  private introProgress = 0;
  private needsRender = true;
  private environmentTexture: THREE.Texture | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
    this.camera.position.set(5.1, 4.15, 6.65);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.preferredPixelRatio(this.container.clientWidth));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.86;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'cube-canvas';
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D Rubik cube');
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.rotateSpeed = 0.62;
    this.controls.zoomSpeed = 0.72;
    this.controls.panSpeed = 0.55;
    this.controls.minDistance = 4.8;
    this.controls.maxDistance = 13.5;
    this.controls.autoRotate = false;
    this.controls.enablePan = true;
    this.controls.update();
    this.controls.addEventListener('change', () => {
      this.needsRender = true;
    });

    this.scene.add(this.cubeGroup);
    this.cubeGroup.add(this.pivot);

    this.setupLighting();
    this.buildStickerMaterials();
    this.buildCubies();

    this.dust = this.createDust();
    this.scene.add(this.dust);

    this.rings = this.createRings();
    this.scene.add(this.rings);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.animateLoop();
  }

  private setupLighting(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const environment = new RoomEnvironment();
    this.environmentTexture = pmrem.fromScene(environment, 0.04).texture;
    this.scene.environment = this.environmentTexture;
    this.scene.environmentIntensity = 0.38;
    environment.dispose();
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(0xf1f5f2, 0x080b0d, 0.62);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff5e6, 2.1);
    key.position.set(5, 8, 6);
    this.scene.add(key);

    const cool = new THREE.DirectionalLight(0x8adfff, 0.42);
    cool.position.set(-7, 2, 4);
    this.scene.add(cool);

    const rim = new THREE.DirectionalLight(0xd8ff9a, 0.32);
    rim.position.set(1, 4, -8);
    this.scene.add(rim);

    const bottom = new THREE.PointLight(0x3d76ff, 0.85, 10, 1.7);
    bottom.position.set(-1.5, -4, 1);
    this.scene.add(bottom);
  }

  private buildStickerMaterials(): void {
    FACES.forEach((face) => {
      const color = new THREE.Color(FACE_INFO[face].color);
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.23,
        metalness: 0.04,
        envMapIntensity: 0.52,
        emissive: color,
        emissiveIntensity: 0.018,
      });
      this.stickerMaterials.push(material);
    });
  }

  private buildCubies(): void {
    const bodyGeometry = new RoundedBoxGeometry(BODY_SIZE, BODY_SIZE, BODY_SIZE, 7, 0.105);
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x050607,
      roughness: 0.4,
      metalness: 0.32,
      envMapIntensity: 0.5,
    });

    const stickerGeometry = createStickerGeometry();
    const stickerNormal = new THREE.Vector3(0, 0, 1);

    for (let x = -1; x <= 1; x += 1) {
      for (let y = -1; y <= 1; y += 1) {
        for (let z = -1; z <= 1; z += 1) {
          if (x === 0 && y === 0 && z === 0) continue;

          const cubie = new THREE.Group() as Cubie;
          cubie.userData = {
            stickers: [],
            spawn: new THREE.Vector3(x, y, z).multiplyScalar(CUBIE_SPACING),
          };
          cubie.position.copy(cubie.userData.spawn);

          const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
          cubie.add(body);

          const faces: Face[] = [];
          if (y === 1) faces.push('U');
          if (y === -1) faces.push('D');
          if (x === 1) faces.push('R');
          if (x === -1) faces.push('L');
          if (z === 1) faces.push('F');
          if (z === -1) faces.push('B');

          faces.forEach((face) => {
            const normal = vectorFromVec3(FACE_INFO[face].normal);
            const sticker = new THREE.Mesh(
              stickerGeometry,
              this.stickerMaterials[FACES.indexOf(face)],
            );
            sticker.position.copy(normal).multiplyScalar(BODY_SIZE / 2 + 0.008);
            sticker.quaternion.setFromUnitVectors(stickerNormal, normal);
            sticker.userData.face = face;
            sticker.renderOrder = 1;
            cubie.add(sticker);
            cubie.userData.stickers.push(sticker);
          });

          this.cubeGroup.add(cubie);
          this.cubies.push(cubie);
        }
      }
    }
  }

  private createDust(): THREE.Points {
    const count = 150;
    const positions = new Float32Array(count * 3);
    let seed = 23;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    for (let index = 0; index < count; index += 1) {
      const radius = 4.6 + rand() * 5.2;
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(rand() * 2 - 1);
      positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[index * 3 + 1] = radius * Math.cos(phi) * 0.72;
      positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xdbeaff,
      size: 0.022,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
    });
    return new THREE.Points(geometry, material);
  }

  private createRings(): THREE.Group {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({
      color: 0xa8ffd9,
      transparent: true,
      opacity: 0.11,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const ringA = new THREE.Mesh(new THREE.TorusGeometry(3.75, 0.006, 4, 220), material);
    ringA.rotation.x = Math.PI / 2;
    ringA.rotation.z = 0.18;
    group.add(ringA);

    const ringB = new THREE.Mesh(new THREE.TorusGeometry(4.25, 0.004, 4, 220), material);
    ringB.rotation.y = Math.PI / 2.8;
    ringB.rotation.x = 0.52;
    group.add(ringB);

    return group;
  }

  private animateLoop = (): void => {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.animateLoop);
    const delta = Math.min(this.clock.getDelta(), 0.05);

    if (this.introProgress < 1) {
      this.introProgress = Math.min(1, this.introProgress + delta * 1.8);
      const t = Ease.outBack(this.introProgress);
      this.cubeGroup.scale.setScalar(0.72 + t * 0.28);
      this.cubeGroup.rotation.y = (1 - this.introProgress) * -0.42;
      this.needsRender = true;
    }

    if (this.controls.update(delta)) this.needsRender = true;

    if (this.needsRender) {
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
    }
  };

  private preferredPixelRatio(width: number): number {
    const dpr = window.devicePixelRatio || 1;
    const cap = width < 900 ? 1 : width < 1300 ? 1.25 : 1.5;
    return Math.min(dpr, cap);
  }

  resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(this.preferredPixelRatio(width));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;

    const narrow = width < 620;
    this.camera.fov = narrow ? 38 : 34;
    this.camera.position.setLength(narrow ? 9.9 : 9.5);
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  reset(state: CubeState): void {
    this.cancelAnimations();
    for (const cubie of this.cubies) {
      cubie.position.copy(cubie.userData.spawn);
      cubie.quaternion.identity();
      this.cubeGroup.attach(cubie);
    }
    this.cubeGroup.add(this.pivot);
    this.pivot.quaternion.identity();
    this.cubeGroup.rotation.set(0, 0, 0);
    this.cubeGroup.scale.setScalar(1);
    this.introProgress = 1;
    this.syncToState(state);
    this.needsRender = true;
  }

  /** Snap all 54 visible stickers to the colors in the logical state. */
  syncToState(state: CubeState): void {
    const normal = new THREE.Vector3();
    const worldNormal = new THREE.Vector3();

    for (const cubie of this.cubies) {
      const gridX = Math.round(cubie.position.x / CUBIE_SPACING);
      const gridY = Math.round(cubie.position.y / CUBIE_SPACING);
      const gridZ = Math.round(cubie.position.z / CUBIE_SPACING);

      for (const sticker of cubie.userData.stickers) {
        normal.set(0, 0, 1).applyQuaternion(sticker.quaternion);
        worldNormal.copy(normal).applyQuaternion(cubie.quaternion).round();
        const face = faceFromNormalVector(worldNormal);
        if (!face) continue;

        const index = faceletIndexForGrid(face, gridX, gridY, gridZ);
        if (index === null) continue;
        const colorIndex = state.stickers[FACES.indexOf(face) * 9 + index];
        sticker.material = this.stickerMaterials[colorIndex];
      }
    }
    this.needsRender = true;
  }

  async animateMove(move: Move, options: AnimateOptions = {}): Promise<void> {
    const speed = options.speed ?? 1;
    options.onMoveStart?.(move);
    if (speed === 'turbo') {
      this.applyInstantMove(move);
      return;
    }

    const token = ++this.activeAnimationToken;
    const axis = FACE_AXIS[move.face];
    const axisVector = AXIS_VECTOR[axis];
    const amount = move.amount;
    const signedQuarterAngle = amount === 1 ? -Math.PI / 2 : amount === 3 ? Math.PI / 2 : Math.PI;
    const duration = (amount === 2 ? 540 : 390) / speed;

    const selected = this.getLayerCubies(move.face);
    selected.forEach((cubie) => this.pivot.attach(cubie));
    this.pivot.quaternion.identity();

    await new Promise<void>((resolve) => {
      const started = performance.now();
      const tick = (now: number) => {
        if (token !== this.activeAnimationToken || this.disposed) {
          resolve();
          return;
        }
        const progress = Math.min(1, (now - started) / duration);
        const eased = Ease.inOutCubic(progress);
        this.pivot.quaternion.setFromAxisAngle(axisVector, signedQuarterAngle * eased);
        this.needsRender = true;
        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });

    if (token !== this.activeAnimationToken) return;

    for (const cubie of selected) {
      this.cubeGroup.attach(cubie);
      snapCubie(cubie);
    }
    this.pivot.quaternion.identity();
    this.pivot.position.set(0, 0, 0);
    this.needsRender = true;
  }

  applyInstantMove(move: Move): void {
    this.cancelAnimations();
    const axis = AXIS_VECTOR[FACE_AXIS[move.face]];
    const angle =
      move.amount === 1 ? -Math.PI / 2 : move.amount === 3 ? Math.PI / 2 : Math.PI;
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, angle);

    for (const cubie of this.getLayerCubies(move.face)) {
      cubie.position.applyQuaternion(rotation);
      cubie.quaternion.premultiply(rotation);
      snapCubie(cubie);
    }
    this.needsRender = true;
  }

  cancelAnimations(): void {
    this.activeAnimationToken += 1;
    for (const cubie of this.cubies) {
      if (cubie.parent === this.pivot) this.cubeGroup.attach(cubie);
      snapCubie(cubie);
    }
    this.pivot.quaternion.identity();
    this.pivot.position.set(0, 0, 0);
    this.needsRender = true;
  }

  private getLayerCubies(face: Face): Cubie[] {
    const axis = FACE_AXIS[face];
    const normal = vectorFromVec3(FACE_INFO[face].normal);
    const layerValue = normal[axis] > 0 ? 1 : -1;
    return this.cubies.filter((cubie) => {
      const value = Math.round(cubie.position[axis] / CUBIE_SPACING);
      return value === layerValue;
    });
  }

  /** A tiny victory bounce, played after the final solution move. */
  async pulse(): Promise<void> {
    const duration = 760;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const lift = Math.sin(t * Math.PI) * 0.06;
        this.scene.environmentIntensity = 0.38 + Math.sin(t * Math.PI) * 0.5;
        this.cubeGroup.position.y = lift;
        this.cubeGroup.rotation.y = Math.sin(t * Math.PI) * 0.075;
        this.needsRender = true;
        if (t < 1) requestAnimationFrame(tick);
        else {
          this.cubeGroup.position.y = 0;
          this.cubeGroup.rotation.y = 0;
          this.scene.environmentIntensity = 0.38;
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.controls.dispose();

    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => material.dispose());
      }
    });
    this.environmentTexture?.dispose();
    this.environmentTexture = null;

    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.container.removeChild(this.renderer.domElement);
  }
}

function createStickerGeometry(): THREE.ExtrudeGeometry {
  const width = STICKER_SIZE;
  const radius = 0.12;
  const half = width / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-half + radius, -half);
  shape.lineTo(half - radius, -half);
  shape.quadraticCurveTo(half, -half, half, -half + radius);
  shape.lineTo(half, half - radius);
  shape.quadraticCurveTo(half, half, half - radius, half);
  shape.lineTo(-half + radius, half);
  shape.quadraticCurveTo(-half, half, -half, half - radius);
  shape.lineTo(-half, -half + radius);
  shape.quadraticCurveTo(-half, -half, -half + radius, -half);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.014,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.008,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geometry.translate(0, 0, -0.007);
  geometry.computeVertexNormals();
  return geometry;
}

function vectorFromVec3(vector: Vec3): THREE.Vector3 {
  return new THREE.Vector3(vector[0], vector[1], vector[2]);
}

function faceFromNormalVector(normal: THREE.Vector3): Face | null {
  const nx = Math.round(normal.x);
  const ny = Math.round(normal.y);
  const nz = Math.round(normal.z);
  if (nx === 1 && ny === 0 && nz === 0) return 'R';
  if (nx === -1 && ny === 0 && nz === 0) return 'L';
  if (nx === 0 && ny === 1 && nz === 0) return 'U';
  if (nx === 0 && ny === -1 && nz === 0) return 'D';
  if (nx === 0 && ny === 0 && nz === 1) return 'F';
  if (nx === 0 && ny === 0 && nz === -1) return 'B';
  return null;
}

function faceletIndexForGrid(
  face: Face,
  gridX: number,
  gridY: number,
  gridZ: number,
): number | null {
  const info = FACE_INFO[face];
  const position: [number, number, number] = [gridX, gridY, gridZ];
  const row = 1 - dotVec(position, info.up);
  const col = 1 + dotVec(position, info.right);
  if (row < 0 || row > 2 || col < 0 || col > 2) return null;
  return row * 3 + col;
}

function dotVec(a: [number, number, number], b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function snapCubie(cubie: THREE.Group): void {
  cubie.position.set(
    Math.round(cubie.position.x / CUBIE_SPACING) * CUBIE_SPACING,
    Math.round(cubie.position.y / CUBIE_SPACING) * CUBIE_SPACING,
    Math.round(cubie.position.z / CUBIE_SPACING) * CUBIE_SPACING,
  );

  const matrix = new THREE.Matrix4().makeRotationFromQuaternion(cubie.quaternion);
  const elements = matrix.elements;
  for (let index = 0; index < elements.length; index += 1) {
    if (index === 3 || index === 7 || index === 11 || index === 12 || index === 13 || index === 14) {
      continue;
    }
    elements[index] = Math.round(elements[index]);
  }
  cubie.quaternion.setFromRotationMatrix(matrix);
  cubie.quaternion.normalize();
}
