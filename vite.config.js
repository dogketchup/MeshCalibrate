import { defineConfig } from 'vite';
import meshCalibrateBackend from './server/backend.js';

export default defineConfig({
  // Node backend on the same port: /simulate (OpenCV calibration simulation), /tutorial
  plugins: [meshCalibrateBackend()],
  server: {
    host: '0.0.0.0',
    port: 5713,
    strictPort: true,
    // Allow Cloudflare Tunnel host header through Vite's security check
    allowedHosts: [
      'calibrate.jordanirgangportfolio.com',
      '.jordanirgangportfolio.com'
    ],
    // Or set allowedHosts: true to allow any external host header
    watch: {
      usePolling: true, // Required for hot-reloading inside Docker volumes
    },
  },
});
