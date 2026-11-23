import * as THREE from 'three';
import { STAGE_BY_ID, TOOL_DOMAIN_NODES } from '../data/stages';
import type { SceneThemePalette } from './materials';

export type ConduitKey =
  | 'ingress->queue'
  | 'queue->gate'
  | 'gate->ingress'
  | 'gate->multimodal'
  | 'multimodal->context'
  | 'gate->context'
  | 'context->llm'
  | 'llm->tools'
  | 'tools->llm'
  | 'llm->delivery'
  | 'delivery->context'
  | `tools->sat:${string}`;

export interface Conduit {
  key: ConduitKey;
  curve: THREE.CatmullRomCurve3;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  energy: number;
  accentHex: number;
}

export function createConduits(root: THREE.Group, palette: SceneThemePalette): Map<ConduitKey, Conduit> {
  const map = new Map<ConduitKey, Conduit>();

  const pos = (id: keyof typeof STAGE_BY_ID, y = 0.08, dx = 0, dz = 0) => {
    const p = STAGE_BY_ID[id].position3D;
    return new THREE.Vector3(p[0] + dx, y, p[2] + dz);
  };

  // Neat architectural floor fiber-optic conduits routed cleanly along bays and central corridor
  const specs: Array<{ key: ConduitKey; points: THREE.Vector3[]; radius?: number; color: number }> = [
    // Back Row Left -> Right: 01 -> 02 -> 03 -> 04
    {
      key: 'ingress->queue',
      points: [pos('ingress', 0.12, 1.4, 0.2), pos('ingress', 0.08, 2.5, 0.5), pos('queue', 0.12, -1.4, 0.2)],
      color: palette.emerald
    },
    {
      key: 'queue->gate',
      points: [pos('queue', 0.12, 1.4, 0.2), pos('queue', 0.08, 2.5, 0.5), pos('gate', 0.12, -1.4, 0.2)],
      color: palette.emerald
    },
    {
      key: 'gate->ingress',
      points: [pos('gate', 0.1, 0, -1.5), new THREE.Vector3(-2.5, 0.08, -5.5), pos('ingress', 0.1, 0, -1.5)],
      radius: 0.022,
      color: palette.emerald
    },
    {
      key: 'gate->multimodal',
      points: [pos('gate', 0.12, 1.4, 0.2), pos('gate', 0.08, 2.5, 0.5), pos('multimodal', 0.12, -1.4, 0.2)],
      color: palette.amber
    },
    // Media branch down through central corridor to 05 Memori
    {
      key: 'multimodal->context',
      points: [
        pos('multimodal', 0.14, 0, 1.5),
        new THREE.Vector3(7.5, 0.08, -0.35),
        new THREE.Vector3(0.0, 0.08, -0.35),
        new THREE.Vector3(-7.5, 0.08, -0.35),
        pos('context', 0.14, 0, -1.5)
      ],
      color: palette.amber
    },
    // Direct text bypass: 03 -> central corridor -> 05
    {
      key: 'gate->context',
      points: [
        pos('gate', 0.12, 0, 1.5),
        new THREE.Vector3(2.5, 0.08, 0.15),
        new THREE.Vector3(-7.5, 0.08, 0.15),
        pos('context', 0.14, 0, -1.5)
      ],
      color: palette.emerald
    },
    // Front Row Left -> Right: 05 -> 06 -> 07 -> 08
    {
      key: 'context->llm',
      points: [pos('context', 0.14, 1.4, -0.2), pos('context', 0.08, 2.5, -0.5), pos('llm', 0.2, -1.4, -0.2)],
      color: palette.amber
    },
    {
      key: 'llm->tools',
      points: [pos('llm', 0.2, 1.4, -0.15), pos('llm', 0.08, 2.5, -0.35), pos('tools', 0.14, -1.4, -0.15)],
      color: palette.amber
    },
    {
      key: 'tools->llm',
      points: [pos('tools', 0.14, -1.4, 0.35), pos('llm', 0.08, 2.5, 0.6), pos('llm', 0.2, 1.4, 0.35)],
      radius: 0.024,
      color: palette.amber
    },
    // 06 Inti AI -> 08 Kirim WA bypassing cleanly along south corridor edge
    {
      key: 'llm->delivery',
      points: [
        pos('llm', 0.2, 1.2, -1.35),
        new THREE.Vector3(-1.0, 0.08, 1.35),
        new THREE.Vector3(5.6, 0.08, 1.35),
        pos('delivery', 0.14, -1.2, -1.1)
      ],
      color: palette.emerald
    },
    // Post-turn memory capture filament from 08 back to 05 along outer front walkway
    {
      key: 'delivery->context',
      points: [
        pos('delivery', 0.1, 0, 1.6),
        new THREE.Vector3(5.0, 0.08, 5.45),
        new THREE.Vector3(-5.0, 0.08, 5.45),
        pos('context', 0.1, 0, 1.6)
      ],
      radius: 0.024,
      color: palette.amber
    }
  ];

  // Hub -> 5 Tool Pod desks inside Bay 07
  const toolHub = pos('tools', 0.42);
  for (const sat of TOOL_DOMAIN_NODES) {
    const satTarget = new THREE.Vector3(
      STAGE_BY_ID.tools.position3D[0] + sat.offset[0],
      0.42,
      STAGE_BY_ID.tools.position3D[2] + sat.offset[2]
    );
    specs.push({
      key: `tools->sat:${sat.id}`,
      points: [toolHub, toolHub.clone().lerp(satTarget, 0.5).setY(0.28), satTarget],
      radius: 0.022,
      color: palette.amber
    });
  }

  for (const spec of specs) {
    const curve = new THREE.CatmullRomCurve3(spec.points);
    const geo = new THREE.TubeGeometry(curve, 36, spec.radius || 0.036, 8, false);
    const material = new THREE.MeshStandardMaterial({
      color: palette.conduitIdle,
      emissive: spec.color,
      emissiveIntensity: 0.08,
      roughness: 0.35,
      metalness: 0.5,
      transparent: true,
      opacity: 0.78
    });
    const mesh = new THREE.Mesh(geo, material);
    root.add(mesh);
    map.set(spec.key, {
      key: spec.key,
      curve,
      mesh,
      material,
      energy: 0,
      accentHex: spec.color
    });
  }

  return map;
}

export function setConduitsTheme(conduits: Map<ConduitKey, Conduit>, palette: SceneThemePalette) {
  for (const conduit of conduits.values()) {
    conduit.material.color.setHex(palette.conduitIdle);
    const isTransport =
      conduit.key === 'ingress->queue' ||
      conduit.key === 'queue->gate' ||
      conduit.key === 'gate->ingress' ||
      conduit.key === 'gate->context' ||
      conduit.key === 'llm->delivery';
    conduit.accentHex = isTransport ? palette.emerald : palette.amber;
    conduit.material.emissive.setHex(conduit.accentHex);
  }
}
