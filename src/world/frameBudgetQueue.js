// #3396: "Moving, looking and drawing never wait on loading." World content
// (building a placed item, setting its level of detail, disposing it) used to be
// processed in one uninterrupted loop, so hundreds of items froze the screen and
// left the controls where they were. This queue runs small units of that work
// for at most a few milliseconds per frame, then hands the rest to the next
// frame, nearest and largest first.
//
// A unit is a function (it may be async). The queue:
//  - runs units in priority order (lower number first, ties in the order they
//    were queued);
//  - runs at least one unit per frame, so work always makes progress, and stops
//    as soon as the frame's time is spent, so a frame overshoots its budget by
//    at most one unit;
//  - awaits a unit that returns a promise before starting the next one (a model
//    still downloading holds its place without blocking anything else);
//  - lets a whole group of pending units be dropped at once (a load that was
//    superseded by an unload), and keeps going if a unit throws;
//  - run() queues a unit and returns a promise for its result, for a caller
//    that has to know when its own work finished (#3427: undo rebuilding items).
//
// Dependency-free, with the clock and the frame scheduler passed in, so it runs
// in the plain vitest pool.

export class DroppedWorkError extends Error {
  constructor() {
    super('Queued world work was dropped before it ran.');
    this.name = 'DroppedWorkError';
  }
}

const DEFAULT_BUDGET_MS = 4; // the part of a frame world content may use

export function createFrameBudgetQueue({
  budgetMs = DEFAULT_BUDGET_MS,
  now = () => performance.now(),
  schedule = (callback) => requestAnimationFrame(callback),
  onError = (error) => console.error('Queued world work failed:', error),
} = {}) {
  const heap = []; // entries { priority, seq, unit, group, dropped }
  const byGroup = new Map(); // group -> Set of live entries
  let seq = 0;
  let live = 0; // entries queued and not dropped or run
  let scheduled = false; // a frame tick has been asked for
  let ticking = false; // a tick is running (possibly awaiting an async unit)
  let ticks = 0;
  let unitsRun = 0;
  let longestTickMs = 0;

  const before = (a, b) => a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq);

  function push(entry) {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  }

  function pop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && before(heap[left], heap[smallest])) smallest = left;
        if (right < heap.length && before(heap[right], heap[smallest])) smallest = right;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    }
    return top;
  }

  function release(entry) {
    if (entry.group === null) return;
    const set = byGroup.get(entry.group);
    if (!set) return;
    set.delete(entry);
    if (!set.size) byGroup.delete(entry.group);
  }

  function requestTick() {
    if (scheduled || ticking || live === 0) return;
    scheduled = true;
    schedule(tick);
  }

  async function runEntry(entry) {
    release(entry);
    live -= 1;
    unitsRun += 1;
    try {
      await entry.unit();
    } catch (error) {
      onError(error);
    }
  }

  async function tick() {
    scheduled = false;
    if (ticking) return;
    ticking = true;
    ticks += 1;
    const start = now();
    try {
      while (heap.length) {
        const entry = pop();
        if (entry.dropped) continue;
        await runEntry(entry);
        if (now() - start >= budgetMs) break;
      }
    } finally {
      ticking = false;
      const spent = now() - start;
      if (spent > longestTickMs) longestTickMs = spent;
    }
    requestTick();
  }

  // Queue a unit. `priority`: lower runs first. `group`: anything usable as a
  // Map key (a landlet entry, a load token) so dropGroup can cancel it later.
  function enqueue(unit, { priority = 0, group = null } = {}) {
    const entry = { priority, seq: seq += 1, unit, group, dropped: false };
    push(entry);
    live += 1;
    if (group !== null) {
      if (!byGroup.has(group)) byGroup.set(group, new Set());
      byGroup.get(group).add(entry);
    }
    requestTick();
    return entry;
  }

  // Like enqueue, but returns a promise for the unit's result. A unit that
  // throws rejects the promise (it is the caller's to handle, so onError is not
  // called); a unit whose group is dropped before it ran rejects with
  // DroppedWorkError so nobody waits forever.
  function run(unit, options = {}) {
    return new Promise((resolve, reject) => {
      const entry = enqueue(async () => {
        try {
          resolve(await unit());
        } catch (error) {
          reject(error);
        }
      }, options);
      entry.onDrop = () => reject(new DroppedWorkError());
    });
  }

  // Cancel every pending unit of a group. A unit already running finishes.
  function dropGroup(group) {
    const set = byGroup.get(group);
    if (!set) return 0;
    let dropped = 0;
    for (const entry of set) {
      if (entry.dropped) continue;
      entry.dropped = true;
      live -= 1;
      dropped += 1;
      entry.onDrop?.();
    }
    byGroup.delete(group);
    return dropped;
  }

  // Run everything now, ignoring the budget. For tests, and for the rare caller
  // that must see the work finished (never the render loop).
  async function drain() {
    while (heap.length) {
      const entry = pop();
      if (entry.dropped) continue;
      await runEntry(entry);
    }
  }

  return {
    enqueue,
    run,
    dropGroup,
    drain,
    pending: () => live,
    stats: () => ({ ticks, unitsRun, longestTickMs, pending: live }),
  };
}

// The shared queue every mode's loaders use.
export const worldWorkQueue = createFrameBudgetQueue();
