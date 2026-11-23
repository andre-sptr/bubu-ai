import * as THREE from 'three';
import { STAGE_DEFINITIONS, TOOL_DOMAIN_NODES } from '../data/stages';
import type { PipelineEventMeta, StageId, StagePhase, ThemeMode } from '../types/pipeline';
import { createFloorBadgeTexture, getTierColorHex, type SceneThemePalette } from './materials';

export interface StationRig {
  id: StageId;
  group: THREE.Group;
  hitMesh: THREE.Mesh;
  labelAnchor: THREE.Vector3;
  basePosition: THREE.Vector3;
  phase: StagePhase | 'idle';
  pulseLevel: number;
  selected: boolean;
  hovered: boolean;
  setTheme: (theme: ThemeMode, palette: SceneThemePalette) => void;
  setState: (phase: StagePhase | 'idle', meta: PipelineEventMeta, palette: SceneThemePalette) => void;
  update: (dt: number, elapsed: number, reducedMotion: boolean, palette: SceneThemePalette) => void;
  triggerArrivalPulse: () => void;
  triggerTtsWaves?: () => void;
  dispose: () => void;
}

function makeDesk(w: number, d: number, h: number, topMat: THREE.Material, frameMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), topMat);
  top.position.y = h;
  top.castShadow = true;
  top.receiveShadow = true;
  g.add(top);

  const legGeo = new THREE.BoxGeometry(0.07, h, 0.07);
  const lx = w / 2 - 0.12;
  const lz = d / 2 - 0.1;
  for (const [x, z] of [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz]]) {
    const leg = new THREE.Mesh(legGeo, frameMat);
    leg.position.set(x, h / 2, z);
    leg.castShadow = true;
    g.add(leg);
  }
  return g;
}

function makeChair(chairMat: THREE.Material, frameMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.06, 8), frameMat);
  base.position.y = 0.04;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.38, 8), frameMat);
  stem.position.y = 0.24;
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.48), chairMat);
  seat.position.y = 0.46;
  seat.castShadow = true;
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.56, 0.08), chairMat);
  back.position.set(0, 0.76, -0.21);
  back.castShadow = true;
  g.add(base, stem, seat, back);
  return g;
}

function makeMonitor(w: number, h: number, frameMat: THREE.Material, screenMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.24, 0.07), frameMat);
  stand.position.y = 0.12;
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.18), frameMat);
  foot.position.y = 0.015;
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.045), frameMat);
  bezel.position.set(0, 0.24 + h / 2, 0);
  bezel.castShadow = true;
  const screen = new THREE.Mesh(new THREE.BoxGeometry(w - 0.07, h - 0.07, 0.015), screenMat);
  screen.position.set(0, 0.24 + h / 2, 0.022);
  g.add(foot, stand, bezel, screen);
  return g;
}

function phaseAccentHex(
  phase: StagePhase | 'idle',
  accentRole: 'transport' | 'cognition',
  meta: PipelineEventMeta,
  palette: SceneThemePalette
): number {
  if (phase === 'failed') return palette.coral;
  if (phase === 'waiting') return palette.amber;
  if (phase === 'bypassed' || phase === 'idle') return palette.mullion;
  if (meta.modelTier) return getTierColorHex(meta.modelTier, palette);
  return accentRole === 'transport' ? palette.emerald : palette.amber;
}

