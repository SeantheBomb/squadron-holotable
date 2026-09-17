import { Bot } from '@holotable/bot';

let bot: Bot | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') { bot = new Bot(msg.player, { ...msg.options, seed: (Math.random() * 2 ** 31) | 0 }); return; }
  if (msg.type === 'decide' && bot) {
    const started = performance.now();
    const command = bot.decide(msg.view);
    // A beat of "thinking" so the opponent doesn't feel like a lookup table.
    const wait = Math.max(0, 350 - (performance.now() - started));
    setTimeout(() => (self as any).postMessage({ command }), wait);
  }
};
