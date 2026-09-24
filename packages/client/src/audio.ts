// All sound is synthesised at runtime — no sampled audio ships with the engine.
import { settings } from './settings';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let droneGain: GainNode | null = null;

function ac(): AudioContext | null {
  if (!ctx) {
    try { ctx = new AudioContext(); } catch { return null; }
    master = ctx.createGain(); master.connect(ctx.destination);
  }
  master!.gain.value = settings.volume;
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}
export const setVolume = () => { if (master) master.gain.value = settings.volume; };

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const b = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
  const c = ac(); if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!); o.start(t); o.stop(t + dur + 0.05);
}

function burst(dur: number, vol: number, f0: number, f1: number, delay = 0) {
  const c = ac(); if (!c) return;
  const t = c.currentTime + delay;
  const src = c.createBufferSource(); src.buffer = noiseBuffer(c, dur);
  const filt = c.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.setValueAtTime(f0, t); filt.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt).connect(g).connect(master!); src.start(t);
}

export const sfx = {
  click: () => tone('sine', 880, 1320, 0.06, 0.08),
  confirm: () => { tone('triangle', 520, 780, 0.12, 0.12); tone('triangle', 780, 1040, 0.14, 0.1, 0.09); },
  deny: () => tone('square', 180, 120, 0.18, 0.08),
  laser: (heavy = false) => { for (let i = 0; i < 3; i++) { tone('sawtooth', heavy ? 900 : 1500, heavy ? 140 : 260, 0.22, 0.09, i * 0.11); burst(0.08, 0.05, 6000, 800, i * 0.11); } },
  torpedo: () => { tone('sine', 140, 60, 0.9, 0.2); burst(0.9, 0.08, 1200, 200); },
  ion: () => { tone('square', 300, 1800, 0.35, 0.06); tone('sine', 1800, 200, 0.4, 0.08, 0.1); },
  shield: () => { tone('sine', 1200, 500, 0.3, 0.1); burst(0.25, 0.06, 5000, 1500); },
  // Weight 1-3 scales the impact; a crit adds a bright metallic tear over the top.
  hull: (weight = 1, crit = false) => {
    const w = Math.max(1, Math.min(3, weight));
    burst(0.28 + w * 0.09, 0.2 + w * 0.09, 2200, 140);
    tone('triangle', 180 - w * 18, 42, 0.32 + w * 0.1, 0.13 + w * 0.05);
    tone('sine', 90, 30, 0.45 + w * 0.12, 0.1 + w * 0.05, 0.02);
    if (w > 1) burst(0.2, 0.1, 900, 120, 0.06);
    if (crit) { tone('sawtooth', 2400, 400, 0.4, 0.07, 0.03); burst(0.5, 0.16, 7000, 500, 0.02); tone('square', 220, 110, 0.5, 0.05, 0.08); }
  },
  explode: () => { burst(1.4, 0.5, 2500, 60); tone('sine', 120, 28, 1.2, 0.4); burst(0.2, 0.3, 8000, 2000); },
  flyby: (speed: number) => burst(0.5 + speed * 0.08, 0.05, 300 + speed * 120, 1400),
  dice: () => { for (let i = 0; i < 4; i++) burst(0.03, 0.12, 5000, 2500, i * 0.05 + Math.random() * 0.02); },
  phase: () => { tone('sine', 330, 330, 0.5, 0.07); tone('sine', 495, 495, 0.6, 0.06, 0.12); },
  lock: () => { tone('square', 1400, 1400, 0.07, 0.05); tone('square', 1400, 1400, 0.07, 0.05, 0.12); tone('square', 1900, 1900, 0.2, 0.05, 0.24); },
  alarm: () => { tone('sawtooth', 600, 400, 0.25, 0.08); tone('sawtooth', 600, 400, 0.25, 0.08, 0.3); },
  win: () => [392, 494, 587, 784].forEach((f, i) => tone('triangle', f, f, 0.5, 0.12, i * 0.16)),
  lose: () => [392, 370, 330, 262].forEach((f, i) => tone('triangle', f, f, 0.6, 0.1, i * 0.2)),
};

/** A slow evolving pad underneath everything; `tension` brightens it during combat phases. */
export function startDrone() {
  const c = ac(); if (!c || droneGain) return;
  droneGain = c.createGain(); droneGain.gain.value = 0.05;
  const filt = c.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 420; filt.Q.value = 2;
  for (const f of [55, 82.5, 110.3, 164.4]) {
    const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 0.05 + Math.random() * 0.1; lg.gain.value = f * 0.006;
    lfo.connect(lg).connect(o.frequency); lfo.start(); o.connect(filt); o.start();
  }
  filt.connect(droneGain).connect(master!);
  (droneGain as any)._filter = filt;
}
export function setTension(t: number) {
  if (!droneGain || !ctx) return;
  ((droneGain as any)._filter as BiquadFilterNode).frequency.linearRampToValueAtTime(300 + t * 900, ctx.currentTime + 1.5);
  droneGain.gain.linearRampToValueAtTime(0.04 + t * 0.04, ctx.currentTime + 1.5);
}

/** A live copy of everything the game plays, for recording. Null if audio never started. */
export function audioStream(): MediaStream | null {
  const c = ac();
  if (!c || !master) return null;
  const dest = c.createMediaStreamDestination();
  master.connect(dest);
  return dest.stream;
}
