import * as THREE from 'three';
import type { Conduit, ConduitKey } from './conduits';
import type { StageId } from '../types/pipeline';
import type { StationRig } from './stations';

interface ActivePacket {
  conduitKey: ConduitKey;
  targetStage: StageId;
  progress: number;
  durationSec: number;
  mesh: THREE.Mesh;
  halo: THREE.Sprite;
  trail: THREE.Mesh[];
}

export class PacketSystem {
  private group: THREE.Group;
  private glowTexture: THREE.CanvasTexture;
  private conduits: Map<ConduitKey, Conduit>;
  private stations: Map<StageId, StationRig>;
  private active: ActivePacket[] = [];
  private sphereGeo = new THREE.SphereGeometry(0.16, 16, 16);
  private trailGeo = new THREE.SphereGeometry(0.075, 10, 10);

  constructor(
    root: THREE.Group,
    glowTexture: THREE.CanvasTexture,
    conduits: Map<ConduitKey, Conduit>,
    stations: Map<StageId, StationRig>
  ) {
    this.group = new THREE.Group();
    root.add(this.group);
    this.glowTexture = glowTexture;
    this.conduits = conduits;
    this.stations = stations;
  }

  spawn(
    conduitKey: ConduitKey,
    targetStage: StageId,
    colorHex: number,
    durationSec = 0.48,
    reducedMotion = false
  ) {
    const conduit = this.conduits.get(conduitKey);
    if (!conduit) return;
    conduit.energy = 1;
    conduit.accentHex = colorHex;
    conduit.material.emissive.setHex(colorHex);

    if (reducedMotion) {
      this.stations.get(targetStage)?.triggerArrivalPulse();
      return;
    }

    const mat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 1.4,
      roughness: 0.2,
      metalness: 0.1
    });
    const mesh = new THREE.Mesh(this.sphereGeo, mat);

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: colorHex,
        transparent: true,
        opacity: 0.76,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    halo.scale.set(1.0, 1.0, 1);
    mesh.add(halo);

    const trail: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const tMat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.48 - i * 0.12
      });
      const tMesh = new THREE.Mesh(this.trailGeo, tMat);
      this.group.add(tMesh);
      trail.push(tMesh);
    }

    const startPoint = conduit.curve.getPointAt(0);
    mesh.position.copy(startPoint);
    trail.forEach((t) => t.position.copy(startPoint));
    this.group.add(mesh);

    this.active.push({
      conduitKey,
      targetStage,
      progress: 0,
      durationSec: Math.max(0.18, durationSec),
      mesh,
      halo,
      trail
    });
  }

  update(dt: number) {
    for (const conduit of this.conduits.values()) {
      if (conduit.energy > 0) {
        conduit.energy = Math.max(0, conduit.energy - dt * 1.45);
        conduit.material.emissiveIntensity = 0.08 + conduit.energy * 0.92;
        conduit.material.opacity = 0.78 + conduit.energy * 0.22;
      }
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      const conduit = this.conduits.get(p.conduitKey);
      if (!conduit) {
        this.disposePacket(p);
        this.active.splice(i, 1);
        continue;
      }

      p.progress = Math.min(1, p.progress + dt / p.durationSec);
      const eased = 1 - Math.pow(1 - p.progress, 2.2);
      const point = conduit.curve.getPointAt(eased);
      p.mesh.position.copy(point);
      p.mesh.position.y += 0.12;

      p.trail.forEach((tMesh, idx) => {
        const trailT = Math.max(0, eased - (idx + 1) * 0.055);
        tMesh.position.copy(conduit.curve.getPointAt(trailT));
        tMesh.position.y += 0.12;
      });

      if (p.progress >= 1) {
        this.stations.get(p.targetStage)?.triggerArrivalPulse();
        this.disposePacket(p);
        this.active.splice(i, 1);
      }
    }
  }

  clear() {
    for (const p of this.active) {
      this.disposePacket(p);
    }
    this.active = [];
    for (const conduit of this.conduits.values()) {
      conduit.energy = 0;
      conduit.material.emissiveIntensity = 0.08;
      conduit.material.opacity = 0.78;
    }
  }

  private disposePacket(p: ActivePacket) {
    this.group.remove(p.mesh);
    (p.mesh.material as THREE.Material).dispose();
    p.halo.material.dispose();
    p.trail.forEach((t) => {
      this.group.remove(t);
      (t.material as THREE.Material).dispose();
    });
  }

  dispose() {
    this.clear();
    this.sphereGeo.dispose();
    this.trailGeo.dispose();
  }
}
