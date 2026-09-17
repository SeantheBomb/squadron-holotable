// Seats a bot in an online room: `npx tsx packages/server/botclient.ts <CODE> [server] [difficulty]`.
import { PRESET_SQUADS } from '@holotable/rules';
import { Bot, Difficulty } from '@holotable/bot';

declare const process: { argv: string[]; exit(code: number): void };
const [code, server = 'ws://localhost:8787', difficulty = 'veteran'] = process.argv.slice(2);
if (!code) { console.error('usage: botclient <CODE> [ws://server] [rookie|veteran|ace]'); process.exit(1); }
let bot: Bot | null = null;
const ws = new WebSocket(`${server}/api/rooms/${code}/ws`);
ws.onopen = () => ws.send(JSON.stringify({ type: 'join', token: `bot-${Math.random().toString(36).slice(2)}-seat`, name: 'Bot', squad: PRESET_SQUADS[1] }));
ws.onmessage = e => {
  const m = JSON.parse(e.data as string);
  if (m.type === 'error') return console.log('server:', m.error);
  if (!m.view) return;
  bot ??= new Bot(m.you, { difficulty: difficulty as Difficulty, seed: Date.now() & 0xffff });
  if (m.view.phase === 'over') { console.log('game over, winner:', m.view.winner); process.exit(0); }
  const cmd = bot.decide(m.view);
  if (cmd) setTimeout(() => ws.send(JSON.stringify({ type: 'cmd', command: cmd })), 300);
};
ws.onclose = () => process.exit(0);
