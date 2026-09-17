// Original placeholder starfighters built from primitives. A presentation pack can replace any of
// them with a glTF model; these keep the engine repo free of third-party designs.
import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';

export interface Palette { hull: Color3; trim: Color3; glow: Color3 }
export const PALETTES: Record<string, Palette> = {
  coalition: { hull: new Color3(0.78, 0.76, 0.72), trim: new Color3(0.75, 0.2, 0.12), glow: new Color3(1.0, 0.45, 0.25) },
  dominion: { hull: new Color3(0.22, 0.24, 0.28), trim: new Color3(0.1, 0.1, 0.12), glow: new Color3(0.3, 1.0, 0.55) },
};

function mat(scene: Scene, name: string, color: Color3, emissive?: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color; m.specularColor = new Color3(0.25, 0.25, 0.28); m.specularPower = 48;
  if (emissive) { m.emissiveColor = emissive; m.diffuseColor = Color3.Black(); }
  return m;
}

/** Builds a ship pointing +Z, roughly 5 units long, centred on the origin. */
export function buildPlaceholderShip(scene: Scene, key: string, faction: string): TransformNode {
  const root = new TransformNode(`ship-${key}`, scene);
  const pal = PALETTES[faction] ?? PALETTES.coalition;
  const hull = mat(scene, 'hull', pal.hull), trim = mat(scene, 'trim', pal.trim), glow = mat(scene, 'glow', pal.hull, pal.glow);
  const canopy = mat(scene, 'canopy', new Color3(0.05, 0.08, 0.12)); canopy.specularPower = 128; canopy.specularColor = new Color3(0.8, 0.9, 1);
  const add = (m: Mesh, material: StandardMaterial, pos: [number, number, number], rot?: [number, number, number]) => {
    m.material = material; m.position = new Vector3(...pos); if (rot) m.rotation = new Vector3(...rot); m.parent = root; return m;
  };
  const engine = (x: number, y: number, z: number, d = 0.5) => {
    add(MeshBuilder.CreateCylinder('eng', { diameter: d, height: 1.4, tessellation: 12 }, scene), trim, [x, y, z], [Math.PI / 2, 0, 0]);
    const g = add(MeshBuilder.CreateCylinder('engGlow', { diameterTop: d * 0.8, diameterBottom: d * 0.3, height: 0.5, tessellation: 12 }, scene), glow, [x, y, z - 0.85], [Math.PI / 2, 0, 0]);
    g.metadata = { engine: true };
  };

  switch (key) {
    case 'lancer': {
      add(MeshBuilder.CreateCylinder('fus', { diameterTop: 0.25, diameterBottom: 0.9, height: 4.6, tessellation: 8 }, scene), hull, [0, 0, 0.3], [Math.PI / 2, 0, 0]);
      add(MeshBuilder.CreateSphere('can', { diameterX: 0.55, diameterY: 0.5, diameterZ: 1.2, segments: 8 }, scene), canopy, [0, 0.3, -0.1]);
      for (const sx of [-1, 1]) {
        const w = add(MeshBuilder.CreateBox('wing', { width: 2.4, height: 0.08, depth: 1.5 }, scene), hull, [sx * 1.5, 0, -1.2], [0, sx * -0.35, sx * 0.12]);
        w.scaling.z = 0.9;
        add(MeshBuilder.CreateBox('stripe', { width: 0.5, height: 0.1, depth: 1.3 }, scene), trim, [sx * 1.9, 0.03, -1.35], [0, sx * -0.35, sx * 0.12]);
        add(MeshBuilder.CreateCylinder('gun', { diameter: 0.09, height: 2.4 }, scene), trim, [sx * 2.6, 0.12, -0.6], [Math.PI / 2, 0, 0]);
        engine(sx * 0.62, 0.05, -1.7);
      }
      break;
    }
    case 'bulwark': {
      add(MeshBuilder.CreateBox('body', { width: 1.5, height: 0.7, depth: 3.2 }, scene), hull, [0, 0, 0.4]);
      add(MeshBuilder.CreateBox('nose', { width: 1.1, height: 0.5, depth: 1.2 }, scene), trim, [0, 0.02, 2.2]);
      add(MeshBuilder.CreateSphere('can', { diameterX: 0.7, diameterY: 0.45, diameterZ: 1.0, segments: 8 }, scene), canopy, [0, 0.42, 1.5]);
      add(MeshBuilder.CreateSphere('turret', { diameter: 0.7, segments: 8 }, scene), trim, [0, 0.5, 0]);
      add(MeshBuilder.CreateCylinder('tgun', { diameter: 0.1, height: 1.1 }, scene), trim, [0, 0.62, 0.55], [Math.PI / 2, 0, 0]);
      for (const sx of [-1, 1]) {
        add(MeshBuilder.CreateBox('pylon', { width: 1.2, height: 0.12, depth: 0.7 }, scene), hull, [sx * 1.2, 0, -0.6]);
        add(MeshBuilder.CreateCylinder('nacelle', { diameter: 0.6, height: 3.4, tessellation: 10 }, scene), hull, [sx * 1.9, 0, -0.9], [Math.PI / 2, 0, 0]);
        engine(sx * 1.9, 0, -2.4, 0.55);
      }
      break;
    }
    case 'dart': {
      add(MeshBuilder.CreatePolyhedron('pod', { type: 1, size: 0.62 }, scene), hull, [0, 0, 0.2]);
      add(MeshBuilder.CreateSphere('eye', { diameter: 0.55, segments: 8 }, scene), canopy, [0, 0, 0.62]);
      for (const sx of [-1, 1]) {
        add(MeshBuilder.CreateBox('strut', { width: 1.0, height: 0.16, depth: 0.3 }, scene), hull, [sx * 0.95, 0, 0]);
        add(MeshBuilder.CreateCylinder('blade', { diameter: 3.0, height: 0.08, tessellation: 3 }, scene), trim, [sx * 1.5, 0, 0.1], [0, 0, Math.PI / 2]);
        add(MeshBuilder.CreateCylinder('bladeRim', { diameter: 3.15, height: 0.04, tessellation: 3 }, scene), hull, [sx * 1.53, 0, 0.1], [0, 0, Math.PI / 2]);
      }
      engine(0, 0, -0.55, 0.4);
      break;
    }
    default: { // stiletto
      add(MeshBuilder.CreateCylinder('fus', { diameterTop: 0.15, diameterBottom: 0.8, height: 4.2, tessellation: 6 }, scene), hull, [0, 0, 0.4], [Math.PI / 2, 0, 0]);
      add(MeshBuilder.CreateSphere('can', { diameterX: 0.5, diameterY: 0.4, diameterZ: 1.0, segments: 8 }, scene), canopy, [0, 0.25, 0.3]);
      for (const sx of [-1, 1]) {
        add(MeshBuilder.CreateBox('wingIn', { width: 1.3, height: 0.1, depth: 1.6 }, scene), hull, [sx * 0.9, 0.1, -1.0], [0, sx * -0.5, sx * 0.35]);
        add(MeshBuilder.CreateBox('wingOut', { width: 0.1, height: 1.6, depth: 2.2 }, scene), trim, [sx * 1.6, -0.1, -0.9], [0, sx * -0.15, sx * -0.3]);
        engine(sx * 0.35, 0, -1.8, 0.4);
      }
      break;
    }
  }
  return root;
}
