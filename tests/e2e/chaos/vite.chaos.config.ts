import { defineConfig, mergeConfig } from 'vite';
import base from '../../../vite.config';

/* Agent 10: chaos web server. Same app and proxy as the base config, but on CHAOS_WEB_PORT
   (>= 3002, strictPort) and without the HMR websocket, so offline/online chaos never triggers
   a Vite full-page reload. */
const port = Number(process.env.CHAOS_WEB_PORT ?? 3013);
if (!Number.isInteger(port) || port < 3002) throw new Error('CHAOS_WEB_PORT must be >= 3002');

export default mergeConfig(base, defineConfig({
  server: { port, strictPort: true, host: 'localhost', hmr: false, ws: false, watch: null },
  clearScreen: false,
}));
