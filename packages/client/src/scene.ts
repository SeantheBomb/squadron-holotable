// 3D presentation of the tabletop state. Rules space is millimetres on (x, y); the scene uses
// 1 unit = 10 mm on (x, z). Nothing in here decides rules — it renders views and animates events.
import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, DynamicTexture, Engine, GlowLayer, HemisphericLight, LinesMesh, Matrix,
  Mesh, MeshBuilder, ParticleSystem, PointerEventTypes, Scene, SceneLoader, StandardMaterial, Texture, TransformNode, Vector3, VertexData,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import {
  ARC_HALF_ANGLE, PLAY_AREA, RANGE_BAND, TEMPLATE_WIDTH, buildPath, poseAlong, shipDef,
} from '@holotable/rules';
import type { ArcName, Bearing, GameEvent, GameState, Obstacle, PlayerId, Pose, ShipState } from '@holotable/rules';
import { PALETTES, buildPlaceholderShip } from './ships';
import { activePack, packBase } from './pack';
import { settings } from './settings';
import { sfx } from './audio';

const S = 0.1;
const ALT = 2.2;
const toV = (x: number, y: number, h = 0) => new Vector3(x * S, h, y * S);
const yaw = (r: number) => Math.PI / 2 - r;

interface ShipView { root: TransformNode; model: TransformNode; base: LinesMesh; owner: PlayerId; faction: string; realMats: Map<Mesh, any>; alt: number }

