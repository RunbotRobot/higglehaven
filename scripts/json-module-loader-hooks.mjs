// Companion to check-worker-imports.mjs (#2684) — see that file's own
// header for why this check exists at all. This file exists only because
// of one unrelated wrinkle it has to work around: worker/index.js does
// `import migrationsManifest from './migrations-manifest.json'` with no
// import attribute — fine for wrangler/esbuild's bundler, but Node's own
// native ESM loader requires a `with { type: "json" }` attribute on any
// bare `.json` import and throws `"... needs an import attribute of
// 'type: json'"` otherwise, which would mask the real check this script
// exists to run with an unrelated, confusing failure.
//
// Fix: intercept `.json` specifier resolution and hand back a synthesized
// `export default {...}` ES module instead of letting Node's own
// JSON-module path (and its attribute requirement) ever get involved.
// This changes nothing about what worker/index.js itself actually
// imports — the synthesized module's default export is the exact same
// parsed JSON value either way.
//
// Registered via node:module's register() from check-worker-imports.mjs's
// own main() — see that file.
import { readFile } from 'node:fs/promises';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.json') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const targetUrl = new URL(specifier, context.parentURL);
    return { url: targetUrl.href, format: 'json-as-module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (context.format === 'json-as-module') {
    const source = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: `export default ${source};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
