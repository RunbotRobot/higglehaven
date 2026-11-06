// #805: pure comparison half of check-migration-checksums.mjs, kept free of
// node:fs/node:crypto imports so it can be unit tested under the workerd test
// pool (which has no real filesystem).
//
// current = { name: hash } for the files on disk, lock = { name: hash } as
// committed.
export function compareChecksums(current, lock) {
  const changed = [];
  const missing = [];
  const removed = [];
  for (const [name, hash] of Object.entries(current)) {
    if (!(name in lock)) missing.push(name);
    else if (lock[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(lock)) {
    if (!(name in current)) removed.push(name);
  }
  return { changed, missing, removed };
}
