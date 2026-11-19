// #3930: the pure parts of scripts/seed-local-world.mjs (what it refuses and what it is called with),
// kept apart so a unit test can read them without the script's own file and network access.
export const SEED_PASSWORD = 'live-site-local-password-123'; // the one live-site.mjs signs local accounts up with
export const SEED_ACCOUNTS = ['looker', 'neighbor'];

// Only this machine. The check is on the host actually dialled, so a look-alike name cannot pass.
export function checkLocalUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`seed-local-world: "${raw}" is not a URL`); }
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error(`seed-local-world: refusing ${url.hostname}: this seeds a local wrangler dev only, never a deployed site`);
  }
  return url.origin;
}

export function parseSeedArgs(argv) {
  const options = { url: 'http://127.0.0.1:8787' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--remote') throw new Error('seed-local-world: --remote is refused; this seeds a local wrangler dev only');
    if (arg === '--url') { options.url = argv[i + 1]; i += 1; } else throw new Error(`seed-local-world: unknown argument ${arg}`);
  }
  options.url = checkLocalUrl(options.url);
  return options;
}
