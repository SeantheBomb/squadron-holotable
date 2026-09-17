import { defineConfig } from 'vite';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { resolve, join, normalize } from 'node:path';

// In dev, serve a sibling presentation pack (kept in its own repo) at /pack/ when one exists.
const packDir = resolve(__dirname, '../../content-sw');
const types: Record<string, string> = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

export default defineConfig({
  resolve: {
    alias: {
      '@holotable/rules': resolve(__dirname, '../rules/src/index.ts'),
      '@holotable/bot': resolve(__dirname, '../bot/src/index.ts'),
    },
  },
  plugins: [{
    name: 'local-pack',
    configureServer(server) {
      server.middlewares.use('/pack', (req, res, next) => {
        const file = normalize(join(packDir, decodeURIComponent((req.url ?? '/').split('?')[0])));
        if (!file.startsWith(packDir) || !existsSync(file) || !statSync(file).isFile()) return next();
        const ext = file.slice(file.lastIndexOf('.'));
        res.setHeader('content-type', types[ext] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  }],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
});
