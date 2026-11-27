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
  const stats = { ms: 0, trips: 0, rowsRead: 0 };

  // #4542: rows read is what the free tier counts and what grows with the world, so it is
  // summed from the `meta.rows_read` D1 returns with each statement's answer (a batch answers
  // with one result per statement).
  function addRows(result) {
    if (Array.isArray(result)) result.forEach(addRows);
    else if (typeof result?.meta?.rows_read === 'number') stats.rowsRead += result.meta.rows_read;
    return result;
  }

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
        if (prop === 'first') {
          // first() carries no meta, so it is answered through all() (the same statement) to see the rows it read.
          return (column) => timed(async () => {
            const answer = addRows(await target.all());
            const row = answer.results?.[0] ?? null;
            if (column === undefined || row === null) return row;
            if (!(column in row)) throw new Error(`D1_ERROR: No such column: ${column}`);
            return row[column];
          });
        }
        if (prop === 'run' || prop === 'all') {
          return (...args) => timed(async () => addRows(await target[prop](...args)));
        }
        if (prop === 'raw') {
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
          return (statements, ...rest) => timed(async () => addRows(await target.batch(statements.map((s) => s?.[NATIVE] ?? s), ...rest)));
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
      // #4542: a second metric beside the first, so a reader of the older one is unchanged.
      return `d1;dur=${stats.ms};desc="${stats.trips} trip${stats.trips === 1 ? '' : 's'}", d1rows;dur=0;desc="${stats.rowsRead} rows read"`;
    },
    stats,
  };
}
