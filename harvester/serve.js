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
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
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
  // Coastlines are committed source too — a fixed simplification of public
  // state boundaries, not something the harvester produces — so they live with
  // the app and are aliased into the same /data/ namespace the app fetches from.
  '/data/au-states.json': path.join(APP_DIR, 'data', 'au-states.json'),
};

// Everything here is public read-only data, and the open header is what lets
// the app be hosted as a static site on another origin — the browser will not
// read /data across origins without it. GET and HEAD with no custom headers
// are CORS "simple requests", so no preflight route is needed.
const CORS = { 'access-control-allow-origin': '*' };

/**
 * Serve a file by streaming it.
 *
 * Streamed rather than read into a Buffer, and the reason is the instance's
 * memory rather than elegance. A dispatch day is 30 MB, and the app asks for
 * twenty-one of them on a cold load; `readFile` holds each whole file in memory
 * for as long as the response takes to go out, so a handful of simultaneous
 * visitors on a mobile connection is hundreds of megabytes of Buffer at once.
 *
 * Buffers are allocated outside V8's heap, so `--max-old-space-size` does not
 * bound them — they count only against the container, which does not raise an
 * error when it runs out. It kills the process, every request 502s, and the
 * application log ends mid-sentence with nothing that looks like a cause.
 *
 * Streaming holds one chunk at a time regardless of file size or concurrency.
 */
async function serveFile(res, filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return false;
  }
  // A directory resolves and stats happily, then fails on read. Answering 404
  // here keeps the caller's "did this path exist" question honest.
  if (!stat.isFile()) return false;

  res.writeHead(200, {
    ...CORS,
    'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream',
    'content-length': stat.size,
    // The app reloads constantly during development and stale JS is a
    // uniquely confusing failure, so nothing is cached.
    'cache-control': 'no-cache',
  });

  try {
    await pipeline(createReadStream(filePath), res);
  } catch {
    // A client that navigates away mid-download aborts the socket. Ordinary on
    // a page that fetches twenty-one large files; not a server fault, and the
    // headers have already gone out so there is nothing left to say.
    res.destroy();
  }
  return true;
}

// Day-keyed directories the app would otherwise discover by asking for files
// and seeing which ones 404. That works, but it fills the console with red on
// every load — and a console that is always red is a console nobody reads, in
// which the one 404 that matters is invisible. One listing answers it instead.
const INDEXED = ['nem-dispatch', 'wem-dispatch', 'prices', 'flows'];

async function dataIndex() {
  const out = {};
  await Promise.all(INDEXED.map(async (dir) => {
    try {
      out[dir] = (await fs.readdir(path.join(DATA_DIR, dir)))
        .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
        .map((n) => n.slice(0, -'.json'.length))
        .sort();
    } catch {
      // A directory the build never produced is an empty list, not an error:
      // the app has to render something sensible either way, and "no flows"
      // is exactly as true as "flows we could not read".
      out[dir] = [];
    }
  }));
  return out;
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/data/index.json') {
    res.writeHead(200, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(JSON.stringify(await dataIndex()));
    return;
  }

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

  // Where a request path maps to on disk. Path traversal guard: resolve, then
  // confirm the result is still inside the directory it was meant to be inside.
  const rootFor = (p) => (
    p.startsWith('/data/') ? [DATA_DIR, p.slice('/data'.length)]
      : p.startsWith('/vendor/') ? [NODE_MODULES, p.slice('/vendor'.length)]
        : [APP_DIR, p === '/' ? '/index.html' : p]
  );

  // The decoded path first, then the raw one.
  //
  // AEMO identifiers are not filesystem-safe — Gladstone registers as "G/STONE"
  // — so the harvester percent-encodes them and the file on disk is literally
  // `G%2FSTONE.json`. Decoding the request path turned that back into a
  // directory separator and looked for STONE.json inside a directory G, which
  // does not exist. Gladstone's weather was unreachable, and the only symptom
  // was one station quietly running its physical and analogue experts on output
  // alone — no error, no missing panel, just a slightly worse forecast.
  for (const p of new Set([pathname, url.pathname])) {
    const [root, rel] = rootFor(p);
    const resolved = path.resolve(root, '.' + rel);
    if (!resolved.startsWith(path.resolve(root))) continue;
    if (await serveFile(res, resolved)) return;
  }

  res.writeHead(404, { ...CORS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(`Not found: ${pathname}\n`);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, async () => {
    console.log(`GridSense on http://localhost:${port}`);
    console.log(`  app   ${APP_DIR}`);
    console.log(`  data  ${DATA_DIR}`);

    // The poller lives in the server process rather than a second Render
    // component, because it writes to the same ephemeral disk this process
    // serves from — two components would each get their own copy of it, and
    // the one doing the fetching would not be the one answering requests.
    //
    // Started here rather than at module scope so importing `server` in a test
    // does not open a socket to NEMWeb.
    if (process.env.GRIDSENSE_LIVE === '0') {
      console.log('  live  disabled (GRIDSENSE_LIVE=0)');
      return;
    }
    const { start, POLL_MS, describeBudget } = await import('./live.js');
    console.log(`  live  polling every ${POLL_MS / 1000}s`);
    // Printed where a deploy's logs will show it. A feed disabled by the memory
    // budget is otherwise indistinguishable from a feed that is broken, and the
    // next person to look will debug the wrong thing.
    console.log(`  live  ${describeBudget()}`);
    start({
      onTick: (m) => {
        const parts = Object.entries(m.feeds).map(([name, f]) => (
          f.cadence === 'daily'
            ? `${name} ${f.last_day ?? 'none'}${f.error ? ' ERROR' : ''}`
            : `${name} +${f.written}${f.error ? ` ERROR ${f.error}` : ''}`
        ));
        // One line per tick is a minute's worth of log on a service that runs
        // for weeks; enough to see the feed stop, little enough to leave on.
        console.log(`live  ${parts.join('  ')}`);
      },
    });
  });
}
