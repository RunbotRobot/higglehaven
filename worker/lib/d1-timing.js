// #3464: where a request's time goes, as the server sees it. A browser-observed time includes
// waiting for the page's own main thread, so it cannot say how long D1 took; this wraps the D1
// binding for one request and counts the trips and the time spent waiting on them.
//
// Opt-in only (see worker/index.js): a request that sends `x-server-timing: 1` gets a
// `Server-Timing: d1;dur=<ms>;desc="<n> trips"` header back, and nobody else sees anything, so
// no header appears on ordinary traffic and no behaviour changes. `dur` is the sum of each
// trip's own wait, so statements run together (Promise.all) add up to more than the request's
// wall time; `trips` counts statements run (a batch counts once).

const NATIVE = Symbol('native statement');

export function createD1Timing() {
  const stats = { ms: 0, trips: 0 };

  async function timed(run) {
    const started = Date.now();
    try {
      return await run();
    } finally {
      stats.ms += Date.now() - started;
      stats.trips += 1;
    }
  }

  function wrapStatement(statement) {
    return new Proxy(statement, {
      get(target, prop) {
        if (prop === NATIVE) return target;
        if (prop === 'bind') return (...values) => wrapStatement(target.bind(...values));
        if (prop === 'first' || prop === 'run' || prop === 'all' || prop === 'raw') {
          return (...args) => timed(() => target[prop](...args));
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  function wrapDatabase(db) {
    return new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') return (sql) => wrapStatement(target.prepare(sql));
        if (prop === 'batch') {
          // D1 only accepts its own statements, so hand it the originals.
          return (statements, ...rest) => timed(() => target.batch(statements.map((s) => s?.[NATIVE] ?? s), ...rest));
        }
        if (prop === 'exec') return (...args) => timed(() => target.exec(...args));
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  return {
    wrap: wrapDatabase,
    header() {
      return `d1;dur=${stats.ms};desc="${stats.trips} trip${stats.trips === 1 ? '' : 's'}"`;
    },
    stats,
  };
}
