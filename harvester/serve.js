// Static server for ./data and ../app, plus the handful of proxy routes that
// exist only because nemweb.com.au sends no Access-Control-Allow-Origin header.
//
// Measured on 6 August 2026 with an explicit Origin request header:
//   nemweb.com.au              no CORS header  -> browser cannot fetch, proxy needed
//   data.wa.aemo.com.au        *
//   api.open-meteo.com         *
//   visualisations.aemo.com.au *
//
// So only NEM strictly needs proxying. WEM and the AEMO summary go through here
// anyway so the app has one origin, one cache and one failure mode to report,
// rather than three.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, '..', 'app');
const DATA_DIR = path.join(HERE, '..', 'data');
const NODE_MODULES = path.join(HERE, '..', 'node_modules');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const UPSTREAM = {
  '/api/nem-summary':
    'https://visualisations.aemo.com.au/aemo/apps/api/report/ELEC_NEM_SUMMARY',
};

// The registry is tracked source, not harvester output: `build-registry.js`
// writes it into harvester/ and every harvester script reads it from there. The
// browser asks for it under /data/ alongside everything the backfill produces,
// so it is aliased here rather than copied. A copy would be a second source of
// truth that a deploy can silently fail to make — which is exactly what
// happened: the first cloud deploy served every backfilled file and 404ed on
// this one, because the only thing that had ever put it in data/ was a symlink
// made by hand on one developer's machine.
const ALIASES = {
  '/data/registry.json': path.join(HERE, 'registry.json'),
};

// Everything here is public read-only data, and the open header is what lets
// the app be hosted as a static site on another origin — the browser will not
// read /data across origins without it. GET and HEAD with no custom headers
// are CORS "simple requests", so no preflight route is needed.
const CORS = { 'access-control-allow-origin': '*' };

async function serveFile(res, filePath) {
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      ...CORS,
      'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream',
      // The app reloads constantly during development and stale JS is a
      // uniquely confusing failure, so nothing is cached.
      'cache-control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  // Ahead of the directory roots, so a stale file left in data/ by an older
  // build cannot shadow the tracked one.
  if (ALIASES[pathname]) {
    if (await serveFile(res, ALIASES[pathname])) return;
  }

  if (UPSTREAM[pathname]) {
    try {
      const upstream = await fetch(UPSTREAM[pathname], { signal: AbortSignal.timeout(30_000) });
      const body = await upstream.text();
      res.writeHead(upstream.status, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    } catch (err) {
      // The app renders "Last successful fetch was N minutes ago" from this, so
      // the reason has to survive the round trip rather than becoming a 500.
      res.writeHead(502, { ...CORS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_unreachable', detail: String(err.message) }));
    }
    return;
  }

  // Path traversal guard: resolve, then confirm the result is still inside the
  // directory it was meant to be inside.
  const roots = pathname.startsWith('/data/')
    ? [[DATA_DIR, pathname.slice('/data'.length)]]
    : pathname.startsWith('/vendor/')
      ? [[NODE_MODULES, pathname.slice('/vendor'.length)]]
      : [[APP_DIR, pathname === '/' ? '/index.html' : pathname]];

  for (const [root, rel] of roots) {
    const resolved = path.resolve(root, '.' + rel);
    if (!resolved.startsWith(path.resolve(root))) break;
    if (await serveFile(res, resolved)) return;
  }

  res.writeHead(404, { ...CORS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(`Not found: ${pathname}\n`);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, () => {
    console.log(`GridSense on http://localhost:${port}`);
    console.log(`  app   ${APP_DIR}`);
    console.log(`  data  ${DATA_DIR}`);
  });
}
