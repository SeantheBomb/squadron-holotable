// Saving a replay as a video file, entirely in the browser.
//
// Chromium can capture the tab itself, which records exactly what is on screen: the board, the
// cards, the log, the dice. It asks the player to confirm once. Elsewhere, the 3D canvas is
// composited onto a 2D canvas with the score, round and latest log line drawn in, since the
// page's HTML is not part of the canvas.
import type { GameScene } from './scene';
import { audioStream } from './audio';

export interface Recording {
  elapsed(): string;
  onEnded(fn: () => void): void;
  /** Stop and download. Resolves to the file type saved, or null if nothing was captured. */
  save(name: string): Promise<string | null>;
  cancel(): void;
}

const TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const pickType = () => TYPES.find(t => (window as any).MediaRecorder?.isTypeSupported?.(t)) ?? '';

const chromium = () => !!(navigator as any).userAgentData?.brands?.some((b: { brand: string }) => /Chromium/.test(b.brand));

export async function startRecording(scene: GameScene, _root: HTMLElement, caption: () => { top: string; bottom: string }): Promise<Recording> {
  if (!(window as any).MediaRecorder) throw new Error('This browser cannot record video.');
  const type = pickType();
  if (!type) throw new Error('This browser cannot record video.');

  let stream: MediaStream | null = null;
  let teardown = () => {};
  if (chromium() && navigator.mediaDevices?.getDisplayMedia) {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
        preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'exclude',
      } as any);
    } catch (e: any) {
      // The player saying no is a no. Anything else means tab capture is unavailable here, so fall
      // back to recording the 3D view.
      if (e?.name === 'NotAllowedError' && !/permissions policy|not allowed in this context/i.test(e?.message ?? '')) throw new Error('Recording was cancelled.');
    }
  }
  if (stream) {
    const s = stream;
    // If tab audio was not shared, take the game's own sound directly.
    if (!s.getAudioTracks().length) audioStream()?.getAudioTracks().forEach(t => s.addTrack(t));
    teardown = () => s.getTracks().forEach(t => t.stop());
  } else {
    const c = compositor(scene, caption);
    const s = c.stream;
    audioStream()?.getAudioTracks().forEach(t => s.addTrack(t));
    teardown = () => { c.stop(); s.getTracks().forEach(t => t.stop()); };
    stream = s;
  }
  const live = stream;

  const chunks: Blob[] = [];
  const rec = new MediaRecorder(live, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.start(1000);
  const began = Date.now();
  let ended: (() => void) | null = null;
  live.getVideoTracks()[0]?.addEventListener('ended', () => ended?.());   // "Stop sharing" in the browser bar

  const stop = () => new Promise<void>(resolve => {
    if (rec.state === 'inactive') return resolve();
    rec.onstop = () => resolve();
    rec.stop();
  });

  return {
    elapsed: () => { const s = Math.floor((Date.now() - began) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; },
    onEnded: fn => { ended = fn; },
    async save(name) {
      await stop();
      teardown();
      if (!chunks.length) return null;
      const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(new Blob(chunks, { type: type.split(';')[0] }));
      const a = document.createElement('a');
      a.href = url; a.download = `${name}.${ext}`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return ext.toUpperCase();
    },
    cancel() { void stop().then(teardown); },
  };
}

/** Copy each rendered frame onto a 2D canvas and draw the captions over it. */
function compositor(scene: GameScene, caption: () => { top: string; bottom: string }) {
  const gl = scene.scene.getEngine().getRenderingCanvas()!;
  const out = document.createElement('canvas');
  const scale = Math.min(1, 1920 / gl.width);
  out.width = Math.round(gl.width * scale) & ~1; out.height = Math.round(gl.height * scale) & ~1;
  const ctx = out.getContext('2d')!;
  const obs = scene.scene.onAfterRenderObservable.add(() => {
    // Inside the render callback the WebGL buffer is still intact, so this copies the frame.
    ctx.drawImage(gl, 0, 0, out.width, out.height);
    const { top, bottom } = caption();
    const px = Math.round(out.height / 42);
    ctx.font = `600 ${px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const band = (text: string, y: number) => {
      if (!text) return;
      const w = ctx.measureText(text).width + px * 2;
      ctx.fillStyle = 'rgba(4, 10, 22, 0.72)';
      ctx.fillRect(out.width / 2 - w / 2, y - px * 1.2, w, px * 1.8);
      ctx.fillStyle = '#dff4ff';
      ctx.fillText(text, out.width / 2, y);
    };
    band(top, px * 2);
    band(bottom, out.height - px * 1.4);
  });
  return { stream: out.captureStream(30), stop: () => scene.scene.onAfterRenderObservable.remove(obs) };
}
