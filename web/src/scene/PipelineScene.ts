import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STAGE_BY_ID, STAGE_DEFINITIONS } from '../data/stages';
import type {
  CameraPreset,
  PipelineEvent,
  PipelineRun,
  StageId,
  ThemeMode
} from '../types/pipeline';
import { createConduits, setConduitsTheme, type Conduit, type ConduitKey } from './conduits';
import { createRadialGlowTexture, getTierColorHex, SCENE_THEMES } from './materials';
import { createOfficeEnvironment, type OfficeEnvironment } from './officeEnvironment';
import { PacketSystem } from './packets';
import { createStations, type StationRig } from './stations';

export interface ProjectedLabel {
  id: StageId;
  x: number;
  y: number;
  visible: boolean;
}

interface SceneCallbacks {
  onSelectStage: (stageId: StageId) => void;
  onHoverStage: (stageId: StageId | null) => void;
  onProjectLabels: (labels: ProjectedLabel[]) => void;
  onUserCameraOrbit: () => void;
}

const CAMERA_PRESETS: Record<CameraPreset, { pos: [number, number, number]; target: [number, number, number] }> = {
  overview: { pos: [0.0, 14.5, 19.2], target: [0.0, 0.25, -0.2] },
  core: { pos: [0.0, 6.2, 11.4], target: [0.0, 0.75, 3.0] },
  follow: { pos: [0.0, 14.5, 19.2], target: [0.0, 0.25, -0.2] }
};

export class PipelineScene {
  private container: HTMLElement;
  private callbacks: SceneCallbacks;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private worldGroup: THREE.Group;
  private glowTexture: THREE.CanvasTexture;
  private office: OfficeEnvironment;
  private stations: Map<StageId, StationRig>;
  private conduits: Map<ConduitKey, Conduit>;
  private packets: PacketSystem;

  private ambientLight: THREE.AmbientLight;
  private hemiLight: THREE.HemisphereLight;
  private keyLight: THREE.DirectionalLight;
  private rimLight: THREE.DirectionalLight;

  private theme: ThemeMode = 'dark';
  private paused = false;
  private reducedMotion = false;
  private cameraPreset: CameraPreset = 'follow';
  private desiredCamPos = new THREE.Vector3(...CAMERA_PRESETS.overview.pos);
  private desiredTarget = new THREE.Vector3(...CAMERA_PRESETS.overview.target);
  private cameraTweening = true;
  private isIdleOverview = true;
  private isRunActive = false;
  private followStageId: StageId = 'ingress';
  private lastStageVisited: StageId = 'ingress';

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(-99, -99);
  private pointerMoved = false;
  private isDragging = false;
  private downPos = { x: 0, y: 0 };

  private rafId: number | null = null;
  private clock = new THREE.Clock();
  private elapsed = 0;
  private disposed = false;

  private tmpVec = new THREE.Vector3();

