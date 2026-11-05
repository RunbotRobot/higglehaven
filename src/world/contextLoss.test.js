import { describe, expect, it, vi } from 'vitest';
import { watchContextLoss } from './contextLoss.js';

// #1318
function fakeCanvas() {
  const target = new EventTarget();
  return target;
}
function lostEvent() {
  const event = new Event('webglcontextlost', { cancelable: true });
  return event;
}

describe('watchContextLoss (#1318)', () => {
  it('prevents the default on loss (so the context stays restorable) and reports it', () => {
    const canvas = fakeCanvas();
    const onLost = vi.fn();
    watchContextLoss(canvas, { onLost });
    const event = lostEvent();
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('reports restoration', () => {
    const canvas = fakeCanvas();
    const onRestored = vi.fn();
    watchContextLoss(canvas, { onRestored });
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it('stops reporting once the returned disposer is called', () => {
    const canvas = fakeCanvas();
    const onLost = vi.fn();
    const stop = watchContextLoss(canvas, { onLost });
    stop();
    canvas.dispatchEvent(lostEvent());
    expect(onLost).not.toHaveBeenCalled();
  });

  it('works with no callbacks', () => {
    const canvas = fakeCanvas();
    watchContextLoss(canvas);
    const event = lostEvent();
    expect(() => canvas.dispatchEvent(event)).not.toThrow();
    expect(event.defaultPrevented).toBe(true);
  });
});
