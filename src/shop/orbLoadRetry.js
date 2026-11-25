// #4252: a landlet's credit orbs are fetched once, when the landlet comes into load range. A fetch that failed
// (a dropped connection, a busy moment) used to leave the landlet marked loaded with no orbs until the person
// walked out of range and back. A failed load now clears the mark and waits a little before the next try, so a
// person standing there gets their orbs once the connection is back, and a server that is down is not hammered.
export const ORB_LOAD_RETRY_MS = 15000;

// entry: { orbsLoaded, orbLoadToken, orbsRetryAt? }. Whether the landlet's orbs should be fetched now.
export function orbLoadDue(entry, distance, loadRadius, now) {
  return !entry.orbsLoaded && distance < loadRadius && now >= (entry.orbsRetryAt || 0);
}

// A load that carried `token` failed. Only the load that is still current counts: one that was superseded (the
// person left range and came back) must not clear the mark the newer load set.
export function noteOrbLoadFailed(entry, token, now) {
  if (token !== entry.orbLoadToken) return false;
  entry.orbsLoaded = false;
  entry.orbsRetryAt = now + ORB_LOAD_RETRY_MS;
  return true;
}
