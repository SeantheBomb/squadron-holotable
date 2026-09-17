// Dev-only photo mode (`/play/?photo=hero|planning`): stages a scene, captures the canvas and posts it to
// the Vite dev server, which writes it under public/img. Re-run whenever models or effects change.
import { Color3, Color4, Vector3 } from '@babylonjs/core';
import { PRESET_SQUADS, createGame, previewManeuver, parseManeuver } from '@holotable/rules';
import type { GameState, Pose } from '@holotable/rules';
import type { GameScene } from './scene';

const deg = (d: number) => (d * Math.PI) / 180;

function stage(poses: Record<string, Pose>): GameState {
  const G = createGame([PRESET_SQUADS[0], PRESET_SQUADS[1]], ['A', 'B'], 4242).state;
  for (const s of Object.values(G.ships)) {
    const p = poses[s.id];
    if (p) { s.pose = p; s.placed = true; } else s.removed = true;
  }
  return G;
}

// Photo mode drives rendering itself on a virtual clock, so the staged moment is identical on every
// run and doesn't depend on the tab being visible (hidden tabs get no animation frames).
let vt = 0;
function takeOverClock(scene: GameScene) {
  scene.engine.stopRenderLoop();
  vt = performance.now();
  performance.now = () => vt;
  scene.scene.useConstantAnimationDeltaTime = true;
}
function frame(scene: GameScene) { scene.engine.beginFrame(); scene.scene.render(); scene.engine.endFrame(); }
async function step(scene: GameScene, ms: number) {
  for (let t = 0; t < ms; t += 16) {
    vt += 16;
    frame(scene);
    for (let i = 0; i < 6; i++) await Promise.resolve(); // let tween promises chain between frames
  }
}
async function capture(scene: GameScene, name: string) {
  frame(scene);
  const data = scene.engine.getRenderingCanvas()!.toDataURL('image/png'); // same task as the render: buffer is still valid
  await fetch(`/__shot?name=${name}`, { method: 'POST', body: data });
  document.title = `saved ${name}`;
}

export async function runPhoto(scene: GameScene, mode: string) {
  const sc = scene as any;
  (window as any).__scene = scene;
  (window as any).__photo = { step: (ms: number) => step(scene, ms), capture: (name: string) => capture(scene, name), Vector3, Color3, Color4 };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  scene.camera.detachControl();

  if (mode === 'planning') {
    const G = stage({
      p0s1: { x: 330, y: 250, r: deg(80) }, p0s2: { x: 450, y: 215, r: deg(95) }, p0s3: { x: 560, y: 180, r: deg(100) },
      p1s1: { x: 560, y: 640, r: deg(-100) }, p1s2: { x: 400, y: 690, r: deg(-85) }, p1s3: { x: 300, y: 610, r: deg(-60) }, p1s5: { x: 660, y: 560, r: deg(-120) },
    });
    scene.sync(G);
    await wait(7000); // let pack models stream in
    const luke = G.ships.p0s1, m = parseManeuver('3BW');
    scene.showTemplate(luke.pose, m.speed, m.bearing, new Color3(0.85, 0.9, 1));
    const ghost = previewManeuver(luke, m);
    scene.showGhost(luke, ghost);
    scene.showArc(ghost, 'front', new Color3(0.4, 1, 0.8));
    scene.highlight('p0s1', new Color3(0.4, 1, 0.8));
    scene.camera.setTarget(new Vector3(44, 0, 42)); // target first: setting it re-derives alpha/beta/radius
    Object.assign(scene.camera, { alpha: -Math.PI / 2 - 0.35, beta: 0.72, radius: 78 });
    takeOverClock(scene);
    await step(scene, 900);
    return capture(scene, 'planning');
  }

  // Hero: a head-on pass breaking into a furball — lasers mid-flight, one Dart coming apart.
  const G = stage({
    p0s1: { x: 420, y: 400, r: deg(62) },   // lead Lancer, guns on the Dart ahead
    p0s2: { x: 330, y: 330, r: deg(75) },   // wingman
    p0s3: { x: 560, y: 300, r: deg(110) },  // Bulwark holding the flank
    p1s1: { x: 610, y: 560, r: deg(-150) }, // Stiletto diving in
    p1s2: { x: 480, y: 505, r: deg(-118) }, // Dart under fire
    p1s3: { x: 300, y: 520, r: deg(-70) },  // Dart breaking away
    p1s5: { x: 390, y: 640, r: deg(-95) },  // Dart — destroyed this frame
  });
  scene.sync(G);
  scene.setHolo(false);
  await wait(8000);
  const ships: Map<string, any> = sc.ships;
  for (const sv of ships.values()) sv.base.setEnabled(false);
  for (const node of sc.obstacleNodes) for (const m of node.getChildMeshes()) if (m.name.endsWith('-outline')) m.setEnabled(false);
  sc.grid.visibility = 0.25;
  const roll: Record<string, number> = { p0s1: -0.45, p0s2: -0.2, p0s3: 0.15, p1s1: 0.55, p1s2: -0.7, p1s3: 0.9 };
  for (const [id, r] of Object.entries(roll)) sc.place(ships.get(id), G.ships[id].pose, r, id === 'p1s2' ? 0.15 : 0);
  scene.camera.setTarget(new Vector3(44.5, 2.4, 45));
  Object.assign(scene.camera, { alpha: deg(-128), beta: deg(74), radius: 26 });
  scene.camera.fov = 0.72;
  takeOverClock(scene);
  await step(scene, 900);

  // The action itself is directed from the console so the frame can be art-directed:
  //   sc = __scene; void sc.explode(sc.ships.get('p1s5')); await __photo.step(200); await __photo.capture('hero')
  document.title = 'ready';
}
