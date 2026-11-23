import * as THREE from 'three';
import type { ThemeMode } from '../types/pipeline';

export interface SceneThemePalette {
  background: number;
  floorOuter: number;
  floorTile: number;
  floorTrim: number;
  corridor: number;
  wall: number;
  wallWood: number;
  glassWall: number;
  mullion: number;
  deskTop: number;
  deskFrame: number;
  chair: number;
  rack: number;
  monitorFrame: number;
  monitorScreen: number;
  plantPot: number;
  plantLeaf: number;
  ceilingLight: number;
  conduitIdle: number;
  grassBase: number;
  grassMid: number;
  grassHighlight: number;
  apron: number;
  treeTrunk: number;
  treeCanopy: number;
  treeCanopyAlt: number;
  stone: number;
  terrace: number;
  water: number;
  waterBed: number;
  zoneTech: number;
  zoneWarm: number;
  zoneStudio: number;
  roofMetal: number;
  loungeFabric: number;
  archLight: number;
  warmLight: number;
  emerald: number;
  amber: number;
  coral: number;
  pearl: number;
  gold: number;
  ambientIntensity: number;
  hemiIntensity: number;
  keyIntensity: number;
  rimIntensity: number;
}

export const SCENE_THEMES: Record<ThemeMode, SceneThemePalette> = {
  dark: {
    background: 0x0b0e11,
    floorOuter: 0x0e1318,
    floorTile: 0x1a222b,
    floorTrim: 0x2c3846,
    corridor: 0x222c37,
    wall: 0x161d24,
    wallWood: 0x4b382a,
    glassWall: 0x6b8aa6,
    mullion: 0x3b4958,
    deskTop: 0x27313d,
    deskFrame: 0x181f27,
    chair: 0x212933,
    rack: 0x131920,
    monitorFrame: 0x0f141a,
    monitorScreen: 0x1f3644,
    plantPot: 0x2a333d,
    plantLeaf: 0x246b45,
    ceilingLight: 0xdbe7f3,
    conduitIdle: 0x324252,
    grassBase: 0x162b1f,
    grassMid: 0x1f3d2a,
    grassHighlight: 0x2b5237,
    apron: 0x1c252f,
    treeTrunk: 0x3a2c22,
    treeCanopy: 0x1d4a31,
    treeCanopyAlt: 0x275f3f,
    stone: 0x384552,
    terrace: 0x1b232d,
    water: 0x0d2b38,
    waterBed: 0x09161d,
    zoneTech: 0x131a22,
    zoneWarm: 0x201d1c,
    zoneStudio: 0x161920,
    roofMetal: 0x242f3b,
    loungeFabric: 0x2a3644,
    archLight: 0x9fe7c8,
    warmLight: 0xf6d399,
    emerald: 0x25d366,
    amber: 0xf5a524,
    coral: 0xf87171,
    pearl: 0xdbe7f3,
    gold: 0xfbbf24,
    ambientIntensity: 0.72,
    hemiIntensity: 0.55,
    keyIntensity: 2.05,
    rimIntensity: 0.9
  },
  light: {
    background: 0xeaf0f6,
    floorOuter: 0xdce4ed,
    floorTile: 0xf4f7fa,
    floorTrim: 0xb6c4d2,
    corridor: 0xe2e9f1,
    wall: 0xf8fafc,
    wallWood: 0xb68d65,
    glassWall: 0x94b2cc,
    mullion: 0x7b8ea1,
    deskTop: 0xe6ddd2,
    deskFrame: 0x475569,
    chair: 0x4b5563,
    rack: 0x2d3748,
    monitorFrame: 0x1e293b,
    monitorScreen: 0x2c4a5e,
    plantPot: 0xcbd5e1,
    plantLeaf: 0x2e8555,
    ceilingLight: 0xffffff,
    conduitIdle: 0x94a3b8,
    grassBase: 0x639c52,
    grassMid: 0x75b062,
    grassHighlight: 0x8ec473,
    apron: 0xcbd5e1,
    treeTrunk: 0x6b4f3a,
    treeCanopy: 0x3b7a46,
    treeCanopyAlt: 0x4c9154,
    stone: 0x94a3b8,
    terrace: 0xd4dde7,
    water: 0x5b9ab5,
    waterBed: 0x2f5f75,
    zoneTech: 0xe4ebf3,
    zoneWarm: 0xede8e1,
    zoneStudio: 0xe7ecf2,
    roofMetal: 0xc2cedb,
    loungeFabric: 0x64748b,
    archLight: 0xffffff,
    warmLight: 0xfff4d6,
    emerald: 0x0e7a38,
    amber: 0xc26d00,
    coral: 0xc92a2a,
    pearl: 0x334155,
    gold: 0xb45309,
    ambientIntensity: 0.95,
    hemiIntensity: 0.72,
    keyIntensity: 1.85,
    rimIntensity: 0.75
  }
};

