// MeshCalibrate's Node backend, mounted into the Vite dev and preview servers (vite.config.js), so
// it runs on the same port as the page (5713 in Docker):
//
//   GET  /simulate      the simulation page (server/simulate.html)
//   POST /api/simulate  run one simulated calibration with OpenCV (src/sim/simulate.js) -> JSON
//   GET  /tutorial      TUTORIAL.md rendered to HTML (also /TUTORIAL.md for the raw file)
//
// OpenCV is opencv.js (WebAssembly), loaded once on first use. Simulations run one at a time.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { marked } from 'marked';
import { loadCv } from '../src/sim/cvLoader.js';
import { simulate } from '../src/sim/simulate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let queue = Promise.resolve();

function send(res, status, type, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function tutorialPage() {
  const md = await readFile(join(ROOT, 'TUTORIAL.md'), 'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MeshCalibrate tutorial</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<style>
body{margin:0;background:#fff;color:#1b1f24;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px 20px 60px}
nav{font-size:13px;margin-bottom:8px} nav a{margin-right:14px}
h1{font-size:26px;margin:.3em 0} h2{font-size:20px;margin-top:1.8em;border-bottom:1px solid #d0d7de;padding-bottom:.2em}
h3{font-size:16px;margin-top:1.4em}
pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:10px 12px;overflow-x:auto;font-size:13px;line-height:1.45}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f6f8fa;padding:0 3px;border-radius:3px}
pre code{background:none;padding:0}
table{border-collapse:collapse;margin:.8em 0;font-size:14px} td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left}
th{background:#f6f8fa} blockquote{margin:0;padding:0 12px;color:#57606a;border-left:3px solid #d0d7de}
@media (prefers-color-scheme: dark){body{background:#0d1117;color:#e6edf3}pre,code,th{background:#161b22}pre,td,th,h2{border-color:#30363d}a{color:#58a6ff}}
</style></head><body><main><nav><a href="/">&larr; generator</a><a href="/simulate">simulate calibration</a><a href="/TUTORIAL.md">TUTORIAL.md</a></nav>
${marked.parse(md)}</main></body></html>`;
}

export async function handle(req, res, next) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/simulate' || url.pathname === '/simulate/')) {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(join(ROOT, 'server/simulate.html'), 'utf8'));
    }
    if (req.method === 'GET' && (url.pathname === '/tutorial' || url.pathname === '/tutorial/')) {
      return send(res, 200, 'text/html; charset=utf-8', await tutorialPage());
    }
    if (req.method === 'GET' && url.pathname === '/TUTORIAL.md') {
      return send(res, 200, 'text/markdown; charset=utf-8', await readFile(join(ROOT, 'TUTORIAL.md'), 'utf8'));
    }
    if (url.pathname === '/api/simulate') {
      if (req.method !== 'POST') return send(res, 405, 'application/json', JSON.stringify({ ok: false, error: 'POST a JSON body' }));
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'body is not JSON' }));
      }
      const job = queue.then(async () => {
        const { cv, loadMs } = await loadCv();
        const out = simulate(cv, body);
        out.opencv = { build: 'opencv.js (WebAssembly) in Node', load_ms: loadMs };
        return out;
      });
      queue = job.catch(() => {});
      try {
        return send(res, 200, 'application/json', JSON.stringify(await job));
      } catch (err) {
        return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
    }
  } catch (err) {
    return send(res, 500, 'text/plain; charset=utf-8', String(err.stack || err));
  }
  return next();
}

/** Vite plugin: the backend in `vite` (dev) and `vite preview`. */
export default function meshCalibrateBackend() {
  return {
    name: 'meshcalibrate-backend',
    configureServer(server) { server.middlewares.use(handle); },
    configurePreviewServer(server) { server.middlewares.use(handle); },
  };
}
