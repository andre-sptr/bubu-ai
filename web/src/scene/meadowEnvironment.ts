import * as THREE from 'three';
import type { ThemeMode } from '../types/pipeline';
import { createGrassFieldTexture, type SceneThemePalette } from './materials';

export interface MeadowEnvironment {
  group: THREE.Group;
  setTheme: (theme: ThemeMode, palette: SceneThemePalette) => void;
  dispose: () => void;
}

const BASE_Y = -0.465;

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getMeadowHeight(x: number, z: number): number {
  const dx = Math.max(0, Math.abs(x) - 19.5);
  const dz = z < -11.0 ? -11.0 - z : z > 14.2 ? z - 14.2 : 0;
  const distOutside = Math.hypot(dx, dz);
  if (distOutside <= 0) return BASE_Y;

  const t = Math.min(1, distOutside / 20);
  const blend = t * t * (3 - 2 * t);

  const hills =
    Math.sin(x * 0.048) * Math.cos(z * 0.044) * 1.4 +
    Math.sin(x * 0.095 + z * 0.075) * 0.45 +
    Math.cos(x * 0.03 - z * 0.05) * 0.65;
  const backRise = z < -18 ? Math.min(2.6, (-18 - z) * 0.055) : 0;
  const frontScale = z > 12 ? 0.35 : 1.0;

  return BASE_Y + blend * (hills * frontScale + backRise);
}

function isInsideApronOrWalkways(x: number, z: number, pad = 0): boolean {
  // Main futuristic terrace, reflecting pools & perimeter curbs
  if (Math.abs(x) <= 14.0 + pad && z >= -8.8 - pad && z <= 9.2 + pad) return true;
  // Side portal walkways & cantilevered glass canopies
  if (Math.abs(x) <= 19.0 + pad && z >= -2.2 - pad && z <= 1.4 + pad) return true;
  // Front entrance bridge & outer meadow stepping stones
  if (Math.abs(x) <= 2.6 + pad && z >= 8.8 - pad && z <= 13.6 + pad) return true;
  return false;
}

function isInFrontCameraCorridor(x: number, z: number): boolean {
  return z > 5.5 && Math.abs(x) < 19.5;
}

function createGrassTuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  const bladeAngles = [0, Math.PI / 3, (2 * Math.PI) / 3];
  const bladeTiltX = [0.025, -0.02, 0.018];

  for (let i = 0; i < bladeAngles.length; i++) {
    const angle = bladeAngles[i];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const hw = 0.065;
    const tw = 0.012;
    const h = 0.32 + (i % 2) * 0.05;
    const lean = bladeTiltX[i];

    const p0: [number, number, number] = [-hw * cos, 0, -hw * sin];
    const p1: [number, number, number] = [hw * cos, 0, hw * sin];
    const p2: [number, number, number] = [tw * cos + lean, h, tw * sin];
    const p3: [number, number, number] = [-tw * cos + lean, h, -tw * sin];

    const nx = -sin;
    const nz = cos;

    // Two triangles forming a tapered grass blade
    positions.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
    for (let v = 0; v < 6; v++) {
      normals.push(nx, 0.35, nz);
    }
    uvs.push(0, 0, 1, 0, 0.85, 1, 0, 0, 0.85, 1, 0.15, 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

export function createMeadowEnvironment(
  root: THREE.Group,
  initialTheme: ThemeMode,
  initialPalette: SceneThemePalette
): MeadowEnvironment {
  const group = new THREE.Group();
  root.add(group);

  let grassTex = createGrassFieldTexture(initialTheme);

  const groundMat = new THREE.MeshStandardMaterial({
    map: grassTex,
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.02
  });
  const apronMat = new THREE.MeshStandardMaterial({
    color: initialPalette.apron,
    roughness: 0.84,
    metalness: 0.06
  });
  const tuftMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0.02,
    side: THREE.DoubleSide
  });
  const trunkMat = new THREE.MeshStandardMaterial({
    color: initialPalette.treeTrunk,
    roughness: 0.86,
    metalness: 0.04
  });
  const canopyMat = new THREE.MeshStandardMaterial({
    color: initialPalette.treeCanopy,
    roughness: 0.78,
    metalness: 0.03
  });
  const canopyAltMat = new THREE.MeshStandardMaterial({
    color: initialPalette.treeCanopyAlt,
    roughness: 0.76,
    metalness: 0.03
  });
  const stoneMat = new THREE.MeshStandardMaterial({
    color: initialPalette.stone,
    roughness: 0.88,
    metalness: 0.08
  });

  // 1. Expansive rolling meadow terrain (240 x 240)
  const groundGeo = new THREE.PlaneGeometry(240, 240, 72, 72);
  groundGeo.rotateX(-Math.PI / 2);
  const posAttr = groundGeo.getAttribute('position') as THREE.BufferAttribute;
  const vertexColors = new Float32Array(posAttr.count * 3);
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    const vy = getMeadowHeight(vx, vz);
    posAttr.setY(i, vy);

    // Subtle elevation + organic noise tint so texture stays rich without muddying
    const elevFactor = Math.max(-0.08, Math.min(0.1, (vy - BASE_Y) * 0.035));
    const waveNoise = Math.sin(vx * 0.14 + vz * 0.11) * 0.04;
    const shade = Math.max(0.84, Math.min(1.06, 0.96 + elevFactor + waveNoise));
    vertexColors[i * 3] = shade;
    vertexColors[i * 3 + 1] = Math.min(1.08, shade * 1.02);
    vertexColors[i * 3 + 2] = shade * 0.96;
  }
  groundGeo.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3));
  groundGeo.computeVertexNormals();

  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.receiveShadow = true;
  group.add(groundMesh);

  // 2. Outer meadow stepping stones connecting the front entrance bridge into the grassland
  const stoneStepGeo = new THREE.BoxGeometry(2.6, 0.06, 0.85);
  for (const sz of [10.4, 11.6, 12.8]) {
    const step = new THREE.Mesh(stoneStepGeo, apronMat);
    step.position.set(0, -0.455, sz);
    step.receiveShadow = true;
    group.add(step);
  }

  // 3. Instanced 3D grass blade tufts across the meadow (~1,100 instances)
  const rand = mulberry32(20261123);
  const tuftCoords: Array<{ x: number; y: number; z: number; rot: number; sx: number; sy: number; shadeIdx: number }> = [];
  const targetTufts = 1100;
  let attempts = 0;
  while (tuftCoords.length < targetTufts && attempts < 9000) {
    attempts++;
    // Bias 70% of tufts into near/mid meadow ring for crisp visual density around the office
    const nearRing = attempts % 10 < 7;
    const x = nearRing ? (rand() * 2 - 1) * 40 : (rand() * 2 - 1) * 64;
    const z = nearRing ? -34 + rand() * 64 : -54 + rand() * 102;
    if (isInsideApronOrWalkways(x, z, 0.35)) continue;

    tuftCoords.push({
      x,
      y: getMeadowHeight(x, z),
      z,
      rot: rand() * Math.PI * 2,
      sx: 0.72 + rand() * 0.65,
      sy: 0.65 + rand() * 0.8,
      shadeIdx: Math.floor(rand() * 3)
    });
  }

  const tuftGeo = createGrassTuftGeometry();
  const tuftsMesh = new THREE.InstancedMesh(tuftGeo, tuftMat, tuftCoords.length);
  tuftsMesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < tuftCoords.length; i++) {
    const t = tuftCoords[i];
    dummy.position.set(t.x, t.y, t.z);
    dummy.rotation.set(0, t.rot, 0);
    dummy.scale.set(t.sx, t.sy, t.sx);
    dummy.updateMatrix();
    tuftsMesh.setMatrixAt(i, dummy.matrix);
  }
  tuftsMesh.instanceMatrix.needsUpdate = true;

  const tmpColor = new THREE.Color();
  const applyTuftColors = (palette: SceneThemePalette) => {
    const shades = [palette.grassBase, palette.grassMid, palette.grassHighlight];
    for (let i = 0; i < tuftCoords.length; i++) {
      tmpColor.setHex(shades[tuftCoords[i].shadeIdx]);
      tuftsMesh.setColorAt(i, tmpColor);
    }
    if (tuftsMesh.instanceColor) {
      tuftsMesh.instanceColor.needsUpdate = true;
    }
  };
  applyTuftColors(initialPalette);
  group.add(tuftsMesh);

  // 4. Stylized low-poly tree groves around left, right, and rear hills
  const treeSpots: Array<{ x: number; z: number; scale: number; rot: number }> = [];
  let treeAttempts = 0;
  while (treeSpots.length < 28 && treeAttempts < 2500) {
    treeAttempts++;
    const zone = treeAttempts % 3;
    let x: number;
    let z: number;
    if (zone === 0) {
      // Left meadow grove
      x = -16.5 - rand() * 28;
      z = -24 + rand() * 36;
    } else if (zone === 1) {
      // Right meadow grove
      x = 16.5 + rand() * 28;
      z = -24 + rand() * 36;
    } else {
      // Rolling hills behind the office
      x = (rand() * 2 - 1) * 44;
      z = -11.5 - rand() * 28;
    }

    if (isInsideApronOrWalkways(x, z, 1.8)) continue;
    if (isInFrontCameraCorridor(x, z)) continue;
    if (treeSpots.some((other) => Math.hypot(other.x - x, other.z - z) < 4.4)) continue;

    treeSpots.push({
      x,
      z,
      scale: 0.78 + rand() * 0.57,
      rot: rand() * Math.PI * 2
    });
  }

  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 1.55, 7);
  trunkGeo.translate(0, 0.775, 0);
  const lowerCrownGeo = new THREE.DodecahedronGeometry(1.18, 0);
  lowerCrownGeo.translate(0, 2.05, 0);
  const upperCrownGeo = new THREE.DodecahedronGeometry(0.84, 0);
  upperCrownGeo.translate(0, 2.95, 0);

  const trunksMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, treeSpots.length);
  const lowerCrownsMesh = new THREE.InstancedMesh(lowerCrownGeo, canopyMat, treeSpots.length);
  const upperCrownsMesh = new THREE.InstancedMesh(upperCrownGeo, canopyAltMat, treeSpots.length);
  trunksMesh.castShadow = true;
  trunksMesh.receiveShadow = true;
  lowerCrownsMesh.castShadow = true;
  lowerCrownsMesh.receiveShadow = true;
  upperCrownsMesh.castShadow = true;
  upperCrownsMesh.receiveShadow = true;

  for (let i = 0; i < treeSpots.length; i++) {
    const tr = treeSpots[i];
    const y = getMeadowHeight(tr.x, tr.z) - 0.04;
    dummy.position.set(tr.x, y, tr.z);
    dummy.rotation.set(0, tr.rot, 0);
    dummy.scale.set(tr.scale, tr.scale, tr.scale);
    dummy.updateMatrix();
    trunksMesh.setMatrixAt(i, dummy.matrix);
    lowerCrownsMesh.setMatrixAt(i, dummy.matrix);
    upperCrownsMesh.setMatrixAt(i, dummy.matrix);
  }
  trunksMesh.instanceMatrix.needsUpdate = true;
  lowerCrownsMesh.instanceMatrix.needsUpdate = true;
  upperCrownsMesh.instanceMatrix.needsUpdate = true;
  group.add(trunksMesh, lowerCrownsMesh, upperCrownsMesh);

  // 5. Low-poly meadow shrubs (~32 instances)
  const shrubSpots: Array<{ x: number; z: number; scale: number; rot: number }> = [];
  let shrubAttempts = 0;
  while (shrubSpots.length < 32 && shrubAttempts < 2000) {
    shrubAttempts++;
    const x = (rand() * 2 - 1) * 38;
    const z = -28 + rand() * 44;
    if (isInsideApronOrWalkways(x, z, 0.7)) continue;
    if (z > 6 && Math.abs(x) < 16) continue;
    if (shrubSpots.some((other) => Math.hypot(other.x - x, other.z - z) < 2.2)) continue;
    shrubSpots.push({
      x,
      z,
      scale: 0.65 + rand() * 0.7,
      rot: rand() * Math.PI * 2
    });
  }

  const shrubGeo = new THREE.DodecahedronGeometry(0.55, 0);
  shrubGeo.translate(0, 0.34, 0);
  const shrubsMesh = new THREE.InstancedMesh(shrubGeo, canopyAltMat, shrubSpots.length);
  shrubsMesh.castShadow = true;
  shrubsMesh.receiveShadow = true;
  for (let i = 0; i < shrubSpots.length; i++) {
    const sh = shrubSpots[i];
    dummy.position.set(sh.x, getMeadowHeight(sh.x, sh.z) - 0.06, sh.z);
    dummy.rotation.set(0, sh.rot, 0);
    dummy.scale.set(sh.scale, sh.scale * 0.74, sh.scale);
    dummy.updateMatrix();
    shrubsMesh.setMatrixAt(i, dummy.matrix);
  }
  shrubsMesh.instanceMatrix.needsUpdate = true;
  group.add(shrubsMesh);

  // 6. Field stones along walkways, groves, and meadow contours (~26 instances)
  const stoneSpots: Array<{ x: number; z: number; scale: number; rot: number }> = [];
  let stoneAttempts = 0;
  while (stoneSpots.length < 26 && stoneAttempts < 2000) {
    stoneAttempts++;
    const x = (rand() * 2 - 1) * 34;
    const z = -24 + rand() * 42;
    if (isInsideApronOrWalkways(x, z, 0.45)) continue;
    if (stoneSpots.some((other) => Math.hypot(other.x - x, other.z - z) < 2.0)) continue;
    stoneSpots.push({
      x,
      z,
      scale: 0.55 + rand() * 0.75,
      rot: rand() * Math.PI * 2
    });
  }

  const stoneGeo = new THREE.DodecahedronGeometry(0.45, 0);
  stoneGeo.translate(0, 0.2, 0);
  const stonesMesh = new THREE.InstancedMesh(stoneGeo, stoneMat, stoneSpots.length);
  stonesMesh.castShadow = true;
  stonesMesh.receiveShadow = true;
  for (let i = 0; i < stoneSpots.length; i++) {
    const st = stoneSpots[i];
    dummy.position.set(st.x, getMeadowHeight(st.x, st.z) - 0.05, st.z);
    dummy.rotation.set(0, st.rot, 0);
    dummy.scale.set(st.scale, st.scale * 0.52, st.scale * 0.85);
    dummy.updateMatrix();
    stonesMesh.setMatrixAt(i, dummy.matrix);
  }
  stonesMesh.instanceMatrix.needsUpdate = true;
  group.add(stonesMesh);

  return {
    group,
    setTheme(theme, palette) {
      const nextGrassTex = createGrassFieldTexture(theme);
      groundMat.map = nextGrassTex;
      groundMat.needsUpdate = true;
      grassTex.dispose();
      grassTex = nextGrassTex;

      apronMat.color.setHex(palette.apron);
      trunkMat.color.setHex(palette.treeTrunk);
      canopyMat.color.setHex(palette.treeCanopy);
      canopyAltMat.color.setHex(palette.treeCanopyAlt);
      stoneMat.color.setHex(palette.stone);
      applyTuftColors(palette);
    },
    dispose() {
      grassTex.dispose();
    }
  };
}