export function createStations(
  root: THREE.Group,
  glowTexture: THREE.CanvasTexture,
  initialTheme: ThemeMode,
  initialPalette: SceneThemePalette
): Map<StageId, StationRig> {
  const stations = new Map<StageId, StationRig>();

  for (const def of STAGE_DEFINITIONS) {
    const group = new THREE.Group();
    const basePos = new THREE.Vector3(...def.position3D);
    group.position.copy(basePos);
    root.add(group);

    const isBackRow = def.position3D[2] < 0;
    const isCore = def.id === 'llm';

    // Shared architectural materials per station so theme updates stay crisp
    const deskTopMat = new THREE.MeshStandardMaterial({
      color: initialPalette.deskTop,
      roughness: 0.65,
      metalness: 0.08
    });
    const frameMat = new THREE.MeshStandardMaterial({
      color: initialPalette.deskFrame,
      roughness: 0.42,
      metalness: 0.6
    });
    const chairMat = new THREE.MeshStandardMaterial({
      color: initialPalette.chair,
      roughness: 0.72,
      metalness: 0.1
    });
    const rackMat = new THREE.MeshStandardMaterial({
      color: initialPalette.rack,
      roughness: 0.5,
      metalness: 0.45
    });
    const monFrameMat = new THREE.MeshStandardMaterial({
      color: initialPalette.monitorFrame,
      roughness: 0.4,
      metalness: 0.55
    });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: initialPalette.glassWall,
      roughness: 0.12,
      metalness: 0.08,
      transparent: true,
      opacity: 0.56,
      ior: 1.45
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: def.accentRole === 'transport' ? initialPalette.emerald : initialPalette.amber,
      emissive: def.accentRole === 'transport' ? initialPalette.emerald : initialPalette.amber,
      emissiveIntensity: 0.2,
      roughness: 0.25,
      metalness: 0.65
    });
    const bayTrimMat = new THREE.MeshStandardMaterial({
      color: initialPalette.floorTrim,
      emissive: def.accentRole === 'transport' ? initialPalette.emerald : initialPalette.amber,
      emissiveIntensity: 0.12,
      roughness: 0.4,
      metalness: 0.5
    });

    // Neat bay outline on office floor (4.3 x 3.8)
    const bayW = 4.3;
    const bayD = 3.85;
    const edgeThick = 0.05;
    const edgeNorth = new THREE.Mesh(new THREE.BoxGeometry(bayW, 0.02, edgeThick), bayTrimMat);
    edgeNorth.position.set(0, 0.012, -bayD / 2);
    const edgeSouth = new THREE.Mesh(new THREE.BoxGeometry(bayW, 0.02, edgeThick), bayTrimMat);
    edgeSouth.position.set(0, 0.012, bayD / 2);
    const edgeWest = new THREE.Mesh(new THREE.BoxGeometry(edgeThick, 0.02, bayD), bayTrimMat);
    edgeWest.position.set(-bayW / 2, 0.012, 0);
    const edgeEast = new THREE.Mesh(new THREE.BoxGeometry(edgeThick, 0.02, bayD), bayTrimMat);
    edgeEast.position.set(bayW / 2, 0.012, 0);
    group.add(edgeNorth, edgeSouth, edgeWest, edgeEast);

    // Printed floor number plate facing central corridor
    let badgeTex = createFloorBadgeTexture(def.index, def.shortName, initialTheme);
    const badgeMat = new THREE.MeshStandardMaterial({
      map: badgeTex,
      roughness: 0.5,
      metalness: 0.1
    });
    const badgeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.52), badgeMat);
    badgeMesh.rotation.x = -Math.PI / 2;
    badgeMesh.position.set(0, 0.02, isBackRow ? 1.72 : -1.72);
    group.add(badgeMesh);

    // Invisible click target covering workstation bay
    const hitMesh = new THREE.Mesh(
      new THREE.BoxGeometry(4.2, 2.6, 3.8),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitMesh.position.y = 1.1;
    hitMesh.userData = { stageId: def.id };
    group.add(hitMesh);

    const dynamicParts: {
      update?: (dt: number, elapsed: number, rig: StationRig, reduced: boolean, pal: SceneThemePalette) => void;
      onState?: (phase: StagePhase | 'idle', meta: PipelineEventMeta, pal: SceneThemePalette) => void;
      onTheme?: (pal: SceneThemePalette) => void;
      triggerWaves?: () => void;
    } = {};

    // =========================================================================
    // 01. INGRESS: Lobby & Webhook Reception Desk
    // =========================================================================
    if (def.id === 'ingress') {
      const counter = makeDesk(2.2, 0.85, 0.88, deskTopMat, frameMat);
      counter.position.set(0.25, 0, 0.1);
      const frontPanel = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.82, 0.08), frameMat);
      frontPanel.position.set(0.25, 0.42, 0.51);
      const accentStrip = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.07, 0.04), accentMat);
      accentStrip.position.set(0.25, 0.72, 0.55);

      const mon1 = makeMonitor(0.76, 0.44, monFrameMat, accentMat);
      mon1.position.set(-0.18, 0.92, 0.0);
      mon1.rotation.y = 0.2;
      const mon2 = makeMonitor(0.76, 0.44, monFrameMat, accentMat);
      mon2.position.set(0.66, 0.92, 0.0);
      mon2.rotation.y = -0.2;

      const chair = makeChair(chairMat, frameMat);
      chair.position.set(0.25, 0, -0.78);

      // Emerald WhatsApp Inbound Portal Pylon near left entrance
      const portalBase = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.52, 0.14, 12), frameMat);
      portalBase.position.set(-1.35, 0.07, -0.35);
      const portalGlass = new THREE.Mesh(new THREE.BoxGeometry(0.46, 1.45, 0.16), glassMat);
      portalGlass.position.set(-1.35, 0.86, -0.35);
      const portalRing = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.04, 10, 28), accentMat);
      portalRing.position.set(-1.35, 1.0, -0.22);

      group.add(counter, frontPanel, accentStrip, mon1, mon2, chair, portalBase, portalGlass, portalRing);

      dynamicParts.update = (dt, _elapsed, rig, reduced) => {
        if (!reduced) {
          portalRing.rotation.z += dt * (rig.phase === 'started' || rig.phase === 'completed' ? 1.8 : 0.35);
        }
      };
    }

    // =========================================================================
    // 02. QUEUE: Server & SQLite WAL Rack Room
    // =========================================================================
    else if (def.id === 'queue') {
      const rackPositions = [-1.1, 1.1];
      for (const rx of rackPositions) {
        const cab = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.95, 0.82), rackMat);
        cab.position.set(rx, 0.98, -0.7);
        cab.castShadow = true;
        cab.receiveShadow = true;
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.75, 0.04), glassMat);
        door.position.set(rx, 0.98, -0.27);
        group.add(cab, door);
      }

      // Central visible SQLite Priority Queue Blade Stack
      const stackFrame = new THREE.Mesh(new THREE.BoxGeometry(0.96, 1.42, 0.72), rackMat);
      stackFrame.position.set(0, 0.71, -0.65);
      stackFrame.castShadow = true;
      group.add(stackFrame);

      const blades: THREE.Mesh[] = [];
      const bladeMats: THREE.MeshStandardMaterial[] = [];
      for (let i = 0; i < 4; i++) {
        const bMat = accentMat.clone();
        bMat.emissiveIntensity = 0.16;
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.12, 0.62), bMat);
        blade.position.set(0, 0.34 + i * 0.28, -0.58);
        blades.push(blade);
        bladeMats.push(bMat);
        group.add(blade);
      }

      // Compact sysadmin console in front of racks
      const desk = makeDesk(1.4, 0.56, 0.78, deskTopMat, frameMat);
      desk.position.set(0, 0, 0.48);
      const mon = makeMonitor(0.86, 0.44, monFrameMat, accentMat);
      mon.position.set(0, 0.82, 0.48);
      mon.rotation.y = Math.PI;
      group.add(desk, mon);

      let activeSlots = 1;
      dynamicParts.onState = (phase, meta) => {
        activeSlots = Math.max(1, Math.min(4, Number(meta.queueProcessing || 1) + Number(meta.queuePending || 0)));
        bladeMats.forEach((m, idx) => {
          m.emissiveIntensity = phase === 'started' && idx < activeSlots ? 1.1 : 0.18;
        });
      };
      dynamicParts.update = (_dt, elapsed, rig, reduced) => {
        blades.forEach((blade, idx) => {
          const baseZ = -0.58;
          blade.position.z = !reduced && rig.phase === 'started' && idx < activeSlots
            ? baseZ + Math.sin(elapsed * 4.2 + idx * 0.8) * 0.07
            : baseZ;
        });
      };
    }

    // =========================================================================
    // 03. GATE: Security & Access Control Desk + Biometric Archway
    // =========================================================================
    else if (def.id === 'gate') {
      // Biometric Security Scanner Arch
      const leftPillar = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.85, 0.42), rackMat);
      leftPillar.position.set(-0.92, 0.92, -0.6);
      leftPillar.castShadow = true;
      const rightPillar = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.85, 0.42), rackMat);
      rightPillar.position.set(0.92, 0.92, -0.6);
      rightPillar.castShadow = true;
      const topBar = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.18, 0.44), rackMat);
      topBar.position.set(0, 1.88, -0.6);
      const glassFin = new THREE.Mesh(new THREE.BoxGeometry(1.64, 1.65, 0.04), glassMat);
      glassFin.position.set(0, 0.92, -0.6);

      const scanBeam = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.05, 0.1), accentMat);
      scanBeam.position.set(0, 0.95, -0.56);

      // Security desk & chair
      const desk = makeDesk(1.75, 0.72, 0.78, deskTopMat, frameMat);
      desk.position.set(0, 0, 0.42);
      const monL = makeMonitor(0.68, 0.4, monFrameMat, accentMat);
      monL.position.set(-0.38, 0.82, 0.42);
      monL.rotation.y = 0.18;
      const monR = makeMonitor(0.68, 0.4, monFrameMat, accentMat);
      monR.position.set(0.38, 0.82, 0.42);
      monR.rotation.y = -0.18;
      const chair = makeChair(chairMat, frameMat);
      chair.position.set(0, 0, -0.2);

      group.add(leftPillar, rightPillar, topBar, glassFin, scanBeam, desk, monL, monR, chair);

      dynamicParts.update = (_dt, elapsed, rig, reduced) => {
        if (!reduced) {
          const active = rig.phase === 'started' || rig.phase === 'completed';
          scanBeam.position.y = 0.95 + Math.sin(elapsed * (active ? 4.5 : 1.1)) * 0.65;
        }
      };
    }

    // =========================================================================
    // 04. MULTIMODAL: Media, OCR & Audio Lab Booth
    // =========================================================================
    else if (def.id === 'multimodal') {
      const mainDesk = makeDesk(2.2, 0.86, 0.78, deskTopMat, frameMat);
      mainDesk.position.set(0, 0, -0.35);
      const sideDesk = makeDesk(0.85, 1.45, 0.78, deskTopMat, frameMat);
      sideDesk.position.set(0.95, 0, 0.42);
      const chair = makeChair(chairMat, frameMat);
      chair.position.set(-0.2, 0, 0.48);

      // Flatbed OCR Scanner + sweeping optical bar
      const scannerBed = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.08, 0.56), rackMat);
      scannerBed.position.set(-0.55, 0.86, -0.35);
      const scanBar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.5), accentMat);
      scanBar.position.set(-0.55, 0.92, -0.35);

      // Central suspended Multimodal Prism + 4 domain orbs (image, audio, video, document)
      const prism = new THREE.Mesh(new THREE.OctahedronGeometry(0.34, 0), glassMat);
      prism.position.set(0.25, 1.48, -0.38);

      const emitterKinds = ['image', 'audio', 'video', 'document'] as const;
      const emitterNodes: Array<{ kind: string; mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; angle: number }> = [];
      emitterKinds.forEach((kind, i) => {
        const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const eMat = accentMat.clone();
        eMat.emissiveIntensity = 0.16;
        const eMesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 12), eMat);
        eMesh.position.set(0.25 + Math.cos(angle) * 0.52, 1.48, -0.38 + Math.sin(angle) * 0.52);
        group.add(eMesh);
        emitterNodes.push({ kind, mesh: eMesh, mat: eMat, angle });
      });

      // Studio monitor + boom mic stand on side bench
      const mon = makeMonitor(0.88, 0.48, monFrameMat, accentMat);
      mon.position.set(0.95, 0.82, 0.45);
      mon.rotation.y = -Math.PI / 2;
      const micStand = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.45, 8), frameMat);
      micStand.position.set(0.92, 1.04, -0.05);

      group.add(mainDesk, sideDesk, chair, scannerBed, scanBar, prism, mon, micStand);

      let activeKind = '';
      dynamicParts.onState = (phase, meta) => {
        activeKind = String(meta.mediaKind || '').toLowerCase();
        emitterNodes.forEach((node) => {
          const match = activeKind && (node.kind === activeKind || (activeKind === 'voice_note' && node.kind === 'audio'));
          node.mat.emissiveIntensity = phase === 'started' || phase === 'completed'
            ? (match ? 1.35 : 0.4)
            : 0.14;
        });
      };
      dynamicParts.update = (dt, elapsed, rig, reduced) => {
        if (!reduced) {
          const active = rig.phase === 'started';
          prism.rotation.y += dt * (active ? 1.6 : 0.35);
          scanBar.position.x = -0.55 + Math.sin(elapsed * (active ? 4.2 : 1.0)) * 0.28;
          emitterNodes.forEach((node, idx) => {
            const a = node.angle + elapsed * (active ? 1.4 : 0.35);
            node.mesh.position.set(
              0.25 + Math.cos(a) * 0.52,
              1.48 + Math.sin(elapsed * 2 + idx) * 0.05,
              -0.38 + Math.sin(a) * 0.52
            );
          });
        }
      };
    }

    // =========================================================================
    // 05. CONTEXT: Digital Library & Hybrid Vector Memory Vault
    // =========================================================================
    else if (def.id === 'context') {
      // Twin illuminated vector archive shelving cabinets in rear of bay (z = +0.9)
      for (const sx of [-1.05, 1.05]) {
        const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.78, 0.46), rackMat);
        shelf.position.set(sx, 0.89, 0.92);
        shelf.castShadow = true;
        group.add(shelf);
        for (let row = 0; row < 4; row++) {
          const strip = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.06, 0.05), accentMat);
          strip.position.set(sx, 0.42 + row * 0.36, 0.68);
          group.add(strip);
        }
      }

      // Research workstation desk + monitor + chair
      const desk = makeDesk(1.75, 0.74, 0.78, deskTopMat, frameMat);
      desk.position.set(0, 0, -0.25);
      const mon = makeMonitor(0.84, 0.44, monFrameMat, accentMat);
      mon.position.set(-0.42, 0.82, -0.25);
      mon.rotation.y = Math.PI + 0.15;
      const chair = makeChair(chairMat, frameMat);
      chair.position.set(0, 0, -0.92);
      group.add(desk, mon, chair);

      // Floating Vector Memory Crystal Cluster above desk
      const crystals: Array<{ mesh: THREE.Mesh; baseY: number; angle: number; radius: number }> = [];
      const crystalGeo = new THREE.OctahedronGeometry(0.095, 0);
      for (let i = 0; i < 10; i++) {
        const ring = i < 5 ? 0 : 1;
        const idx = i % 5;
        const angle = (idx / 5) * Math.PI * 2 + ring * 0.6;
        const radius = ring === 0 ? 0.32 : 0.54;
        const baseY = ring === 0 ? 1.52 : 1.28;
        const cMesh = new THREE.Mesh(crystalGeo, accentMat);
        cMesh.position.set(0.32 + Math.cos(angle) * radius, baseY, -0.2 + Math.sin(angle) * radius);
        group.add(cMesh);
        crystals.push({ mesh: cMesh, baseY, angle, radius });
      }

      dynamicParts.update = (_dt, elapsed, rig, reduced) => {
        if (!reduced) {
          const speed = rig.phase === 'started' || rig.phase === 'progress' ? 2.4 : 0.7;
          crystals.forEach((c, idx) => {
            const a = c.angle + elapsed * 0.25 * speed;
            c.mesh.position.set(
              0.32 + Math.cos(a) * c.radius,
              c.baseY + Math.sin(elapsed * speed + idx * 0.7) * 0.05,
              -0.2 + Math.sin(a) * c.radius
            );
            c.mesh.rotation.y = elapsed * 0.6 + idx;
          });
        }
      };
    }

    // =========================================================================
    // 06. LLM: Executive AI Command Core (Hero Centerpiece)
    // =========================================================================
    else if (def.id === 'llm') {
      // Raised octagonal dais
      const dais = new THREE.Mesh(new THREE.CylinderGeometry(1.58, 1.72, 0.18, 8), rackMat);
      dais.position.set(0, 0.09, 0);
      dais.receiveShadow = true;
      dais.castShadow = true;
      const daisRing = new THREE.Mesh(new THREE.TorusGeometry(1.62, 0.036, 10, 40), accentMat);
      daisRing.rotation.x = Math.PI / 2;
      daisRing.position.set(0, 0.19, 0);

      // Executive panoramic command console (3 monitors) + chair
      const desk = makeDesk(2.1, 0.76, 0.88, deskTopMat, frameMat);
      desk.position.set(0, 0.08, 0.62);
      const monC = makeMonitor(0.84, 0.44, monFrameMat, accentMat);
      monC.position.set(0, 0.94, 0.64);
      monC.rotation.y = Math.PI;
      const monL = makeMonitor(0.68, 0.42, monFrameMat, accentMat);
      monL.position.set(-0.76, 0.94, 0.56);
      monL.rotation.y = Math.PI - 0.35;
      const monR = makeMonitor(0.68, 0.42, monFrameMat, accentMat);
      monR.position.set(0.76, 0.94, 0.56);
      monR.rotation.y = Math.PI + 0.35;
      const chair = makeChair(chairMat, frameMat);
      chair.position.set(0, 0.08, 1.24);

      // Centerpiece Holographic 3-Ring Gyroscope Core hovering over command podium
      const ringOuter = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.036, 12, 42), rackMat);
      ringOuter.position.set(0, 1.56, -0.35);
      const ringMid = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.032, 12, 36), accentMat);
      ringMid.position.set(0, 1.56, -0.35);
      const ringInner = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.026, 10, 32), rackMat);
      ringInner.position.set(0, 1.56, -0.35);
      const crystalCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.25, 0), accentMat);
      crystalCore.position.set(0, 1.56, -0.35);
      const glassCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.33, 0), glassMat);
      glassCore.position.set(0, 1.56, -0.35);

      const coreHalo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture,
          color: initialPalette.amber,
          transparent: true,
          opacity: 0.24,
          depthWrite: false,
          blending: THREE.AdditiveBlending
        })
      );
      coreHalo.scale.set(2.2, 2.2, 1);
      coreHalo.position.set(0, 1.56, -0.35);

      group.add(dais, daisRing, desk, monC, monL, monR, chair, ringOuter, ringMid, ringInner, crystalCore, glassCore, coreHalo);

      dynamicParts.onState = (phase, meta, pal) => {
        const colHex = phaseAccentHex(phase, 'cognition', meta, pal);
        (coreHalo.material as THREE.SpriteMaterial).color.setHex(colHex);
        (coreHalo.material as THREE.SpriteMaterial).opacity =
          phase === 'started' || phase === 'progress' ? 0.62 : 0.2;
      };
      dynamicParts.onTheme = (pal) => {
        (coreHalo.material as THREE.SpriteMaterial).color.setHex(pal.amber);
      };
      dynamicParts.update = (dt, elapsed, rig, reduced) => {
        if (!reduced) {
          const active = rig.phase === 'started' || rig.phase === 'progress';
          const rate = active ? 1.85 : 0.35;
          ringOuter.rotation.x += dt * 0.4 * rate;
          ringOuter.rotation.y += dt * 0.65 * rate;
          ringMid.rotation.y -= dt * 0.95 * rate;
          ringMid.rotation.z += dt * 0.48 * rate;
          ringInner.rotation.x -= dt * 1.15 * rate;
          crystalCore.rotation.y += dt * 0.9 * rate;
          glassCore.rotation.y -= dt * 0.45 * rate;
          crystalCore.scale.setScalar(active ? 1 + Math.sin(elapsed * 4.5) * 0.07 : 1);
        }
      };
    }

    // =========================================================================
    // 07. TOOLS: 5-Pod Engineering Operations Hub
    // =========================================================================
    else if (def.id === 'tools') {
      // Central pentagonal hub console
      const hubBase = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.56, 0.72, 5), rackMat);
      hubBase.position.set(0, 0.36, 0);
      hubBase.castShadow = true;
      const hubCap = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.42, 0.08, 5), accentMat);
      hubCap.position.set(0, 0.76, 0);
      group.add(hubBase, hubCap);

      // Approval Gate Security Ring (rises when waiting for /approve)
      const approvalRing = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.04, 10, 32), accentMat);
      approvalRing.rotation.x = Math.PI / 2;
      approvalRing.position.set(0, 1.18, 0);
      approvalRing.visible = false;
      group.add(approvalRing);

      const podList: Array<{
        id: string;
        podGroup: THREE.Group;
        screenMat: THREE.MeshStandardMaterial;
        baseY: number;
      }> = [];

      for (const sat of TOOL_DOMAIN_NODES) {
        const podGroup = new THREE.Group();
        podGroup.position.set(sat.offset[0], 0, sat.offset[2]);
        // Angle each mini-desk to face outward from center
        podGroup.rotation.y = Math.atan2(sat.offset[0], sat.offset[2]);

        const podMat = accentMat.clone();
        podMat.emissiveIntensity = 0.16;

        const miniDesk = makeDesk(0.76, 0.44, 0.68, deskTopMat, frameMat);
        const miniMon = makeMonitor(0.48, 0.3, monFrameMat, podMat);
        miniMon.position.set(0, 0.72, -0.06);
        miniMon.rotation.y = Math.PI;
        const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.44, 10), chairMat);
        stool.position.set(0, 0.22, 0.36);

        podGroup.add(miniDesk, miniMon, stool);
        group.add(podGroup);
        podList.push({ id: sat.id, podGroup, screenMat: podMat, baseY: 0 });
      }

      let activeDomains = new Set<string>();
      dynamicParts.onState = (phase, meta, pal) => {
        const domains = new Set<string>();
        if (meta.toolGroup) domains.add(String(meta.toolGroup).toLowerCase());
        if (Array.isArray(meta.toolGroups)) {
          meta.toolGroups.forEach((g) => domains.add(String(g).toLowerCase()));
        }
        activeDomains = domains;
        approvalRing.visible = phase === 'waiting';

        const activeHex = phase === 'failed' ? pal.coral : pal.amber;
        podList.forEach((pod) => {
          const lit = activeDomains.has(pod.id) && (phase === 'started' || phase === 'waiting' || phase === 'completed' || phase === 'failed');
          pod.screenMat.color.setHex(lit ? activeHex : pal.mullion);
          pod.screenMat.emissive.setHex(lit ? activeHex : pal.mullion);
          pod.screenMat.emissiveIntensity = lit ? 1.25 : 0.14;
        });
      };
      dynamicParts.update = (_dt, elapsed, rig, reduced) => {
        if (!reduced && rig.phase === 'waiting') {
          approvalRing.position.y = 1.18 + Math.sin(elapsed * 3.5) * 0.08;
        }
        podList.forEach((pod, idx) => {
          if (!reduced && (rig.phase === 'started' || rig.phase === 'waiting') && activeDomains.has(pod.id)) {
            pod.podGroup.position.y = Math.sin(elapsed * 4.5 + idx) * 0.04;
          } else {
            pod.podGroup.position.y = 0;
          }
        });
      };
    }

    // =========================================================================
    // 08. DELIVERY: Studio Siar & Outbound WhatsApp Broadcast
    // =========================================================================
    else if (def.id === 'delivery') {
      const desk = makeDesk(1.9, 0.78, 0.78, deskTopMat, frameMat);
      desk.position.set(-0.25, 0, 0.25);
      const monL = makeMonitor(0.72, 0.42, monFrameMat, accentMat);
      monL.position.set(-0.62, 0.82, 0.25);
      monL.rotation.y = Math.PI - 0.18;
      const monR = makeMonitor(0.72, 0.42, monFrameMat, accentMat);
      monR.position.set(0.14, 0.82, 0.25);
      monR.rotation.y = Math.PI + 0.18;
      const chair = makeChair(chairMat, frameMat);
      chair.position.set(-0.25, 0, -0.45);

      // Dual Piper TTS Studio Speaker Towers
      for (const sx of [-1.42, 0.92]) {
        const speaker = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.38, 0.36), rackMat);
        speaker.position.set(sx, 0.69, 0.35);
        speaker.castShadow = true;
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.04, 16), accentMat);
        cone.rotation.x = Math.PI / 2;
        cone.position.set(sx, 1.05, 0.54);
        group.add(speaker, cone);
      }

      // Studio broadcast mic + WhatsApp Outbound Portal Beacon on right
      const mic = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.38, 8), frameMat);
      mic.position.set(-0.25, 0.99, 0.05);
      const beaconBase = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.46, 0.14, 12), frameMat);
      beaconBase.position.set(1.52, 0.07, -0.35);
      const beaconPrism = new THREE.Mesh(new THREE.OctahedronGeometry(0.26, 0), accentMat);
      beaconPrism.position.set(1.52, 1.12, -0.35);

      // Expanding acoustic wave rings for Piper TTS
      const waveRings: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; phaseOffset: number }> = [];
      for (let i = 0; i < 3; i++) {
        const wMat = new THREE.MeshBasicMaterial({
          color: initialPalette.emerald,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide
        });
        const wMesh = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.3, 32), wMat);
        wMesh.rotation.x = -Math.PI / 2;
        wMesh.position.set(-0.25, 1.32, 0.25);
        group.add(wMesh);
        waveRings.push({ mesh: wMesh, mat: wMat, phaseOffset: i * 0.33 });
      }

      group.add(desk, monL, monR, chair, mic, beaconBase, beaconPrism);

      let waveTimer = 0;
      dynamicParts.triggerWaves = () => {
        waveTimer = 2.5;
      };
      dynamicParts.onState = (phase, meta, pal) => {
        if (meta.ttsUsed && (phase === 'started' || phase === 'completed')) {
          waveTimer = 2.5;
        }
        waveRings.forEach((w) => w.mat.color.setHex(pal.emerald));
      };
      dynamicParts.update = (dt, elapsed, _rig, reduced) => {
        if (!reduced) {
          beaconPrism.rotation.y += dt * 1.1;
          beaconPrism.position.y = 1.12 + Math.sin(elapsed * 2.0) * 0.04;
        }
        if (waveTimer > 0 && !reduced) {
          waveTimer = Math.max(0, waveTimer - dt);
          const norm = 1 - waveTimer / 2.5;
          waveRings.forEach((w) => {
            const p = (norm + w.phaseOffset) % 1;
            w.mesh.scale.setScalar(1 + p * 3.8);
            w.mat.opacity = (1 - p) * 0.68;
          });
        } else {
          waveRings.forEach((w) => {
            w.mat.opacity = 0;
          });
        }
      };
    }

    const rig: StationRig = {
      id: def.id,
      group,
      hitMesh,
      labelAnchor: new THREE.Vector3(basePos.x, isCore ? 2.48 : 2.18, basePos.z),
      basePosition: basePos,
      phase: 'idle',
      pulseLevel: 0,
      selected: false,
      hovered: false,
      setTheme(theme, pal) {
        const nextBadge = createFloorBadgeTexture(def.index, def.shortName, theme);
        badgeMat.map = nextBadge;
        badgeMat.needsUpdate = true;
        badgeTex.dispose();
        badgeTex = nextBadge;

        deskTopMat.color.setHex(pal.deskTop);
        frameMat.color.setHex(pal.deskFrame);
        chairMat.color.setHex(pal.chair);
        rackMat.color.setHex(pal.rack);
        monFrameMat.color.setHex(pal.monitorFrame);
        glassMat.color.setHex(pal.glassWall);
        bayTrimMat.color.setHex(pal.floorTrim);
        dynamicParts.onTheme?.(pal);
        this.setState(this.phase, {}, pal);
      },
      setState(phase, meta, pal) {
        this.phase = phase;
        const hex = phaseAccentHex(phase, def.accentRole, meta, pal);
        accentMat.color.setHex(hex);
        accentMat.emissive.setHex(hex);
        const isActive = phase === 'started' || phase === 'progress';
        const isDone = phase === 'completed';
        accentMat.emissiveIntensity = isActive ? 1.15 : (isDone ? 0.58 : (phase === 'waiting' ? 0.92 : 0.18));

        const trimLit = isActive || isDone || phase === 'waiting' || phase === 'failed';
        bayTrimMat.color.setHex(trimLit ? hex : pal.floorTrim);
        bayTrimMat.emissive.setHex(trimLit ? hex : pal.floorTrim);
        bayTrimMat.emissiveIntensity = isActive ? 0.85 : (isDone ? 0.36 : 0.08);
        dynamicParts.onState?.(phase, meta, pal);
      },
      triggerArrivalPulse() {
        this.pulseLevel = 1;
      },
      triggerTtsWaves() {
        dynamicParts.triggerWaves?.();
      },
      update(dt, elapsed, reducedMotion, pal) {
        if (this.pulseLevel > 0) {
          this.pulseLevel = Math.max(0, this.pulseLevel - dt * 2.2);
        }
        const scaleBoost = (this.selected ? 0.035 : 0) + (this.hovered ? 0.02 : 0) + this.pulseLevel * 0.04;
        group.scale.setScalar(1 + scaleBoost);
        bayTrimMat.emissiveIntensity = Math.max(
          this.selected ? 0.78 : 0.08,
          (this.phase === 'started' || this.phase === 'progress' ? 0.85 : 0.16) + this.pulseLevel * 0.72
        );
        dynamicParts.update?.(dt, elapsed, this, reducedMotion, pal);
      },
      dispose() {
        badgeTex.dispose();
      }
    };

    stations.set(def.id, rig);
  }

  return stations;
}