export class GameScene {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  private glow: GlowLayer;
  private ships = new Map<string, ShipView>();
  private obstacleNodes: TransformNode[] = [];
  private overlay: Mesh[] = [];
  private ghost: TransformNode | null = null;
  private ghostKey = '';
  private holoMat!: StandardMaterial;
  private ghostMat!: StandardMaterial;
  private grid!: Mesh;
  private zones: Mesh[] = [];
  private sky!: Mesh;
  private planet!: Mesh;
  private holo = true;
  private viewer: PlayerId = 0;
  private modelCache = new Map<string, Promise<TransformNode | null>>();
  onShipClick: (shipId: string) => void = () => {};
  onShipHover: (shipId: string | null) => void = () => {};
  onGroundMove: (x: number, y: number) => void = () => {};
  onGroundClick: (x: number, y: number) => void = () => {};
  skipRequested = false;
  private weaponName = '';

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { stencil: true, antialias: true });
    const scene = (this.scene = new Scene(this.engine));
    scene.clearColor = new Color4(0.005, 0.008, 0.02, 1);
    const mid = PLAY_AREA * S * 0.5;
    this.camera = new ArcRotateCamera('cam', -Math.PI / 2, 0.75, 120, new Vector3(mid, 0, mid), scene);
    this.camera.lowerRadiusLimit = 18; this.camera.upperRadiusLimit = 190; this.camera.upperBetaLimit = 1.45; this.camera.lowerBetaLimit = 0.05;
    this.camera.wheelDeltaPercentage = 0.02; this.camera.panningSensibility = 60; this.camera.panningInertia = 0.7;
    this.camera.attachControl(canvas, true);
    this.camera.minZ = 0.5; this.camera.maxZ = 4000;

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene); hemi.intensity = 0.55; hemi.groundColor = new Color3(0.1, 0.12, 0.2);
    const sun = new DirectionalLight('sun', new Vector3(-0.5, -0.8, 0.35), scene); sun.intensity = 1.6; sun.diffuse = new Color3(1, 0.96, 0.9);
    const fill = new DirectionalLight('fill', new Vector3(0.6, 0.35, -0.5), scene); fill.intensity = 0.7; fill.diffuse = new Color3(0.55, 0.7, 1); // PBR pack models have no environment map to lean on
    this.glow = new GlowLayer('glow', scene, { blurKernelSize: 48 }); this.glow.intensity = 0.9;

    this.buildSky(); this.buildTable(); this.buildMaterials();
    this.sky.visibility = 0.35; this.planet.visibility = 0.25;
    this.wirePointer();
    this.engine.runRenderLoop(() => scene.render());
    window.addEventListener('resize', () => this.engine.resize());
  }

  // ---------- environment ----------

  private buildSky() {
    const tex = new DynamicTexture('skyTex', { width: 4096, height: 2048 }, this.scene, false);
    const c = tex.getContext() as CanvasRenderingContext2D;
    c.fillStyle = '#01030a'; c.fillRect(0, 0, 4096, 2048);
    for (let i = 0; i < 9; i++) { // nebula wash
      const x = Math.random() * 4096, y = 500 + Math.random() * 1000, r = 300 + Math.random() * 600;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      const hue = [210, 260, 190, 330][i % 4];
      g.addColorStop(0, `hsla(${hue},70%,45%,0.10)`); g.addColorStop(1, 'hsla(0,0%,0%,0)');
      c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 5200; i++) {
      const x = Math.random() * 4096, y = Math.random() * 2048, m = Math.random();
      c.fillStyle = `hsla(${200 + Math.random() * 60},${Math.random() * 40}%,${70 + Math.random() * 30}%,${0.3 + m * 0.7})`;
      const sz = m > 0.985 ? 2.6 : m > 0.9 ? 1.6 : 1;
      c.fillRect(x, y, sz, sz);
    }
    tex.update();
    this.sky = MeshBuilder.CreateSphere('sky', { diameter: 3000, segments: 24, sideOrientation: Mesh.BACKSIDE }, this.scene);
    const m = new StandardMaterial('skyMat', this.scene);
    m.emissiveTexture = tex; m.disableLighting = true; m.diffuseColor = Color3.Black(); m.specularColor = Color3.Black();
    this.sky.material = m; this.sky.isPickable = false; this.sky.infiniteDistance = true;
    this.glow.addExcludedMesh(this.sky);

    // A planet limb far below the table sells scale.
    const planet = MeshBuilder.CreateSphere('planet', { diameter: 1400, segments: 48 }, this.scene);
    planet.position = new Vector3(-520, -900, 760);
    const pt = new DynamicTexture('planetTex', { width: 1024, height: 512 }, this.scene, false);
    const pc = pt.getContext() as CanvasRenderingContext2D;
    const grad = pc.createLinearGradient(0, 0, 0, 512);
    ['#1b2f4a', '#2a4a66', '#6a7f86', '#31506e', '#22344f', '#54707c', '#1a2a44'].forEach((col, i, a) => grad.addColorStop(i / (a.length - 1), col));
    pc.fillStyle = grad; pc.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 260; i++) { pc.fillStyle = `rgba(255,255,255,${Math.random() * 0.07})`; pc.beginPath(); pc.ellipse(Math.random() * 1024, Math.random() * 512, 30 + Math.random() * 160, 3 + Math.random() * 10, 0, 0, 7); pc.fill(); }
    pt.update();
    const pm = new StandardMaterial('planetMat', this.scene);
    pm.diffuseTexture = pt; pm.diffuseColor = new Color3(0.55, 0.6, 0.7); pm.specularColor = new Color3(0.03, 0.03, 0.05); pm.emissiveColor = new Color3(0.01, 0.015, 0.03);
    this.planet = planet;
    planet.material = pm; planet.isPickable = false;
    this.glow.addExcludedMesh(planet);
    this.scene.onBeforeRenderObservable.add(() => { planet.rotation.y += 0.00004 * this.scene.getEngine().getDeltaTime(); });
  }

  private buildTable() {
    const size = PLAY_AREA * S;
    const tex = new DynamicTexture('gridTex', { width: 2048, height: 2048 }, this.scene, true);
    const c = tex.getContext() as CanvasRenderingContext2D;
    c.clearRect(0, 0, 2048, 2048);
    c.fillStyle = 'rgba(20,60,110,0.10)'; c.fillRect(0, 0, 2048, 2048);
    const px = 2048 / PLAY_AREA;
    for (let mm = 0; mm <= PLAY_AREA + 1; mm += 50.8) {
      const major = Math.round(mm / 50.8) % 6 === 0;
      c.strokeStyle = major ? 'rgba(90,190,255,0.55)' : 'rgba(70,150,230,0.16)'; c.lineWidth = major ? 3 : 1.5;
      c.beginPath(); c.moveTo(mm * px, 0); c.lineTo(mm * px, 2048); c.moveTo(0, mm * px); c.lineTo(2048, mm * px); c.stroke();
    }
    c.strokeStyle = 'rgba(120,210,255,0.95)'; c.lineWidth = 10; c.strokeRect(5, 5, 2038, 2038);
    tex.update(); tex.hasAlpha = true;
    this.grid = MeshBuilder.CreateGround('table', { width: size, height: size }, this.scene);
    this.grid.position = new Vector3(size / 2, 0, size / 2);
    const m = new StandardMaterial('gridMat', this.scene);
    m.diffuseTexture = tex; m.emissiveTexture = tex; m.opacityTexture = tex; m.useAlphaFromDiffuseTexture = true;
    m.disableLighting = true; m.backFaceCulling = false; m.alpha = 0.9;
    this.grid.material = m;
    for (const p of [0, 1]) {
      const z = MeshBuilder.CreateGround(`zone${p}`, { width: size, height: RANGE_BAND * S }, this.scene);
      z.position = new Vector3(size / 2, 0.02, p === 0 ? RANGE_BAND * S / 2 : size - RANGE_BAND * S / 2);
      const zm = new StandardMaterial(`zoneMat${p}`, this.scene);
      zm.emissiveColor = p === 0 ? new Color3(0.9, 0.35, 0.15) : new Color3(0.2, 0.9, 0.5); zm.alpha = 0.13; zm.disableLighting = true;
      z.material = zm; z.isPickable = false; z.setEnabled(false);
      this.zones.push(z);
    }
  }

  private buildMaterials() {
    this.holoMat = new StandardMaterial('holo', this.scene);
    this.holoMat.emissiveColor = new Color3(0.2, 0.65, 1.0); this.holoMat.diffuseColor = Color3.Black(); this.holoMat.specularColor = Color3.Black();
    this.holoMat.alpha = 0.55; this.holoMat.wireframe = false; this.holoMat.backFaceCulling = false;
    this.ghostMat = new StandardMaterial('ghost', this.scene);
    this.ghostMat.emissiveColor = new Color3(0.4, 1.0, 0.8); this.ghostMat.diffuseColor = Color3.Black(); this.ghostMat.alpha = 0.35; this.ghostMat.disableLighting = true;
  }

  showZones(on: boolean) { this.zones.forEach(z => z.setEnabled(on)); }

  /** Holotable mode: blue hologram ships over a dimmed sky. Off = full-colour "cockpit cinema". */
  setHolo(on: boolean) {
    if (this.holo === on) return;
    this.holo = on;
    for (const sv of this.ships.values()) this.applyHolo(sv);
    const from = this.sky.visibility, to = on ? 0.35 : 1;
    void this.tween(600, t => { this.sky.visibility = from + (to - from) * t; this.planet.visibility = 0.25 + (this.sky.visibility - 0.35) * 1.15; (this.grid.material as StandardMaterial).alpha = on ? 0.5 + 0.4 * t : 0.9 - 0.55 * t; });
  }

  private applyHolo(sv: ShipView) {
    const tint = this.holoMat.clone('holoTint');
    const pal = PALETTES[sv.faction] ?? PALETTES.coalition;
    tint.emissiveColor = sv.owner === this.viewer ? new Color3(0.2, 0.65, 1.0) : new Color3(1.0, 0.35, 0.25);
    void pal;
    for (const [mesh, real] of sv.realMats) mesh.material = this.holo ? tint : real;
  }

  // ---------- state sync ----------

  setViewer(p: PlayerId) {
    if (this.viewer === p && this.ships.size) return;
    this.viewer = p;
    void this.tweenCamera({ alpha: p === 0 ? -Math.PI / 2 : Math.PI / 2 }, 700);
    for (const sv of this.ships.values()) this.applyHolo(sv);
  }

  sync(G: GameState) {
    if (this.obstacleNodes.length !== G.obstacles.length) this.buildObstacles(G.obstacles);
    for (const s of Object.values(G.ships)) {
      let sv = this.ships.get(s.id);
      if (!sv && s.placed && !s.removed) sv = this.createShip(s);
      if (!sv) continue;
      if (s.removed) { sv.root.dispose(); this.ships.delete(s.id); continue; }
      this.place(sv, s.pose);
    }
  }

  private place(sv: ShipView, p: Pose, roll = 0, pitch = 0, lift = 0) {
    sv.root.position = toV(p.x, p.y, sv.alt + lift);
    sv.root.rotation = new Vector3(0, yaw(p.r), 0);
    sv.model.rotation = new Vector3(pitch, 0, roll);
    sv.base.position.y = -(sv.alt + lift) + 0.03;
  }

  private createShip(s: ShipState): ShipView {
    const def = shipDef(s);
    const root = new TransformNode(`root-${s.id}`, this.scene);
    const model = new TransformNode(`model-${s.id}`, this.scene); model.parent = root; model.scaling.setAll(1.3);
    const placeholder = buildPlaceholderShip(this.scene, def.mesh, def.faction); placeholder.parent = model;
    const h = 2;
    const base = MeshBuilder.CreateLines(`base-${s.id}`, { points: [new Vector3(-h, 0, -h), new Vector3(h, 0, -h), new Vector3(h, 0, h), new Vector3(-h, 0, h), new Vector3(-h, 0, -h), new Vector3(0, 0, h * 0.6), new Vector3(h, 0, -h)] }, this.scene);
    base.color = s.owner === 0 ? new Color3(1, 0.5, 0.3) : new Color3(0.35, 1, 0.6); base.parent = root; base.isPickable = false;
    const n = Number(s.label) || 1;
    const sv: ShipView = { root, model, base, owner: s.owner, faction: def.faction, realMats: new Map(), alt: ALT + ((n * 37) % 5) * 0.22 };
    const hit = MeshBuilder.CreateBox(`hit-${s.id}`, { width: 4.4, height: 3, depth: 4.4 }, this.scene); // generous click target
    hit.parent = root; hit.visibility = 0; hit.metadata = { shipId: s.id };
    this.collectMats(sv, placeholder, s.id);
    this.ships.set(s.id, sv);
    this.applyHolo(sv);

    const packModel = activePack?.ships?.[def.id];
    if (packModel?.model) {
      void this.loadModel(packBase + packModel.model).then(tpl => {
        if (!tpl || !this.ships.has(s.id)) return;
        const inst = tpl.instantiateHierarchy(model, { doNotInstantiate: true })!; // clones, not instances: holo mode swaps materials per ship
        inst.setEnabled(true);
        for (const m of inst.getChildMeshes()) m.isPickable = true;
        inst.rotation = new Vector3(0, packModel.modelYaw ?? 0, 0);
        inst.scaling.setAll(packModel.modelScale ?? 1);
        placeholder.dispose();
        sv.realMats.clear(); this.collectMats(sv, inst, s.id); this.applyHolo(sv);
      });
    }
    return sv;
  }

  private collectMats(sv: ShipView, node: TransformNode, shipId: string) {
    for (const m of node.getChildMeshes(false)) { sv.realMats.set(m as Mesh, m.material); m.metadata = { ...(m.metadata ?? {}), shipId }; }
  }

  private loadModel(url: string): Promise<TransformNode | null> {
    let p = this.modelCache.get(url);
    if (!p) {
      p = SceneLoader.ImportMeshAsync('', url, '', this.scene).then(res => {
        const root = res.meshes[0] as unknown as TransformNode;
        // Normalise to ~5 units long so packs don't need per-model tuning.
        const { min, max } = (root as any).getHierarchyBoundingVectors(true);
        const size = Math.max(max.x - min.x, max.z - min.z) || 1;
        const holder = new TransformNode('tpl', this.scene);
        const k = 5 / size;
        root.parent = holder; root.scaling.scaleInPlace(k);
        root.position.subtractInPlace(min.add(max).scale(0.5 * k)); // centre the model on its base
        holder.setEnabled(false);
        return holder;
      }).catch(() => null);
      this.modelCache.set(url, p);
    }
    return p;
  }

  private buildObstacles(obs: Obstacle[]) {
    this.obstacleNodes.forEach(n => n.dispose()); this.obstacleNodes = [];
    for (const o of obs) {
      const node = new TransformNode(o.id, this.scene);
      const pts = o.poly.map(p => toV(p.x, p.y, 0.04)); pts.push(pts[0]);
      const outline = MeshBuilder.CreateLines(`${o.id}-outline`, { points: pts }, this.scene);
      outline.color = o.kind === 'asteroid' ? new Color3(1, 0.75, 0.4) : o.kind === 'debris' ? new Color3(1, 0.4, 0.4) : new Color3(0.7, 0.5, 1);
      outline.parent = node; outline.isPickable = false;
      const cx = o.poly.reduce((a, p) => a + p.x, 0) / o.poly.length, cy = o.poly.reduce((a, p) => a + p.y, 0) / o.poly.length;
      const R = Math.max(...o.poly.map(p => Math.hypot(p.x - cx, p.y - cy))) * S;
      let seed = o.seed; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      if (o.kind === 'asteroid') {
        const rock = MeshBuilder.CreateIcoSphere(`${o.id}-rock`, { radius: R * 0.85, subdivisions: 3, updatable: true }, this.scene);
        const pos = rock.getVerticesData('position')!;
        for (let i = 0; i < pos.length; i += 3) { const k = 0.78 + 0.3 * Math.sin(pos[i] * 1.7 + seed) * Math.cos(pos[i + 2] * 2.1) + 0.08 * Math.sin(pos[i + 1] * 5); pos[i] *= k; pos[i + 1] *= k * 0.7; pos[i + 2] *= k; }
        rock.updateVerticesData('position', pos); const nrm: number[] = []; VertexData.ComputeNormals(pos, rock.getIndices()!, nrm); rock.updateVerticesData('normal', nrm);
        const m = new StandardMaterial(`${o.id}-m`, this.scene); m.diffuseColor = new Color3(0.36, 0.32, 0.29); m.specularColor = new Color3(0.05, 0.05, 0.05);
        rock.material = m; rock.position = toV(cx, cy, ALT); rock.parent = node; rock.isPickable = false;
        const spin = (rnd() - 0.5) * 0.0004;
        this.scene.onBeforeRenderObservable.add(() => { if (!rock.isDisposed()) rock.rotation.y += spin * this.engine.getDeltaTime(); });
      } else if (o.kind === 'debris') {
        const m = new StandardMaterial(`${o.id}-m`, this.scene); m.diffuseColor = new Color3(0.3, 0.32, 0.35); m.specularColor = new Color3(0.4, 0.4, 0.4);
        for (let i = 0; i < 14; i++) {
          const b = MeshBuilder.CreateBox(`${o.id}-d${i}`, { width: 0.3 + rnd() * 1.6, height: 0.05 + rnd() * 0.3, depth: 0.3 + rnd() * 1.2 }, this.scene);
          const a = rnd() * 7, rr = rnd() * R * 0.8;
          b.position = toV(cx, cy, ALT - 0.6 + rnd() * 1.4).add(new Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr));
          b.rotation = new Vector3(rnd() * 3, rnd() * 3, rnd() * 3); b.material = m; b.parent = node; b.isPickable = false;
          const sp = (rnd() - 0.5) * 0.0008;
          this.scene.onBeforeRenderObservable.add(() => { if (!b.isDisposed()) { b.rotation.x += sp * this.engine.getDeltaTime(); b.rotation.z += sp * 0.6 * this.engine.getDeltaTime(); } });
        }
      } else {
        const m = new StandardMaterial(`${o.id}-m`, this.scene); m.emissiveColor = new Color3(0.35, 0.18, 0.6); m.diffuseColor = Color3.Black(); m.alpha = 0.16; m.disableLighting = true; m.backFaceCulling = false;
        for (let i = 0; i < 9; i++) {
          const a = rnd() * 7, rr = rnd() * R * 0.55;
          const b = MeshBuilder.CreateSphere(`${o.id}-g${i}`, { diameter: R * (0.7 + rnd() * 0.8), segments: 10 }, this.scene);
          b.position = toV(cx, cy, ALT - 0.3 + rnd()).add(new Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr)); b.scaling.y = 0.55;
          b.material = m; b.parent = node; b.isPickable = false;
        }
      }
      this.obstacleNodes.push(node);
    }
  }

  // ---------- overlays ----------

  clearOverlay() { this.overlay.forEach(m => m.dispose()); this.overlay = []; }

  private sector(centre: Pose, a0: number, a1: number, r0: number, r1: number, color: Color3, alpha: number) {
    const pos: number[] = [], idx: number[] = [];
    const n = 24;
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pos.push((centre.x + Math.cos(a) * r0) * S, 0.06, (centre.y + Math.sin(a) * r0) * S, (centre.x + Math.cos(a) * r1) * S, 0.06, (centre.y + Math.sin(a) * r1) * S);
      if (i < n) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const mesh = new Mesh('sector', this.scene);
    const vd = new VertexData(); vd.positions = pos; vd.indices = idx; vd.applyToMesh(mesh);
    const m = new StandardMaterial('sectorMat', this.scene); m.emissiveColor = color; m.diffuseColor = Color3.Black(); m.alpha = alpha; m.disableLighting = true; m.backFaceCulling = false;
    mesh.material = m; mesh.isPickable = false;
    this.glow.addExcludedMesh(mesh);
    this.overlay.push(mesh);
  }

  /** Firing arc with the three range bands, drawn from the ship centre (close enough for reading the table). */
  showArc(pose: Pose, arc: ArcName, color = new Color3(1, 0.3, 0.2)) {
    const centres: Record<string, [number, number]> = {
      front: [pose.r, ARC_HALF_ANGLE], rear: [pose.r + Math.PI, ARC_HALF_ANGLE],
      left: [pose.r + Math.PI / 2, Math.PI / 2 - ARC_HALF_ANGLE], right: [pose.r - Math.PI / 2, Math.PI / 2 - ARC_HALF_ANGLE],
      bullseye: [pose.r, 0.035], full: [pose.r, Math.PI],
    };
    const [c, h] = centres[arc];
    for (let band = 0; band < 3; band++) this.sector(pose, c - h, c + h, 20 + band * RANGE_BAND, 20 + (band + 1) * RANGE_BAND - 2, color, 0.2 - band * 0.05);
  }

  showRangeRings(pose: Pose) {
    for (let band = 1; band <= 3; band++) this.sector(pose, 0, Math.PI * 2, 20 + band * RANGE_BAND - 1.5, 20 + band * RANGE_BAND, new Color3(0.5, 0.8, 1), 0.5);
  }

  showTemplate(from: Pose, speed: number, bearing: Bearing, color = new Color3(0.4, 1, 0.8)) {
    const path = buildPath(from, { speed, bearing });
    const L: Vector3[] = [], R: Vector3[] = [];
    for (let s = path.h; s <= path.h + path.templateLen + 0.01; s += 4) {
      const p = poseAlong(path, Math.min(s, path.h + path.templateLen));
      const lx = -Math.sin(p.r) * TEMPLATE_WIDTH / 2, ly = Math.cos(p.r) * TEMPLATE_WIDTH / 2;
      L.push(toV(p.x + lx, p.y + ly, 0.05)); R.push(toV(p.x - lx, p.y - ly, 0.05));
    }
    if (L.length < 2) return;
    const ribbon = MeshBuilder.CreateRibbon('template', { pathArray: [L, R], sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    const m = new StandardMaterial('templateMat', this.scene); m.emissiveColor = color; m.diffuseColor = Color3.Black(); m.alpha = 0.35; m.disableLighting = true;
    ribbon.material = m; ribbon.isPickable = false; this.overlay.push(ribbon);
  }

  showLine(a: { x: number; y: number }, b: { x: number; y: number }, color: Color3) {
    const l = MeshBuilder.CreateLines('line', { points: [toV(a.x, a.y, ALT), toV(b.x, b.y, ALT)] }, this.scene);
    l.color = color; l.isPickable = false; this.overlay.push(l);
  }

  highlight(shipId: string, color: Color3) {
    const sv = this.ships.get(shipId); if (!sv) return;
    const ring = MeshBuilder.CreateTorus('hl', { diameter: 6.4, thickness: 0.12, tessellation: 40 }, this.scene);
    ring.position = sv.root.position.clone(); ring.position.y = 0.08;
    const m = new StandardMaterial('hlMat', this.scene); m.emissiveColor = color; m.diffuseColor = Color3.Black(); m.disableLighting = true;
    ring.material = m; ring.isPickable = false; this.overlay.push(ring);
  }

  /** Translucent preview of a ship at a pose (planning ghost, reposition options, deployment). */
  showGhost(s: ShipState | null, pose?: Pose, ok = true) {
    if (!s || !pose) { this.ghost?.setEnabled(false); return; }
    const key = shipDef(s).mesh + shipDef(s).faction;
    if (!this.ghost || this.ghostKey !== key) {
      this.ghost?.dispose();
      this.ghost = new TransformNode('ghost', this.scene);
      const body = buildPlaceholderShip(this.scene, shipDef(s).mesh, shipDef(s).faction); body.parent = this.ghost; body.position.y = ALT;
      for (const m of body.getChildMeshes()) { m.material = this.ghostMat; m.isPickable = false; }
      const h = 2;
      const base = MeshBuilder.CreateLines('ghostBase', { points: [new Vector3(-h, 0.05, -h), new Vector3(h, 0.05, -h), new Vector3(h, 0.05, h), new Vector3(-h, 0.05, h), new Vector3(-h, 0.05, -h)] }, this.scene);
      base.parent = this.ghost; base.isPickable = false; base.color = new Color3(0.4, 1, 0.8);
      this.ghostKey = key;
    }
    this.ghost.setEnabled(true);
    this.ghostMat.emissiveColor = ok ? new Color3(0.4, 1.0, 0.8) : new Color3(1, 0.25, 0.2);
    this.ghost.position = toV(pose.x, pose.y, 0);
    this.ghost.rotation = new Vector3(0, yaw(pose.r), 0);
  }

  screenPos(shipId: string): { x: number; y: number; visible: boolean } | null {
    const sv = this.ships.get(shipId); if (!sv) return null;
    const p = Vector3.Project(sv.root.position.add(new Vector3(0, 1.6, 0)), Matrix.Identity(), this.scene.getTransformMatrix(), this.camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight()));
    const k = this.engine.getHardwareScalingLevel();
    return { x: p.x * k, y: p.y * k, visible: p.z > 0 && p.z < 1 };
  }

  // ---------- input ----------

  private wirePointer() {
    let downAt = 0, downX = 0, downY = 0, lastHover: string | null = null;
    this.scene.onPointerObservable.add(info => {
      const e = info.event as PointerEvent;
      if (info.type === PointerEventTypes.POINTERDOWN) { downAt = performance.now(); downX = e.clientX; downY = e.clientY; return; }
      const pick = () => this.scene.pick(this.scene.pointerX, this.scene.pointerY, m => !!m.metadata?.shipId || m === this.grid);
      if (info.type === PointerEventTypes.POINTERMOVE) {
        const p = pick();
        const id: string | null = p?.pickedMesh?.metadata?.shipId ?? null;
        if (id !== lastHover) { lastHover = id; this.onShipHover(id); }
        const g = this.scene.pick(this.scene.pointerX, this.scene.pointerY, m => m === this.grid);
        if (g?.pickedPoint) this.onGroundMove(g.pickedPoint.x / S, g.pickedPoint.z / S);
      }
      if (info.type === PointerEventTypes.POINTERUP) {
        if (performance.now() - downAt > 350 || Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // that was a camera drag
        this.skipRequested = true;
        const p = pick();
        const id = p?.pickedMesh?.metadata?.shipId;
        if (id) return this.onShipClick(id);
        const g = this.scene.pick(this.scene.pointerX, this.scene.pointerY, m => m === this.grid);
        if (g?.pickedPoint) this.onGroundClick(g.pickedPoint.x / S, g.pickedPoint.z / S);
      }
    });
  }

  // ---------- animation ----------

  private tween(ms: number, step: (t: number) => void): Promise<void> {
    const dur = ms / settings.speed;
    return new Promise(resolve => {
      const start = performance.now();
      const obs = this.scene.onBeforeRenderObservable.add(() => {
        const raw = Math.min(1, (performance.now() - start) / dur);
        step(raw);
        if (raw >= 1) { this.scene.onBeforeRenderObservable.remove(obs); resolve(); }
      });
    });
  }
  wait(ms: number) { return this.tween(ms, () => {}); }

  private tweenCamera(to: { alpha?: number; beta?: number; radius?: number; target?: Vector3 }, ms: number): Promise<void> {
    const c = this.camera, a0 = c.alpha, b0 = c.beta, r0 = c.radius, t0 = c.target.clone();
    let a1 = to.alpha ?? a0;
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI; while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
    const ease = (t: number) => t * t * (3 - 2 * t);
    return this.tween(ms, raw => {
      const t = ease(raw);
      c.alpha = a0 + (a1 - a0) * t; c.beta = b0 + ((to.beta ?? b0) - b0) * t; c.radius = r0 + ((to.radius ?? r0) - r0) * t;
      if (to.target) c.target = Vector3.Lerp(t0, to.target, t);
    });
  }

  tacticalCamera() { const mid = PLAY_AREA * S / 2; return this.tweenCamera({ beta: 0.55, radius: 125, target: new Vector3(mid, 0, mid) }, 800); }
  cinematicCamera() { const mid = PLAY_AREA * S / 2; return this.tweenCamera({ beta: 1.02, radius: 105, target: new Vector3(mid, 0, mid) }, 800); }

  private savedCam: { alpha: number; beta: number; radius: number; target: Vector3 } | null = null;
  private async actionCamIn(a: ShipView, d: ShipView) {
    const c = this.camera;
    this.savedCam ??= { alpha: c.alpha, beta: c.beta, radius: c.radius, target: c.target.clone() };
    const dir = d.root.position.subtract(a.root.position);
    const dist = dir.length();
    const target = Vector3.Lerp(a.root.position, d.root.position, 0.45);
    // Sit behind and slightly to the side of the attacker, looking down the line of fire.
    const alpha = Math.atan2(-dir.z, -dir.x) + 0.35;
    await this.tweenCamera({ alpha, beta: 1.25, radius: Math.max(16, dist * 0.75 + 10), target }, 650);
  }
  private async actionCamOut() {
    if (!this.savedCam) return;
    const s = this.savedCam; this.savedCam = null;
    await this.tweenCamera(s, 600);
  }

  private wantActionCam(): boolean {
    if (settings.actionCam === 'off') return false;
    if (settings.actionCam === 'always') return true;
    return Math.random() < 0.4;
  }

  /** Plays one rules event. `G` is the state after the whole batch (used for lookups only). */
  async play(ev: GameEvent, G: GameState): Promise<void> {
    switch (ev.t) {
      case 'placed': { this.sync({ ...G, ships: { [ev.shipId]: { ...G.ships[ev.shipId], pose: ev.pose, placed: true, removed: false } } } as GameState); sfx.click(); return; }
      case 'move': return this.playMove(ev);
      case 'attack': {
        const a = this.ships.get(ev.attacker), d = this.ships.get(ev.defender);
        if (!a || !d) return;
        this.clearOverlay(); this.weaponName = ev.weapon === 'primary' ? '' : ev.weaponName;
        if (this.wantActionCam()) await this.actionCamIn(a, d);
        return;
      }
      case 'attackResult': {
        const a = this.ships.get(ev.attacker), d = this.ships.get(ev.defender);
        if (a && d) await this.fire(a, d, ev.hit);
        return;
      }
      case 'damage': {
        const sv = this.ships.get(ev.shipId); if (!sv) return;
        if (ev.shields > 0) { sfx.shield(); await this.shieldFlash(sv); }
        if (ev.facedown + ev.faceup.length > 0) { sfx.hull(); this.sparks(sv.root.position, 40, new Color4(1, 0.7, 0.3, 1)); await this.shake(sv); }
        return;
      }
      case 'destroyed': { const sv = this.ships.get(ev.shipId); if (sv) { sfx.explode(); await this.explode(sv); } return; }
      case 'removed': {
        const sv = this.ships.get(ev.shipId);
        if (sv) { sv.root.dispose(); this.ships.delete(ev.shipId); }
        await this.actionCamOut();
        return;
      }
      case 'obstacle': { const sv = this.ships.get(ev.shipId); if (sv) { sfx.hull(); this.sparks(sv.root.position, 30, ev.kind === 'gas' ? new Color4(0.7, 0.4, 1, 1) : new Color4(0.8, 0.7, 0.6, 1)); await this.shake(sv); } return; }
      case 'bump': { const sv = this.ships.get(ev.shipId); if (sv) { sfx.alarm(); await this.shake(sv); } return; }
      case 'lock': if (ev.targetId) sfx.lock(); return;
      case 'phase': if (ev.phase !== 'system') sfx.phase(); await this.actionCamOut(); return;
      default: return;
    }
  }

  async endAttack() { await this.actionCamOut(); }

  private async playMove(ev: Extract<GameEvent, { t: 'move' }>) {
    const sv = this.ships.get(ev.shipId); if (!sv) return;
    this.clearOverlay();
    if (ev.kind === 'barrelRoll') {
      const side = Math.sign(-(ev.to.x - ev.from.x) * Math.sin(ev.from.r) + (ev.to.y - ev.from.y) * Math.cos(ev.from.r)) || 1;
      sfx.flyby(2);
      await this.tween(650, raw => {
        const t = raw * raw * (3 - 2 * raw);
        this.place(sv, { x: ev.from.x + (ev.to.x - ev.from.x) * t, y: ev.from.y + (ev.to.y - ev.from.y) * t, r: ev.from.r }, -side * Math.PI * 2 * t, 0, Math.sin(Math.PI * t) * 0.5);
      });
      return this.place(sv, ev.to);
    }
    if (settings.truth) this.showTemplate(ev.from, ev.speed, ev.bearing, ev.difficulty === 'R' ? new Color3(1, 0.3, 0.25) : ev.difficulty === 'B' ? new Color3(0.3, 0.6, 1) : new Color3(0.9, 0.9, 0.9));
    const path = buildPath(ev.from, { speed: ev.speed, bearing: ev.bearing });
    const dist = ev.kind === 'boost' ? path.total : ev.travelled;
    const flip = ev.full && 'KLPER'.includes(ev.bearing);
    sfx.flyby(ev.speed);
    const ms = 500 + dist * 4.2;
    await this.tween(ms, raw => {
      const t = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
      const p = poseAlong(path, dist * t);
      const bank = -path.k * 38 * Math.sin(Math.PI * Math.min(1, t * 1.05)) * (path.reverse ? -1 : 1);
      this.place(sv, p, Math.max(-0.9, Math.min(0.9, bank)));
    });
    if (flip) {
      // Koiogran / Segnor / Tallon: pull up and over into the final facing.
      const mid = poseAlong(path, dist);
      let dr = ev.to.r - mid.r; while (dr > Math.PI) dr -= 2 * Math.PI; while (dr < -Math.PI) dr += 2 * Math.PI;
      const half = Math.abs(Math.abs(dr) - Math.PI) < 0.2;
      await this.tween(half ? 800 : 600, raw => {
        const t = raw * raw * (3 - 2 * raw);
        const pose = { x: mid.x + (ev.to.x - mid.x) * t, y: mid.y + (ev.to.y - mid.y) * t, r: half ? (t < 0.5 ? mid.r : ev.to.r) : mid.r + dr * t };
        const pitch = half ? (t < 0.5 ? -Math.PI * t : Math.PI * (1 - t)) : 0;
        const roll = half ? (t < 0.5 ? 0 : Math.PI * (1 - t) * 0) : -Math.sign(dr) * Math.sin(Math.PI * t) * 1.2;
        this.place(sv, pose, roll, pitch, Math.sin(Math.PI * t) * (half ? 2.4 : 0.8));
      });
    }
    this.place(sv, ev.to);
    this.clearOverlay();
  }

  private async fire(a: ShipView, d: ShipView, hit: boolean) {
    const pal = PALETTES[a.faction] ?? PALETTES.coalition;
    const ordnance = /torpedo|missile/i.test(this.weaponName), ion = /ion/i.test(this.weaponName);
    const color = ion ? new Color3(0.5, 0.8, 1) : ordnance ? new Color3(1, 0.5, 0.9) : pal.glow;
    const from = a.root.position.clone(), to = d.root.position.clone();
    const dir = to.subtract(from); const dist = dir.length(); dir.normalize();
    const miss = hit ? Vector3.Zero() : new Vector3((Math.random() - 0.5) * 5, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 5);
    const end = hit ? to : to.add(miss).add(dir.scale(40));
    const m = new StandardMaterial('bolt', this.scene); m.emissiveColor = color; m.diffuseColor = Color3.Black(); m.disableLighting = true;
    const shots = ordnance ? 1 : 4;
    if (ordnance) sfx.torpedo(); else if (ion) sfx.ion(); else sfx.laser(a.faction === 'coalition');
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < shots; i++) {
      const bolt = ordnance ? MeshBuilder.CreateSphere('torp', { diameter: 0.7 }, this.scene) : MeshBuilder.CreateCylinder('bolt', { diameter: 0.16, height: 3.2 }, this.scene);
      bolt.material = m; bolt.isPickable = false; bolt.setEnabled(false);
      const side = Vector3.Cross(dir, Vector3.Up()).scale(((i % 2) - 0.5) * 2.2);
      const start = from.add(side).add(dir.scale(2.5));
      if (!ordnance) { bolt.lookAt(bolt.position.add(dir)); bolt.rotation.x += Math.PI / 2; }
      jobs.push((async () => {
        await this.wait(i * 110);
        bolt.setEnabled(true);
        const travel = (ordnance ? 900 : 260) * Math.max(0.5, dist / 30);
        await this.tween(travel, t => {
          bolt.position = Vector3.Lerp(start, end, t);
          if (!ordnance) { bolt.lookAt(bolt.position.add(dir)); bolt.rotation.x += Math.PI / 2; }
        });
        bolt.dispose();
        if (hit) this.sparks(to, ordnance ? 60 : 8, new Color4(color.r, color.g, color.b, 1));
      })());
    }
    await Promise.all(jobs);
    m.dispose();
  }

  private async shieldFlash(sv: ShipView) {
    const bubble = MeshBuilder.CreateSphere('shield', { diameter: 6.2, segments: 16 }, this.scene);
    bubble.position = sv.root.position.clone();
    const m = new StandardMaterial('shieldMat', this.scene); m.emissiveColor = new Color3(0.3, 0.7, 1); m.diffuseColor = Color3.Black(); m.alpha = 0.5; m.disableLighting = true; m.backFaceCulling = false;
    bubble.material = m; bubble.isPickable = false;
    await this.tween(420, t => { m.alpha = 0.5 * (1 - t); bubble.scaling.setAll(1 + t * 0.25); });
    bubble.dispose(); m.dispose();
  }

  private async shake(sv: ShipView) {
    const base = sv.model.position.clone();
    await this.tween(320, t => { const k = (1 - t) * 0.35; sv.model.position = base.add(new Vector3((Math.random() - 0.5) * k, (Math.random() - 0.5) * k, (Math.random() - 0.5) * k)); });
    sv.model.position = base;
  }

  private particleTex: Texture | null = null;
  private sparks(at: Vector3, count: number, color: Color4) {
    if (!this.particleTex) {
      const t = new DynamicTexture('spark', 64, this.scene, false); const c = t.getContext() as CanvasRenderingContext2D;
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, 64, 64); t.update(); this.particleTex = t;
    }
    const ps = new ParticleSystem('sparks', count, this.scene);
    ps.particleTexture = this.particleTex; ps.emitter = at.clone();
    ps.minEmitBox = ps.maxEmitBox = Vector3.Zero();
    ps.color1 = color; ps.color2 = new Color4(1, 1, 1, 1); ps.colorDead = new Color4(color.r * 0.3, color.g * 0.2, 0, 0);
    ps.minSize = 0.15; ps.maxSize = 0.7; ps.minLifeTime = 0.25; ps.maxLifeTime = 0.9;
    ps.minEmitPower = 3; ps.maxEmitPower = 14; ps.direction1 = new Vector3(-1, -1, -1); ps.direction2 = new Vector3(1, 1, 1);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD; ps.manualEmitCount = count; ps.targetStopDuration = 1; ps.disposeOnStop = true; ps.gravity = Vector3.Zero();
    ps.start();
  }

  private async explode(sv: ShipView) {
    const at = sv.root.position.clone();
    this.sparks(at, 260, new Color4(1, 0.6, 0.2, 1));
    const ball = MeshBuilder.CreateSphere('boom', { diameter: 1, segments: 16 }, this.scene); ball.position = at; ball.isPickable = false;
    const m = new StandardMaterial('boomMat', this.scene); m.emissiveColor = new Color3(1, 0.75, 0.4); m.diffuseColor = Color3.Black(); m.disableLighting = true;
    ball.material = m;
    sv.model.setEnabled(false); sv.base.setEnabled(false);
    await this.tween(700, t => { ball.scaling.setAll(1 + t * 9); m.alpha = 1 - t; m.emissiveColor = Color3.Lerp(new Color3(1, 0.9, 0.7), new Color3(0.8, 0.15, 0.02), t); });
    this.sparks(at, 120, new Color4(1, 0.3, 0.1, 1));
    ball.dispose(); m.dispose();
  }

  reset() {
    for (const sv of this.ships.values()) sv.root.dispose();
    this.ships.clear(); this.obstacleNodes.forEach(n => n.dispose()); this.obstacleNodes = []; this.clearOverlay(); this.showGhost(null); this.savedCam = null;
  }
}