  constructor(container: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    const palette = SCENE_THEMES.dark;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(palette.background);
    this.scene.fog = new THREE.FogExp2(palette.background, 0.0085);

    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 240);

    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 240);
    const initialPose = this.getOverviewPose();
    this.camera.position.set(...initialPose.pos);
    this.desiredCamPos.set(...initialPose.pos);
    this.desiredTarget.set(...initialPose.target);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 5.5;
    this.controls.maxDistance = 52;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minPolarAngle = 0.18;
    this.controls.target.set(...initialPose.target);

    this.controls.addEventListener('start', () => {
      this.cameraTweening = false;
      this.isIdleOverview = false;
      this.callbacks.onUserCameraOrbit();
    });

    this.ambientLight = new THREE.AmbientLight(0xdce6f2, palette.ambientIntensity);
    this.hemiLight = new THREE.HemisphereLight(0xeef5fc, 0x16291e, palette.hemiIntensity);
    this.keyLight = new THREE.DirectionalLight(0xfff5e4, palette.keyIntensity);
    this.keyLight.position.set(10, 18, 12);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.near = 2;
    this.keyLight.shadow.camera.far = 64;
    this.keyLight.shadow.camera.left = -22;
    this.keyLight.shadow.camera.right = 22;
    this.keyLight.shadow.camera.top = 18;
    this.keyLight.shadow.camera.bottom = -18;
    this.keyLight.shadow.bias = -0.0005;

    this.rimLight = new THREE.DirectionalLight(0x9bd1ff, palette.rimIntensity);
    this.rimLight.position.set(-14, 10, -11);
    this.scene.add(this.ambientLight, this.hemiLight, this.keyLight, this.rimLight);

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    this.glowTexture = createRadialGlowTexture();
    this.office = createOfficeEnvironment(this.worldGroup, 'dark', palette);
    this.stations = createStations(this.worldGroup, this.glowTexture, 'dark', palette);
    this.conduits = createConduits(this.worldGroup, palette);
    this.packets = new PacketSystem(this.worldGroup, this.glowTexture, this.conduits, this.stations);

    this.bindEvents();
    this.startLoop();
  }

  private bindEvents() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointermove', this.handlePointerMove);
    dom.addEventListener('pointerdown', this.handlePointerDown);
    dom.addEventListener('pointerup', this.handlePointerUp);
    dom.addEventListener('pointerleave', this.handlePointerLeave);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private handleVisibilityChange = () => {
    if (document.hidden) {
      this.stopLoop();
    } else if (!this.paused && !this.disposed) {
      this.clock.getDelta();
      this.startLoop();
    }
  };

  private updatePointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerMoved = true;
  }

  private handlePointerMove = (e: PointerEvent) => {
    this.updatePointer(e);
    if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 5) {
      this.isDragging = true;
    }
  };

  private handlePointerDown = (e: PointerEvent) => {
    this.isDragging = false;
    this.downPos = { x: e.clientX, y: e.clientY };
    this.updatePointer(e);
  };

  private handlePointerUp = (e: PointerEvent) => {
    if (this.isDragging) return;
    this.updatePointer(e);
    const hit = this.pickStage();
    if (hit) {
      this.callbacks.onSelectStage(hit);
    }
  };

  private handlePointerLeave = () => {
    this.pointer.set(-99, -99);
    this.pointerMoved = false;
    this.renderer.domElement.style.cursor = 'grab';
    this.callbacks.onHoverStage(null);
  };

  private pickStage(): StageId | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hitTargets = [...this.stations.values()].map((s) => s.hitMesh);
    const hits = this.raycaster.intersectObjects(hitTargets, false);
    if (hits.length === 0) return null;
    return (hits[0].object.userData?.stageId as StageId) || null;
  }

  setTheme(theme: ThemeMode) {
    this.theme = theme;
    const pal = SCENE_THEMES[theme];
    this.scene.background = new THREE.Color(pal.background);
    this.scene.fog = new THREE.FogExp2(pal.background, 0.0085);
    this.ambientLight.intensity = pal.ambientIntensity;
    this.hemiLight.intensity = pal.hemiIntensity;
    this.hemiLight.groundColor.setHex(theme === 'dark' ? 0x16291e : 0x6f9e5e);
    this.keyLight.intensity = pal.keyIntensity;
    this.rimLight.intensity = pal.rimIntensity;

    this.office.setTheme(theme, pal);
    setConduitsTheme(this.conduits, pal);
    for (const station of this.stations.values()) {
      station.setTheme(theme, pal);
    }
    this.renderSingleFrame();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) {
      this.stopLoop();
      this.renderSingleFrame();
    } else if (!document.hidden && !this.disposed) {
      this.clock.getDelta();
      this.startLoop();
    }
  }

  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.controls.enableDamping = !reduced;
    this.renderSingleFrame();
  }

  setSelectedStage(stageId: StageId | null) {
    for (const station of this.stations.values()) {
      station.selected = station.id === stageId;
    }
    if (this.paused || this.reducedMotion) {
      this.renderSingleFrame();
    }
  }

  private getAspectZoom(maxScale = 1.88, numerator = 1.12): number {
    if (this.camera.aspect >= 0.95) return 1;
    return Math.min(maxScale, numerator / Math.max(this.camera.aspect, 0.52));
  }

  private getOverviewPose(): { pos: [number, number, number]; target: [number, number, number] } {
    const base = CAMERA_PRESETS.overview;
    const scale = this.getAspectZoom(1.88, 1.12);
    return {
      pos: [base.pos[0], base.pos[1] * scale, base.pos[2] * scale],
      target: [base.target[0], base.target[1], base.target[2]]
    };
  }

  setCameraPreset(preset: CameraPreset) {
    this.cameraPreset = preset;
    if (preset === 'overview') {
      const overview = this.getOverviewPose();
      this.isIdleOverview = true;
      this.desiredCamPos.set(...overview.pos);
      this.desiredTarget.set(...overview.target);
    } else if (preset === 'core') {
      const scale = this.getAspectZoom(1.45, 1.0);
      this.isIdleOverview = false;
      this.desiredCamPos.set(
        CAMERA_PRESETS.core.pos[0],
        CAMERA_PRESETS.core.pos[1] * scale,
        CAMERA_PRESETS.core.pos[2] * scale
      );
      this.desiredTarget.set(...CAMERA_PRESETS.core.target);
    } else if (this.isRunActive) {
      this.isIdleOverview = false;
      this.followStage(this.followStageId);
      return;
    } else {
      const overview = this.getOverviewPose();
      this.isIdleOverview = true;
      this.desiredCamPos.set(...overview.pos);
      this.desiredTarget.set(...overview.target);
    }
    this.cameraTweening = true;
    if (this.reducedMotion || this.paused) {
      this.camera.position.copy(this.desiredCamPos);
      this.controls.target.copy(this.desiredTarget);
      this.controls.update();
      this.renderSingleFrame();
    }
  }

  focusStage(stageId: StageId) {
    const def = STAGE_BY_ID[stageId];
    if (!def) return;
    const scale = this.getAspectZoom(1.45, 1.0);
    this.isIdleOverview = false;
    this.followStageId = stageId;
    this.desiredTarget.set(def.position3D[0] * 0.65, 0.55, def.position3D[2] * 0.6);
    this.desiredCamPos.set(
      def.position3D[0] * 0.72,
      8.6 * scale,
      (13.5 + def.position3D[2] * 0.45) * scale
    );
    this.cameraTweening = true;
    if (this.reducedMotion || this.paused) {
      this.camera.position.copy(this.desiredCamPos);
      this.controls.target.copy(this.desiredTarget);
      this.controls.update();
      this.renderSingleFrame();
    }
  }

  private followStage(stageId: StageId) {
    if (this.cameraPreset !== 'follow') return;
    const def = STAGE_BY_ID[stageId];
    if (!def) return;
    const scale = this.getAspectZoom(1.52, 1.04);
    this.isIdleOverview = false;
    this.followStageId = stageId;
    const tx = def.position3D[0] * 0.42;
    const tz = def.position3D[2] * 0.35;
    this.desiredTarget.set(tx, 0.4, tz);
    this.desiredCamPos.set(tx * 0.8, 10.6 * scale, (15.2 + tz * 0.55) * scale);
    this.cameraTweening = true;
  }

  resetToIdle() {
    const pal = SCENE_THEMES[this.theme];
    this.packets.clear();
    this.lastStageVisited = 'ingress';
    this.followStageId = 'ingress';
    this.isRunActive = false;
    for (const station of this.stations.values()) {
      station.setState('idle', {}, pal);
    }
    if (this.cameraPreset === 'follow') {
      const overview = this.getOverviewPose();
      this.isIdleOverview = true;
      this.desiredCamPos.set(...overview.pos);
      this.desiredTarget.set(...overview.target);
      this.cameraTweening = true;
    }
    if (this.paused || this.reducedMotion) {
      this.renderSingleFrame();
    }
  }

  syncRunState(run: PipelineRun | null) {
    if (!run) {
      this.resetToIdle();
      return;
    }
    const pal = SCENE_THEMES[this.theme];
    for (const def of STAGE_DEFINITIONS) {
      const stageInfo = run.stages?.[def.id];
      const rig = this.stations.get(def.id);
      if (!rig) continue;
      if (stageInfo) {
        rig.setState(stageInfo.phase, stageInfo.meta || {}, pal);
      } else {
        rig.setState('idle', {}, pal);
      }
    }
    this.lastStageVisited = run.currentStage || 'ingress';
    this.isRunActive = run.status === 'running' || run.status === 'waiting_approval';
    if (this.cameraPreset === 'follow') {
      if (this.isRunActive) {
        this.followStage(this.lastStageVisited);
      } else {
        const overview = this.getOverviewPose();
        this.isIdleOverview = true;
        this.desiredCamPos.set(...overview.pos);
        this.desiredTarget.set(...overview.target);
        this.cameraTweening = true;
      }
    }
    if (this.paused || this.reducedMotion) {
      this.renderSingleFrame();
    }
  }

  applyEvent(ev: PipelineEvent) {
    const pal = SCENE_THEMES[this.theme];
    const rig = this.stations.get(ev.stage);
    if (!rig) return;

    rig.setState(ev.phase, ev.meta || {}, pal);

    const tierColor = ev.meta?.modelTier
      ? getTierColorHex(ev.meta.modelTier, pal)
      : (ev.phase === 'failed'
          ? pal.coral
          : (STAGE_BY_ID[ev.stage].accentRole === 'transport' ? pal.emerald : pal.amber));

    if (ev.meta?.postTurn && ev.stage === 'context') {
      this.packets.spawn('delivery->context', 'context', pal.amber, 0.72, this.reducedMotion);
    } else if (ev.stage === 'queue' && ev.phase === 'started') {
      this.packets.spawn('ingress->queue', 'queue', pal.emerald, 0.4, this.reducedMotion);
    } else if (ev.stage === 'gate') {
      this.packets.spawn('queue->gate', 'gate', pal.emerald, 0.38, this.reducedMotion);
      if (ev.phase === 'completed') {
        this.packets.spawn('gate->ingress', 'ingress', pal.emerald, 0.48, this.reducedMotion);
      }
    } else if (ev.stage === 'multimodal' && ev.phase === 'started') {
      this.packets.spawn('gate->multimodal', 'multimodal', pal.amber, 0.46, this.reducedMotion);
    } else if (ev.stage === 'context' && ev.phase !== 'progress') {
      if (this.lastStageVisited === 'multimodal') {
        this.packets.spawn('multimodal->context', 'context', pal.amber, 0.62, this.reducedMotion);
      } else {
        this.packets.spawn('gate->context', 'context', pal.emerald, 0.56, this.reducedMotion);
      }
    } else if (ev.stage === 'llm' && ev.phase === 'started') {
      if (this.lastStageVisited === 'tools') {
        this.packets.spawn('tools->llm', 'llm', tierColor, 0.44, this.reducedMotion);
      } else {
        this.packets.spawn('context->llm', 'llm', tierColor, 0.48, this.reducedMotion);
      }
    } else if (ev.stage === 'tools' && (ev.phase === 'started' || ev.phase === 'waiting')) {
      this.packets.spawn('llm->tools', 'tools', pal.amber, 0.42, this.reducedMotion);
      const domains = Array.isArray(ev.meta?.toolGroups) && ev.meta.toolGroups.length > 0
        ? ev.meta.toolGroups
        : (ev.meta?.toolGroup ? [ev.meta.toolGroup] : []);
      domains.forEach((domain) => {
        this.packets.spawn(`tools->sat:${domain.toLowerCase()}`, 'tools', pal.amber, 0.44, this.reducedMotion);
      });
    } else if (ev.stage === 'delivery') {
      if (ev.phase === 'started' || this.lastStageVisited !== 'delivery') {
        this.packets.spawn('llm->delivery', 'delivery', pal.emerald, 0.56, this.reducedMotion);
      }
      if (ev.meta?.ttsUsed) {
        rig.triggerTtsWaves?.();
      }
    }

    if (!ev.meta?.postTurn) {
      this.lastStageVisited = ev.stage;
      this.isRunActive = !(ev.stage === 'delivery' && (ev.phase === 'completed' || ev.phase === 'failed'));
      if (this.cameraPreset === 'follow') {
        this.followStage(ev.stage);
      }
    }

    if (this.paused || this.reducedMotion) {
      this.renderSingleFrame();
    }
  }

  resize() {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.cameraPreset === 'overview' || (this.cameraPreset === 'follow' && !this.isRunActive && this.isIdleOverview)) {
      const overview = this.getOverviewPose();
      this.desiredCamPos.set(...overview.pos);
      this.desiredTarget.set(...overview.target);
      this.camera.position.copy(this.desiredCamPos);
      this.controls.target.copy(this.desiredTarget);
      this.controls.update();
    } else if (this.cameraPreset === 'core') {
      const scale = this.getAspectZoom(1.45, 1.0);
      this.desiredCamPos.set(
        CAMERA_PRESETS.core.pos[0],
        CAMERA_PRESETS.core.pos[1] * scale,
        CAMERA_PRESETS.core.pos[2] * scale
      );
      this.desiredTarget.set(...CAMERA_PRESETS.core.target);
      this.camera.position.copy(this.desiredCamPos);
      this.controls.target.copy(this.desiredTarget);
      this.controls.update();
    } else if (this.cameraPreset === 'follow' && this.isRunActive) {
      this.followStage(this.followStageId);
      this.camera.position.copy(this.desiredCamPos);
      this.controls.target.copy(this.desiredTarget);
      this.controls.update();
    }
    this.renderer.setSize(width, height);
    this.renderSingleFrame();
  }

  private startLoop() {
    if (this.rafId !== null || this.paused || this.disposed) return;
    const tick = () => {
      if (this.disposed || this.paused) {
        this.rafId = null;
        return;
      }
      const dt = Math.min(this.clock.getDelta(), 0.05);
      this.elapsed += dt;
      this.stepScene(dt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private stepScene(dt: number) {
    const pal = SCENE_THEMES[this.theme];

    if (this.cameraTweening) {
      const alpha = this.reducedMotion ? 1 : 1 - Math.exp(-3.4 * dt);
      this.camera.position.lerp(this.desiredCamPos, alpha);
      this.controls.target.lerp(this.desiredTarget, alpha);
      if (this.camera.position.distanceTo(this.desiredCamPos) < 0.03) {
        this.cameraTweening = false;
      }
    }

    this.controls.update();

    if (this.pointerMoved) {
      const hoveredId = this.pickStage();
      this.renderer.domElement.style.cursor = hoveredId ? 'pointer' : 'grab';
      for (const station of this.stations.values()) {
        station.hovered = station.id === hoveredId;
      }
      this.callbacks.onHoverStage(hoveredId);
    }

    for (const station of this.stations.values()) {
      station.update(dt, this.elapsed, this.reducedMotion, pal);
    }
    this.packets.update(dt);

    this.renderer.render(this.scene, this.camera);
    this.projectStageLabels();
  }

  private renderSingleFrame() {
    this.stepScene(0);
  }

  private projectStageLabels() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;

    const projected: ProjectedLabel[] = [];
    for (const station of this.stations.values()) {
      this.tmpVec.copy(station.labelAnchor).project(this.camera);
      const x = (this.tmpVec.x * 0.5 + 0.5) * width;
      const y = (-this.tmpVec.y * 0.5 + 0.5) * height;
      const visible =
        this.tmpVec.z >= -1 &&
        this.tmpVec.z <= 1 &&
        x >= 46 &&
        x <= width - 46 &&
        y >= 26 &&
        y <= height - 14;
      projected.push({ id: station.id, x, y, visible });
    }
    this.callbacks.onProjectLabels(projected);
  }

  dispose() {
    this.disposed = true;
    this.stopLoop();
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointermove', this.handlePointerMove);
    dom.removeEventListener('pointerdown', this.handlePointerDown);
    dom.removeEventListener('pointerup', this.handlePointerUp);
    dom.removeEventListener('pointerleave', this.handlePointerLeave);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);

    this.packets.dispose();
    this.office.dispose();
    for (const station of this.stations.values()) {
      station.dispose();
    }
    this.controls.dispose();
    this.glowTexture.dispose();

    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material?.dispose();
        }
      }
    });

    this.renderer.dispose();
    if (dom.parentNode === this.container) {
      this.container.removeChild(dom);
    }
  }
}
