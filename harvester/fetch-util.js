// Shared fetch and unzip helpers for the harvester.

import { unzipSync } from 'fflate';

/**
 * Fetch with retry on network failure and 5xx. NEMWeb is a static file server
 * that occasionally drops connections mid-transfer under load; a retry costs
 * nothing and a truncated zip fails much further downstream where it is far
 * harder to attribute.
 */
export async function fetchBuffer(url, { retries = 4, timeoutMs = 120_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        // 404 means the file genuinely is not there; retrying is pointless.
        if (res.status === 404) throw Object.assign(new Error(`HTTP 404 ${url}`), { status: 404 });
        throw new Error(`HTTP ${res.status} ${url}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err.status === 404) throw err;
      lastErr = err;
    }
  }
  throw new Error(`Fetch failed after ${retries + 1} attempts: ${url} (${lastErr?.message})`);
}

/** Unzip an archive expected to hold exactly one file, returning it as text. */
export function unzipSingle(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const names = Object.keys(files);
  if (names.length !== 1) {
    throw new Error(`Expected 1 file in archive, found ${names.length}: ${names.join(', ')}`);
  }
  return Buffer.from(files[names[0]]).toString('utf8');
}

/** Unzip an archive holding many entries, returning [name, text] pairs. */
export function unzipAll(buf) {
  const files = unzipSync(new Uint8Array(buf));
  return Object.entries(files).map(([name, data]) => [name, Buffer.from(data)]);
}

/**
 * List the files in a NEMWeb directory index. Filenames carry an opaque
 * incrementing ID that cannot be predicted, so the only way to find new files
 * is to read the directory listing (spec §5.1).
 */
export async function listNemwebDir(url, pattern = /PUBLIC_[A-Z_0-9#%]+\.zip/gi) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} listing ${url}`);
  const html = await res.text();
  return [...new Set(html.match(pattern) || [])].sort();
}
