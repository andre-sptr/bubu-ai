import * as THREE from 'three';
import type { ThemeMode } from '../types/pipeline';
import {
  createFloorTileTexture,
  createWallSignTexture,
  type SceneThemePalette
} from './materials';
import { createMeadowEnvironment } from './meadowEnvironment';

export interface OfficeEnvironment {
  group: THREE.Group;
  setTheme: (theme: ThemeMode, palette: SceneThemePalette) => void;
  dispose: () => void;
}

function createModernPlanter(
  potMat: THREE.Material,
  trimMat: THREE.Material,
  leafMat: THREE.Material,
  altLeafMat: THREE.Material,
  x: number,
  y: number,
  z: number,
  w = 0.72,
  d = 0.72
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);

  const box = new THREE.Mesh(new THREE.BoxGeometry(w, 0.36, d), potMat);
  box.position.y = 0.18;
  box.castShadow = true;
  box.receiveShadow = true;
  g.add(box);

  const rim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, 0.05, d + 0.06), trimMat);
  rim.position.y = 0.38;
  rim.castShadow = true;
  g.add(rim);

  const leafConfigs: Array<[number, number, number, number, boolean]> = [
    [0, 0.66, 0, 0.28, false],
    [0.16, 0.54, 0.12, 0.21, true],
    [-0.16, 0.56, -0.1, 0.22, true],
    [0.08, 0.52, -0.16, 0.19, false]
  ];
  for (const [lx, ly, lz, r, useAlt] of leafConfigs) {
    const leaf = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), useAlt ? altLeafMat : leafMat);
    leaf.position.set(lx, ly, lz);
    leaf.castShadow = true;
    g.add(leaf);
  }
  return g;
}

function createBollard(
  frameMat: THREE.Material,
  lightMat: THREE.Material,
  x: number,
  y: number,
  z: number
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);

  const post = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.46, 0.11), frameMat);
  post.position.y = 0.23;
  post.castShadow = true;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.07, 0.13), lightMat);
  cap.position.y = 0.49;
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.14), frameMat);
  top.position.y = 0.54;
  g.add(post, cap, top);
  return g;
}

function createDiagonalStrut(
  from: [number, number, number],
  to: [number, number, number],
  radius: number,
  mat: THREE.Material
): THREE.Mesh {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const length = start.distanceTo(end);
  const geo = new THREE.CylinderGeometry(radius, radius, length, 8);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    end.clone().sub(start).normalize()
  );
  mesh.castShadow = true;
  return mesh;
}