export function createRadialGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.28, 'rgba(255, 255, 255, 0.55)');
    grad.addColorStop(0.65, 'rgba(255, 255, 255, 0.14)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function createFloorTileTexture(theme: ThemeMode): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    let seed = theme === 'dark' ? 9123 : 18421;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const baseFill = theme === 'dark' ? '#171f28' : '#eef3f8';
    const tileShades = theme === 'dark'
      ? ['#19222b', '#1b242e', '#161e26']
      : ['#f4f7fb', '#edf2f7', '#f0f5fa'];
    const seamDark = theme === 'dark' ? '#0f151b' : '#cbd6e2';
    const seamHighlight = theme === 'dark' ? 'rgba(159, 231, 200, 0.05)' : 'rgba(255, 255, 255, 0.6)';

    ctx.fillStyle = baseFill;
    ctx.fillRect(0, 0, size, size);

    // 4x4 large-format architectural terrazzo/stone slabs with subtle tonal variation
    const step = 128;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        ctx.fillStyle = tileShades[(row * 3 + col) % tileShades.length];
        ctx.fillRect(col * step + 2, row * step + 2, step - 4, step - 4);
      }
    }

    // Subtle stone/terrazzo micro-speckle grain
    for (let i = 0; i < 1100; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 0.7 + rand() * 1.4;
      ctx.fillStyle = i % 2 === 0
        ? (theme === 'dark' ? 'rgba(255, 255, 255, 0.045)' : 'rgba(15, 23, 42, 0.045)')
        : (theme === 'dark' ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.35)');
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bevelled architectural tile seams
    for (let i = 0; i <= size; i += step) {
      ctx.strokeStyle = seamDark;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, size);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
      ctx.stroke();

      ctx.strokeStyle = seamHighlight;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(i + 2, 0);
      ctx.lineTo(i + 2, size);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, i + 2);
      ctx.lineTo(size, i + 2);
      ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(8, 5);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

export function createFloorBadgeTexture(num: number, title: string, theme: ThemeMode): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = theme === 'dark' ? '#111820' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = theme === 'dark' ? '#46586b' : '#94a3b8';
    ctx.lineWidth = 4;
    ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);

    ctx.fillStyle = theme === 'dark' ? '#25D366' : '#0E7A38';
    ctx.fillRect(10, 12, 54, 56);

    ctx.fillStyle = theme === 'dark' ? '#07120B' : '#ffffff';
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num).padStart(2, '0'), 37, 42);

    ctx.fillStyle = theme === 'dark' ? '#EEF2F5' : '#111820';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(title.toUpperCase(), 78, 42);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createWallSignTexture(theme: ThemeMode): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 144;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
    if (theme === 'dark') {
      grad.addColorStop(0, '#0f161e');
      grad.addColorStop(0.5, '#15202b');
      grad.addColorStop(1, '#0f161e');
    } else {
      grad.addColorStop(0, '#182230');
      grad.addColorStop(0.5, '#1f2d3f');
      grad.addColorStop(1, '#182230');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Outer architectural metallic frame + top/bottom trim hairlines
    ctx.strokeStyle = theme === 'dark' ? '#25D366' : '#34d399';
    ctx.lineWidth = 3;
    ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);

    ctx.strokeStyle = 'rgba(238, 242, 245, 0.16)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);

    // Structural architectural tick marks on left & right wings
    ctx.fillStyle = theme === 'dark' ? 'rgba(37, 211, 102, 0.5)' : 'rgba(52, 211, 153, 0.6)';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(canvas.width - 36 - i * 12, 28, 5, 16);
      ctx.fillRect(canvas.width - 36 - i * 12, canvas.height - 44, 5, 16);
    }

    // Status beacon ring + dot
    ctx.strokeStyle = 'rgba(37, 211, 102, 0.45)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(58, 72, 20, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#25D366';
    ctx.beginPath();
    ctx.arc(58, 72, 11, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#EEF2F5';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('BUBU AI  |  MODERN TECH WHATSAPP ENGINE', 98, 74, canvas.width - 180);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export function createGrassFieldTexture(theme: ThemeMode): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    let seed = theme === 'dark' ? 41927 : 73153;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const baseColor = theme === 'dark' ? '#162b1f' : '#659e54';
    const patchColors = theme === 'dark'
      ? ['#1d3927', '#264933', '#122319']
      : ['#74ae60', '#558b46', '#85be6c'];
    const bladeColors = theme === 'dark'
      ? ['rgba(43, 82, 55, 0.34)', 'rgba(18, 35, 25, 0.34)']
      : ['rgba(142, 196, 115, 0.38)', 'rgba(72, 124, 58, 0.30)'];

    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, size, size);

    // Organic mottled grass patches wrapped cleanly across tile borders
    for (let i = 0; i < 140; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const rx = 16 + rand() * 44;
      const ry = 12 + rand() * 34;
      const rot = rand() * Math.PI;
      ctx.fillStyle = patchColors[i % patchColors.length];
      ctx.globalAlpha = 0.24 + rand() * 0.22;
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          if (x + ox < -rx || x + ox > size + rx || y + oy < -ry || y + oy > size + ry) continue;
          ctx.beginPath();
          ctx.ellipse(x + ox, y + oy, rx, ry, rot, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Fine directional grass-blade strokes for surface micro-texture
    ctx.lineCap = 'round';
    for (let i = 0; i < 1600; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const len = 4 + rand() * 8;
      const tilt = (rand() - 0.5) * 4;
      ctx.strokeStyle = bladeColors[i % bladeColors.length];
      ctx.lineWidth = 1 + rand() * 1.1;
      ctx.globalAlpha = 0.42 + rand() * 0.35;
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          if (x + ox < -12 || x + ox > size + 12 || y + oy < -12 || y + oy > size + 12) continue;
          ctx.beginPath();
          ctx.moveTo(x + ox, y + oy);
          ctx.lineTo(x + ox + tilt, y + oy - len);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(28, 28);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

export function getTierColorHex(tier: string | undefined, palette: SceneThemePalette): number {
  switch (String(tier || '').toLowerCase()) {
    case 'fast':
      return palette.emerald;
    case 'reasoning':
      return palette.gold;
    case 'summary':
      return palette.pearl;
    case 'balanced':
    case 'coding':
    case 'vision':
    default:
      return palette.amber;
  }
}
