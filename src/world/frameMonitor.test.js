import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordFrame,
  noteFramesPaused,
  recordLongTask,
  longestFrameGapMs,
  longTasks,
  resetFrameMonitor,
  frameMonitorSample,
} from './frameMonitor.js';

describe('frameMonitor (#3396)', () => {
  beforeEach(() => {
    resetFrameMonitor();
    noteFramesPaused(); // a reset keeps the last frame time (the next frame still follows it); tests start fresh
  });

  it('records the longest gap between two frames', () => {
    for (const t of [0, 16, 32, 80, 96]) recordFrame(t); // one 48 ms gap
    expect(longestFrameGapMs()).toBe(48);
  });

  it('has no gap to report before a second frame', () => {
    recordFrame(1000);
    expect(longestFrameGapMs()).toBe(0);
  });

  it('does not count a backgrounded tab as a stall', () => {
    recordFrame(0);
    recordFrame(16);
    recordFrame(60016); // a minute later: the tab was hidden
    expect(longestFrameGapMs()).toBe(16);
  });

  it('treats the frame after a pause as a fresh start', () => {
    recordFrame(0);
    noteFramesPaused();
    recordFrame(3000);
    expect(longestFrameGapMs()).toBe(0);
  });

  it('counts long tasks and remembers the longest', () => {
    recordLongTask(80, 1000.4);
    recordLongTask(210, 5200.6);
    recordLongTask(60, 9000);
    // #3483: the longest one's start time (ms since navigation) comes with it.
    expect(longTasks()).toEqual({ count: 3, longestMs: 210, longestAtMs: 5201 });
  });

  it('reports only the last second of notable gaps in the feedback sample', () => {
    recordFrame(0);
    recordFrame(400); // a 400 ms stall
    expect(frameMonitorSample(400)).toEqual({ longestFrameMs: 400, longTaskCount: 0 });
    recordFrame(416);
    expect(frameMonitorSample(1300).longestFrameMs).toBe(400); // still inside the window
    expect(frameMonitorSample(1500).longestFrameMs).toBe(0); // aged out
  });

  it('ignores ordinary frames in the feedback sample', () => {
    for (let t = 0; t <= 160; t += 16) recordFrame(t);
    expect(frameMonitorSample(160).longestFrameMs).toBe(0);
  });

  it('carries the long-task count into the sample', () => {
    recordLongTask(90);
    expect(frameMonitorSample(0).longTaskCount).toBe(1);
  });
});
