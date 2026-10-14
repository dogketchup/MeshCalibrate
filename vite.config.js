import { defineConfig } from 'vite';

export default defineConfig({
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