export function createOfficeEnvironment(
  root: THREE.Group,
  initialTheme: ThemeMode,
  initialPalette: SceneThemePalette
): OfficeEnvironment {
  const group = new THREE.Group();
  root.add(group);

  const meadow = createMeadowEnvironment(group, initialTheme, initialPalette);

  let floorTex = createFloorTileTexture(initialTheme);
  let signTex = createWallSignTexture(initialTheme);

  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.78,
    metalness: 0.1
  });
  const terraceMat = new THREE.MeshStandardMaterial({
    color: initialPalette.terrace,
    roughness: 0.82,
    metalness: 0.12
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: initialPalette.floorTrim,
    roughness: 0.45,
    metalness: 0.48
  });
  const corridorMat = new THREE.MeshStandardMaterial({
    color: initialPalette.corridor,
    roughness: 0.72,
    metalness: 0.12
  });
  const zoneTechMat = new THREE.MeshStandardMaterial({
    color: initialPalette.zoneTech,
    roughness: 0.68,
    metalness: 0.16
  });
  const zoneWarmMat = new THREE.MeshStandardMaterial({
    color: initialPalette.zoneWarm,
    roughness: 0.76,
    metalness: 0.06
  });
  const zoneStudioMat = new THREE.MeshStandardMaterial({
    color: initialPalette.zoneStudio,
    roughness: 0.74,
    metalness: 0.12
  });
  const wallMat = new THREE.MeshStandardMaterial({
    color: initialPalette.wall,
    roughness: 0.78,
    metalness: 0.1
  });
  const woodMat = new THREE.MeshStandardMaterial({
    color: initialPalette.wallWood,
    roughness: 0.66,
    metalness: 0.06
  });
  const roofMetalMat = new THREE.MeshStandardMaterial({
    color: initialPalette.roofMetal,
    roughness: 0.38,
    metalness: 0.62
  });
  const mullionMat = new THREE.MeshStandardMaterial({
    color: initialPalette.mullion,
    roughness: 0.36,
    metalness: 0.68
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: initialPalette.glassWall,
    roughness: 0.1,
    metalness: 0.05,
    transparent: true,
    opacity: 0.24,
    ior: 1.48
  });
  const frostedBandMat = new THREE.MeshPhysicalMaterial({
    color: initialPalette.glassWall,
    roughness: 0.45,
    metalness: 0.05,
    transparent: true,
    opacity: 0.42,
    ior: 1.45
  });
  const racewayCoverMat = new THREE.MeshPhysicalMaterial({
    color: initialPalette.glassWall,
    roughness: 0.14,
    metalness: 0.08,
    transparent: true,
    opacity: 0.18,
    ior: 1.45
  });
  const waterMat = new THREE.MeshPhysicalMaterial({
    color: initialPalette.water,
    roughness: 0.08,
    metalness: 0.25,
    transparent: true,
    opacity: 0.86,
    ior: 1.33
  });
  const waterBedMat = new THREE.MeshStandardMaterial({
    color: initialPalette.waterBed,
    roughness: 0.9,
    metalness: 0.1
  });
  const signMat = new THREE.MeshStandardMaterial({
    map: signTex,
    emissive: 0xffffff,
    emissiveMap: signTex,
    emissiveIntensity: 0.52,
    roughness: 0.35
  });
  const ledMat = new THREE.MeshStandardMaterial({
    color: initialPalette.ceilingLight,
    emissive: initialPalette.ceilingLight,
    emissiveIntensity: 0.9,
    roughness: 0.2
  });
  const archLightMat = new THREE.MeshStandardMaterial({
    color: initialPalette.archLight,
    emissive: initialPalette.archLight,
    emissiveIntensity: 0.42,
    roughness: 0.25
  });
  const warmLightMat = new THREE.MeshStandardMaterial({
    color: initialPalette.warmLight,
    emissive: initialPalette.warmLight,
    emissiveIntensity: 0.72,
    roughness: 0.25
  });
  const potMat = new THREE.MeshStandardMaterial({
    color: initialPalette.plantPot,
    roughness: 0.6,
    metalness: 0.18
  });
  const leafMat = new THREE.MeshStandardMaterial({
    color: initialPalette.plantLeaf,
    roughness: 0.72,
    metalness: 0.04
  });
  const altLeafMat = new THREE.MeshStandardMaterial({
    color: initialPalette.treeCanopyAlt,
    roughness: 0.72,
    metalness: 0.04
  });
  const loungeFabricMat = new THREE.MeshStandardMaterial({
    color: initialPalette.loungeFabric,
    roughness: 0.85,
    metalness: 0.05
  });
  const solarMat = new THREE.MeshStandardMaterial({
    color: initialPalette.monitorScreen,
    roughness: 0.24,
    metalness: 0.65
  });

  // ===========================================================================
  // A. FUTURISTIC TWO-TIER EXTERIOR TERRACE, REFLECTING POOLS & PORTAL CANOPIES
  // ===========================================================================

  // Lower architectural terrace deck (top at -0.36, bottom at -0.52 embedded in meadow)
  const terraceDeck = new THREE.Mesh(new THREE.BoxGeometry(27.6, 0.16, 17.6), terraceMat);
  terraceDeck.position.set(0, -0.44, 0.2);
  terraceDeck.receiveShadow = true;
  group.add(terraceDeck);

  // Subtle brushed-metal perimeter fascia bands on lower terrace
  const frontFascia = new THREE.Mesh(new THREE.BoxGeometry(27.7, 0.06, 0.08), mullionMat);
  frontFascia.position.set(0, -0.39, 9.02);
  const backFascia = new THREE.Mesh(new THREE.BoxGeometry(27.7, 0.06, 0.08), mullionMat);
  backFascia.position.set(0, -0.39, -8.62);
  for (const side of [-1, 1]) {
    const sideFascia = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 17.7), mullionMat);
    sideFascia.position.set(side * 13.82, -0.39, 0.2);
    group.add(sideFascia);
  }
  group.add(frontFascia, backFascia);

  // Upper cantilevered office slab (top at y = 0.0, bottom at y = -0.36)
  const floorSlab = new THREE.Mesh(new THREE.BoxGeometry(24.6, 0.36, 14.2), floorMat);
  floorSlab.position.set(0, -0.18, -0.2);
  floorSlab.receiveShadow = true;
  floorSlab.castShadow = true;
  group.add(floorSlab);

  // Recessed shadow-gap under-plinth + crisp architectural rim accent lines
  const shadowPlinth = new THREE.Mesh(new THREE.BoxGeometry(24.2, 0.08, 13.8), roofMetalMat);
  shadowPlinth.position.set(0, -0.35, -0.2);
  shadowPlinth.receiveShadow = true;
  group.add(shadowPlinth);

  const southGlowL = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.028, 0.04), archLightMat);
  southGlowL.position.set(-7.3, -0.32, 6.89);
  const southGlowR = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.028, 0.04), archLightMat);
  southGlowR.position.set(7.3, -0.32, 6.89);
  group.add(southGlowL, southGlowR);
  for (const side of [-1, 1]) {
    const sideGlow = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.028, 13.6), archLightMat);
    sideGlow.position.set(side * 12.29, -0.32, -0.2);
    group.add(sideGlow);
  }

  // Twin Front Reflecting Pools flanking the central entrance bridge
  for (const px of [-6.85, 6.85]) {
    const poolGroup = new THREE.Group();
    poolGroup.position.set(px, 0, 7.95);

    const bed = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.04, 1.45), waterBedMat);
    bed.position.y = -0.355;
    bed.receiveShadow = true;
    const water = new THREE.Mesh(new THREE.BoxGeometry(8.3, 0.02, 1.28), waterMat);
    water.position.y = -0.325;

    // Sleek raised stone curbs around pool
    const curbFront = new THREE.Mesh(new THREE.BoxGeometry(8.64, 0.1, 0.14), terraceMat);
    curbFront.position.set(0, -0.31, 0.72);
    const curbBack = new THREE.Mesh(new THREE.BoxGeometry(8.64, 0.1, 0.14), terraceMat);
    curbBack.position.set(0, -0.31, -0.72);
    const curbL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 1.58), terraceMat);
    curbL.position.set(-4.25, -0.31, 0);
    const curbR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 1.58), terraceMat);
    curbR.position.set(4.25, -0.31, 0);
    poolGroup.add(bed, water, curbFront, curbBack, curbL, curbR);
    group.add(poolGroup);
  }

  // Central Front Entrance Bridge & Floating Steps (x = 0, z = 6.95..9.6)
  const entranceSteps: Array<[number, number, number, number]> = [
    [4.2, 0.08, 0.9, 7.35],
    [4.4, 0.08, 0.9, 8.22],
    [4.6, 0.08, 0.9, 9.10]
  ];
  const stepYs = [-0.04, -0.2, -0.37];
  entranceSteps.forEach(([w, h, d, z], idx) => {
    const tread = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), terraceMat);
    tread.position.set(0, stepYs[idx], z);
    tread.castShadow = true;
    tread.receiveShadow = true;
    const nosing = new THREE.Mesh(new THREE.BoxGeometry(w - 0.12, 0.022, 0.04), archLightMat);
    nosing.position.set(0, stepYs[idx] - 0.02, z + d / 2 - 0.01);
    group.add(tread, nosing);
  });
  for (const bx of [-2.45, 2.45]) {
    for (const bz of [8.2, 9.4]) {
      group.add(createBollard(mullionMat, warmLightMat, bx, -0.36, bz));
    }
  }

  // Left & Right Portal Walkways, Cantilevered Glass Canopies & Bollards
  for (const side of [-1, 1]) {
    const walkDeck = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.08, 2.8), terraceMat);
    walkDeck.position.set(side * 15.8, -0.44, -0.4);
    walkDeck.receiveShadow = true;
    group.add(walkDeck);

    // Cantilevered canopy frame + glazed skylight
    const canopyFrame = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 4.8), roofMetalMat);
    canopyFrame.position.set(side * 13.8, 2.86, -0.4);
    canopyFrame.castShadow = true;
    const canopyGlass = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.05, 4.0), glassMat);
    canopyGlass.position.set(side * 13.8, 2.87, -0.4);
    const canopyRim = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 4.6), archLightMat);
    canopyRim.position.set(side * 15.38, 2.82, -0.4);
    group.add(canopyFrame, canopyGlass, canopyRim);

    // Two angled V-column supports per canopy
    for (const cz of [-2.15, 1.35]) {
      const baseFoot = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.08, 0.32), mullionMat);
      baseFoot.position.set(side * 15.05, -0.36, cz);
      const strutA = createDiagonalStrut(
        [side * 15.05, -0.32, cz],
        [side * 15.1, 2.82, cz - 0.35],
        0.048,
        mullionMat
      );
      const strutB = createDiagonalStrut(
        [side * 15.05, -0.32, cz],
        [side * 15.1, 2.82, cz + 0.35],
        0.048,
        mullionMat
      );
      group.add(baseFoot, strutA, strutB);
    }

    for (const bx of [side * 16.4, side * 18.0]) {
      for (const bz of [-1.55, 0.75]) {
        group.add(createBollard(mullionMat, warmLightMat, bx, -0.4, bz));
      }
    }

    // Exterior architectural corner planter beds flanking the front reflecting pools
    group.add(createModernPlanter(potMat, trimMat, leafMat, altLeafMat, side * 12.4, -0.36, 7.95, 1.15, 1.15));
  }

  // ===========================================================================
  // B. FUTURISTIC BUILDING SHELL (PANORAMIC CURTAIN WALL, ROOF CROWN, RIBS)
  // ===========================================================================

  // Central back core wall (x in [-4.1, 4.1]) holding wood acoustic wings + HQ sign
  const centerBackWall = new THREE.Mesh(new THREE.BoxGeometry(8.2, 4.3, 0.28), wallMat);
  centerBackWall.position.set(0, 2.15, -7.1);
  centerBackWall.castShadow = true;
  centerBackWall.receiveShadow = true;
  group.add(centerBackWall);

  // Fluted vertical wood slat panels flanking the central HQ sign
  for (const side of [-1, 1]) {
    const baseX = side * 3.55;
    for (let i = -1; i <= 1; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.85, 0.08), woodMat);
      slat.position.set(baseX + i * 0.26, 2.02, -6.92);
      slat.castShadow = true;
      group.add(slat);
    }
    // Vertical glowing architectural pilasters framing central core
    const pilaster = new THREE.Mesh(new THREE.BoxGeometry(0.06, 3.85, 0.06), archLightMat);
    pilaster.position.set(side * 4.06, 2.02, -6.94);
    group.add(pilaster);
  }

  // Centered illuminated HQ Wall Sign
  const wallSign = new THREE.Mesh(new THREE.BoxGeometry(5.9, 0.9, 0.09), signMat);
  wallSign.position.set(0, 3.15, -6.9);
  group.add(wallSign);

  // Panoramic Floor-to-Ceiling Curtain-Wall Glass Wings on Left & Right back facade
  for (const side of [-1, 1]) {
    const wingCenterX = side * 7.95;
    const wingW = 7.3;

    // Low architectural sill wall (y = 0..0.68)
    const sill = new THREE.Mesh(new THREE.BoxGeometry(wingW, 0.68, 0.24), wallMat);
    sill.position.set(wingCenterX, 0.34, -7.1);
    sill.castShadow = true;
    sill.receiveShadow = true;

    // Transom header above curtain glass (y = 3.85..4.3)
    const header = new THREE.Mesh(new THREE.BoxGeometry(wingW, 0.45, 0.26), wallMat);
    header.position.set(wingCenterX, 4.075, -7.1);
    header.castShadow = true;

    // Tall clear panoramic glazing looking out into the rolling green meadow
    const curtainGlass = new THREE.Mesh(new THREE.BoxGeometry(wingW - 0.1, 3.17, 0.05), glassMat);
    curtainGlass.position.set(wingCenterX, 2.265, -7.08);

    // Outer solid corner pier + exterior brise-soleil fins
    const cornerPier = new THREE.Mesh(new THREE.BoxGeometry(0.84, 4.3, 0.32), wallMat);
    cornerPier.position.set(side * 11.9, 2.15, -7.1);
    cornerPier.castShadow = true;
    group.add(sill, header, curtainGlass, cornerPier);

    // Vertical aluminum curtain-wall mullions
    for (let mx = 4.3; mx <= 11.55; mx += 1.8) {
      const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.2, 0.14), mullionMat);
      mullion.position.set(side * mx, 2.27, -7.08);
      mullion.castShadow = true;
      group.add(mullion);
    }

    // Horizontal mid-transom bar
    const midBar = new THREE.Mesh(new THREE.BoxGeometry(wingW, 0.06, 0.12), mullionMat);
    midBar.position.set(wingCenterX, 3.12, -7.08);
    group.add(midBar);

    // Exterior architectural brise-soleil shading fins at outer back corner piers
    for (let f = 0; f < 4; f++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 3.8, 0.36), roofMetalMat);
      fin.position.set(side * (11.55 + f * 0.22), 2.1, -7.36);
      fin.castShadow = true;
      group.add(fin);
    }
  }

  // Cantilevered Metallic Roof Cornice Crown + Underside LED + Skylight Louver Fins
  const roofCornice = new THREE.Mesh(new THREE.BoxGeometry(26.2, 0.22, 2.2), roofMetalMat);
  roofCornice.position.set(0, 4.38, -6.55);
  roofCornice.castShadow = true;
  roofCornice.receiveShadow = true;
  group.add(roofCornice);

  const roofUnderglow = new THREE.Mesh(new THREE.BoxGeometry(25.2, 0.03, 0.05), archLightMat);
  roofUnderglow.position.set(0, 4.26, -5.52);
  group.add(roofUnderglow);

  // Sleek open skylight louver fins over rear gallery strip
  for (let lx = -9.0; lx <= 9.0; lx += 3.0) {
    const louver = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.06, 0.42), mullionMat);
    louver.position.set(lx, 4.5, -5.85);
    louver.rotation.x = 0.22;
    group.add(louver);
  }

  // 9 Parametric C-Frame Structural Exoskeleton Ribs along rear facade & roof crown
  for (let rx = -12; rx <= 12; rx += 3) {
    const vertRib = new THREE.Mesh(new THREE.BoxGeometry(0.14, 4.86, 0.28), roofMetalMat);
    vertRib.position.set(rx, 2.08, -7.34);
    vertRib.castShadow = true;
    const topRib = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 2.02), roofMetalMat);
    topRib.position.set(rx, 4.54, -6.48);
    topRib.castShadow = true;
    group.add(vertRib, topRib);
  }

  // Futuristic Rooftop Solar Wing & Comms Array centered on rear cornice
  const solarPod = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.12, 1.15), roofMetalMat);
  solarPod.position.set(0, 4.66, -7.05);
  solarPod.rotation.x = 0.16;
  const solarPanel = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.04, 0.96), solarMat);
  solarPanel.position.set(0, 4.71, -7.03);
  solarPanel.rotation.x = 0.16;
  const commsMast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.9, 8), mullionMat);
  commsMast.position.set(2.9, 4.92, -7.12);
  const mastBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10), archLightMat);
  mastBeacon.position.set(2.9, 5.38, -7.12);
  group.add(solarPod, solarPanel, commsMast, mastBeacon);

  // Side Curtain Walls & Glass Airlock Portals (x = +-12.12)
  for (const side of [-1, 1]) {
    const wx = side * 12.12;

    // South side wing (z = 1.6..6.85)
    const southDado = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.72, 5.25), wallMat);
    southDado.position.set(wx, 0.36, 4.22);
    southDado.castShadow = true;
    southDado.receiveShadow = true;
    const southGlass = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.86, 5.15), glassMat);
    southGlass.position.set(wx, 1.65, 4.22);
    const southLintel = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 5.3), roofMetalMat);
    southLintel.position.set(wx, 2.68, 4.22);

    // North side wing (z = -7.05..-2.25)
    const northDado = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.72, 4.8), wallMat);
    northDado.position.set(wx, 0.36, -4.65);
    northDado.castShadow = true;
    northDado.receiveShadow = true;
    const northGlass = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.86, 4.7), glassMat);
    northGlass.position.set(wx, 1.65, -4.65);
    const northLintel = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 4.85), roofMetalMat);
    northLintel.position.set(wx, 2.68, -4.65);

    // Glass Airlock Portal Header & Side Mullion Fins (z = -2.25..+1.6)
    const portalHeader = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.24, 3.95), roofMetalMat);
    portalHeader.position.set(wx, 2.68, -0.32);
    const portalTransom = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.38, 3.8), glassMat);
    portalTransom.position.set(wx, 2.38, -0.32);
    const portalStrip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 3.6), archLightMat);
    portalStrip.position.set(wx, 2.57, -0.32);
    group.add(
      southDado, southGlass, southLintel,
      northDado, northGlass, northLintel,
      portalHeader, portalTransom, portalStrip
    );

    for (const mz of [-2.25, 1.6, 4.22, 6.75, -4.65]) {
      const sidePost = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.74, 0.12), mullionMat);
      sidePost.position.set(wx, 1.37, mz);
      sidePost.castShadow = true;
      group.add(sidePost);
    }
  }

  // Front South Frameless Glass Balustrade (z = +6.82) flanking the open entrance bridge
  for (const side of [-1, 1]) {
    const railX = side * 7.18;
    const railW = 9.65;
    const railGlass = new THREE.Mesh(new THREE.BoxGeometry(railW, 0.42, 0.04), glassMat);
    railGlass.position.set(railX, 0.22, 6.82);
    const handrail = new THREE.Mesh(new THREE.BoxGeometry(railW + 0.08, 0.045, 0.08), mullionMat);
    handrail.position.set(railX, 0.44, 6.82);
    group.add(railGlass, handrail);

    for (const sx of [2.4, 5.6, 8.8, 11.95]) {
      const stanchion = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.46, 0.06), mullionMat);
      stanchion.position.set(side * sx, 0.23, 6.82);
      group.add(stanchion);
    }
  }

  // ===========================================================================
  // C. ROOM ZONING, FIBER CONCOURSE, MODULAR PARTITIONS & WING LOUNGES
  // ===========================================================================

  // Distinct Architectural Floor Inlays for all 8 functional rooms
  const roomInlayGeo = new THREE.BoxGeometry(4.4, 0.008, 4.0);
  const roomFloorSpecs: Array<{ x: number; z: number; mat: THREE.Material }> = [
    { x: -7.5, z: -3.4, mat: corridorMat },   // 01 Ingress (Lobby Terrazzo)
    { x: -2.5, z: -3.4, mat: zoneTechMat },   // 02 Antrean (Server Raised Access Floor)
    { x: 2.5, z: -3.4, mat: zoneTechMat },    // 03 Gerbang (Security Checkpoint Floor)
    { x: 7.5, z: -3.4, mat: zoneStudioMat },  // 04 Multimodal (Acoustic Lab Floor)
    { x: -7.5, z: 3.2, mat: zoneWarmMat },    // 05 Memori (Warm Timber Archive Floor)
    { x: 2.5, z: 3.2, mat: zoneTechMat },     // 07 Tools (Ops Pod Tech Floor)
    { x: 7.5, z: 3.2, mat: zoneStudioMat }    // 08 Kirim WA (Broadcast Studio Floor)
  ];
  for (const spec of roomFloorSpecs) {
    const inlay = new THREE.Mesh(roomInlayGeo, spec.mat);
    inlay.position.set(spec.x, 0.004, spec.z);
    inlay.receiveShadow = true;
    group.add(inlay);
  }

  // 06 Inti AI: Hero Executive Command Rotunda Circular Floor Pad + Brushed-Metal Ring
  const rotundaPad = new THREE.Mesh(new THREE.CylinderGeometry(2.14, 2.18, 0.008, 48), zoneTechMat);
  rotundaPad.position.set(-2.5, 0.004, 3.2);
  rotundaPad.receiveShadow = true;
  const rotundaRing = new THREE.Mesh(new THREE.RingGeometry(2.04, 2.15, 48), mullionMat);
  rotundaRing.rotation.x = -Math.PI / 2;
  rotundaRing.position.set(-2.5, 0.01, 3.2);
  group.add(rotundaPad, rotundaRing);

  // Central Concourse Boulevard & Recessed Fiber-Optic Glass Raceway Trough
  const corridor = new THREE.Mesh(new THREE.BoxGeometry(23.6, 0.008, 2.1), corridorMat);
  corridor.position.set(0, 0.004, -0.1);
  corridor.receiveShadow = true;
  const racewayBed = new THREE.Mesh(new THREE.BoxGeometry(22.4, 0.006, 0.82), zoneTechMat);
  racewayBed.position.set(0, 0.009, -0.1);
  racewayBed.receiveShadow = true;
  const racewayGlass = new THREE.Mesh(new THREE.BoxGeometry(22.2, 0.004, 0.76), racewayCoverMat);
  racewayGlass.position.set(0, 0.013, -0.1);
  const racewayTrimN = new THREE.Mesh(new THREE.BoxGeometry(22.5, 0.014, 0.05), mullionMat);
  racewayTrimN.position.set(0, 0.01, -0.52);
  const racewayTrimS = new THREE.Mesh(new THREE.BoxGeometry(22.5, 0.014, 0.05), mullionMat);
  racewayTrimS.position.set(0, 0.01, 0.32);
  group.add(corridor, racewayBed, racewayGlass, racewayTrimN, racewayTrimS);

  // Futuristic North Wing Partitions (Rooms 01-04) with 0.18 floor cable pass-through & overhead transom headers
  const partitionXs = [-5.0, 0.0, 5.0];
  for (const px of partitionXs) {
    // Glass pane suspended cleanly at y = 0.18..2.22 so floor conduits pass underneath without clipping
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.04, 4.9), glassMat);
    glass.position.set(px, 1.2, -4.18);
    const privacyBand = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.52, 4.86), frostedBandMat);
    privacyBand.position.set(px, 1.12, -4.18);
    const topRail = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 5.05), mullionMat);
    topRail.position.set(px, 2.26, -4.18);
    const bottomRail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 4.92), mullionMat);
    bottomRail.position.set(px, 0.19, -4.18);

    const postFront = new THREE.Mesh(new THREE.BoxGeometry(0.11, 2.42, 0.11), mullionMat);
    postFront.position.set(px, 1.21, -1.65);
    postFront.castShadow = true;
    const postRear = new THREE.Mesh(new THREE.BoxGeometry(0.11, 2.42, 0.11), mullionMat);
    postRear.position.set(px, 1.21, -6.72);
    postRear.castShadow = true;
    group.add(glass, privacyBand, topRail, bottomRail, postFront, postRear);
  }

  // Continuous Overhead Corridor Transom Beam framing North Wing Room Entrances (z = -1.65, y = 2.42)
  const transomBeam = new THREE.Mesh(new THREE.BoxGeometry(20.6, 0.16, 0.2), roofMetalMat);
  transomBeam.position.set(0, 2.42, -1.65);
  transomBeam.castShadow = true;
  group.add(transomBeam);
  for (const rx of [-7.5, -2.5, 2.5, 7.5]) {
    const portalLed = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.03, 0.06), archLightMat);
    portalLed.position.set(rx, 2.34, -1.56);
    group.add(portalLed);
  }

  // Futuristic South Wing Cantilevered Divider Consoles (Rooms 05-08)
  // Elevated beam leaves a 0.26m pass-through arch underneath so context->llm & llm<->tools conduits pass freely!
  for (const px of partitionXs) {
    const pedNorth = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.36, 0.36), mullionMat);
    pedNorth.position.set(px, 0.18, 1.75);
    pedNorth.castShadow = true;
    const pedSouth = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.36, 0.36), mullionMat);
    pedSouth.position.set(px, 0.18, 5.05);
    pedSouth.castShadow = true;

    const floatingConsole = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.22, 3.65), roofMetalMat);
    floatingConsole.position.set(px, 0.37, 3.4);
    floatingConsole.castShadow = true;
    floatingConsole.receiveShadow = true;

    const glassFin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.38, 3.55), glassMat);
    glassFin.position.set(px, 0.67, 3.4);
    const capRail = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.04, 3.68), mullionMat);
    capRail.position.set(px, 0.87, 3.4);

    group.add(pedNorth, pedSouth, floatingConsole, glassFin, capRail);
  }

  // Side-Wing Architectural Interior Furniture & Zoning (|x| in [10.0, 11.8], zero station overlap)
  // 1. West Arrival Lounge (x = -10.85, z = -4.2) + Welcome Monolith Totem
  const sofaBase = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.14, 2.4), mullionMat);
  sofaBase.position.set(-11.05, 0.07, -4.1);
  const sofaSeat = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.24, 2.3), loungeFabricMat);
  sofaSeat.position.set(-11.02, 0.26, -4.1);
  sofaSeat.castShadow = true;
  const sofaBack = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.42, 2.3), loungeFabricMat);
  sofaBack.position.set(-11.35, 0.56, -4.1);
  sofaBack.castShadow = true;
  const coffeeTableBase = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 0.34, 12), mullionMat);
  coffeeTableBase.position.set(-10.18, 0.17, -4.1);
  const coffeeTableTop = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.04, 20), glassMat);
  coffeeTableTop.position.set(-10.18, 0.36, -4.1);
  const westTotem = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.85, 0.48), roofMetalMat);
  westTotem.position.set(-11.35, 0.925, -5.95);
  westTotem.castShadow = true;
  const westTotemLed = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.5, 0.06), archLightMat);
  westTotemLed.position.set(-11.25, 0.95, -5.95);
  group.add(sofaBase, sofaSeat, sofaBack, coffeeTableBase, coffeeTableTop, westTotem, westTotemLed);

  // 2. West Archive Huddle Zone (x = -10.85, z = +3.5)
  const huddlePed = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.24, 0.66, 12), mullionMat);
  huddlePed.position.set(-10.85, 0.33, 3.5);
  const huddleTop = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.045, 24), glassMat);
  huddleTop.position.set(-10.85, 0.68, 3.5);
  const huddleRim = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.02, 8, 24), mullionMat);
  huddleRim.rotation.x = Math.PI / 2;
  huddleRim.position.set(-10.85, 0.68, 3.5);
  group.add(huddlePed, huddleTop, huddleRim);
  for (const [sx, sz] of [[-10.35, 2.78], [-11.32, 4.18]]) {
    const stoolBase = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.42, 10), loungeFabricMat);
    stoolBase.position.set(sx, 0.21, sz);
    stoolBase.castShadow = true;
    group.add(stoolBase);
  }

  // 3. East Acoustic Studio Wall Slats & Equipment Credenza (x = +11.0..+11.9, z = -4.4)
  for (let sz = -5.8; sz <= -2.6; sz += 0.4) {
    const eSlat = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.25, 0.14), woodMat);
    eSlat.position.set(11.92, 1.45, sz);
    group.add(eSlat);
  }
  const eastCredenza = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.82, 2.2), roofMetalMat);
  eastCredenza.position.set(11.05, 0.41, -4.4);
  eastCredenza.castShadow = true;
  eastCredenza.receiveShadow = true;
  const eastCredenzaTop = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.05, 2.24), woodMat);
  eastCredenzaTop.position.set(11.05, 0.84, -4.4);
  group.add(eastCredenza, eastCredenzaTop);

  // 4. East Broadcast Lounge Bench & Outbound Status Totem (x = +10.85, z = +3.5)
  const benchBase = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 2.1), mullionMat);
  benchBase.position.set(10.95, 0.06, 3.5);
  const benchCushion = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.28, 2.04), loungeFabricMat);
  benchCushion.position.set(10.95, 0.26, 3.5);
  benchCushion.castShadow = true;
  const eastTotem = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.85, 0.48), roofMetalMat);
  eastTotem.position.set(11.35, 0.925, 5.55);
  eastTotem.castShadow = true;
  const eastTotemLed = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.5, 0.06), archLightMat);
  eastTotemLed.position.set(11.25, 0.95, 5.55);
  group.add(benchBase, benchCushion, eastTotem, eastTotemLed);

  // Geometric Biophilic Indoor Planter Islands
  const interiorPlanterCoords: [number, number][] = [
    [-10.05, -6.25],
    [10.05, -6.25],
    [-10.05, 6.0],
    [10.05, 6.0],
    [-5.0, -1.35],
    [5.0, -1.35]
  ];
  for (const [px, pz] of interiorPlanterCoords) {
    group.add(createModernPlanter(potMat, trimMat, leafMat, altLeafMat, px, 0, pz));
  }

  // Suspended Architectural Ceiling Linear Luminaires over the 4 Back Bays
  for (const lx of [-7.5, -2.5, 2.5, 7.5]) {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.09, 0.2), roofMetalMat);
    housing.position.set(lx, 3.88, -4.4);
    const emitter = new THREE.Mesh(new THREE.BoxGeometry(2.74, 0.04, 0.12), ledMat);
    emitter.position.set(lx, 3.83, -4.4);
    group.add(housing, emitter);
    for (const dx of [-1.1, 1.1]) {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 6), mullionMat);
      rod.position.set(lx + dx, 4.14, -4.4);
      group.add(rod);
    }
  }

  return {
    group,
    setTheme(theme, palette) {
      const nextFloorTex = createFloorTileTexture(theme);
      const nextSignTex = createWallSignTexture(theme);

      floorMat.map = nextFloorTex;
      floorMat.needsUpdate = true;
      floorTex.dispose();
      floorTex = nextFloorTex;

      signMat.map = nextSignTex;
      signMat.emissiveMap = nextSignTex;
      signMat.needsUpdate = true;
      signTex.dispose();
      signTex = nextSignTex;

      terraceMat.color.setHex(palette.terrace);
      trimMat.color.setHex(palette.floorTrim);
      corridorMat.color.setHex(palette.corridor);
      zoneTechMat.color.setHex(palette.zoneTech);
      zoneWarmMat.color.setHex(palette.zoneWarm);
      zoneStudioMat.color.setHex(palette.zoneStudio);
      wallMat.color.setHex(palette.wall);
      woodMat.color.setHex(palette.wallWood);
      roofMetalMat.color.setHex(palette.roofMetal);
      mullionMat.color.setHex(palette.mullion);
      glassMat.color.setHex(palette.glassWall);
      frostedBandMat.color.setHex(palette.glassWall);
      racewayCoverMat.color.setHex(palette.glassWall);
      waterMat.color.setHex(palette.water);
      waterBedMat.color.setHex(palette.waterBed);
      ledMat.color.setHex(palette.ceilingLight);
      ledMat.emissive.setHex(palette.ceilingLight);
      archLightMat.color.setHex(palette.archLight);
      archLightMat.emissive.setHex(palette.archLight);
      warmLightMat.color.setHex(palette.warmLight);
      warmLightMat.emissive.setHex(palette.warmLight);
      potMat.color.setHex(palette.plantPot);
      leafMat.color.setHex(palette.plantLeaf);
      altLeafMat.color.setHex(palette.treeCanopyAlt);
      loungeFabricMat.color.setHex(palette.loungeFabric);
      solarMat.color.setHex(palette.monitorScreen);
      meadow.setTheme(theme, palette);
    },
    dispose() {
      floorTex.dispose();
      signTex.dispose();
      meadow.dispose();
    }
  };
}
