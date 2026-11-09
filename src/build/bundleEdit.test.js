import { describe, it, expect } from 'vitest';
import { bundleEditDecision, NOT_CREATOR_REASON, CHECKING_CREATOR_REASON } from './bundleEdit.js';

describe('bundleEditDecision (#3328)', () => {
  it('lets an unlinked bundle edit at once, whoever asks', () => {
    for (const isCreator of [true, false, null, undefined]) {
      expect(bundleEditDecision({ linked: false, isCreator })).toEqual({ canEdit: true, needsConfirm: false, reason: '' });
    }
  });
  it('asks the creator of a linked bundle to confirm first', () => {
    expect(bundleEditDecision({ linked: true, isCreator: true })).toEqual({ canEdit: true, needsConfirm: true, reason: '' });
  });
  it('does not ask again once the creator acknowledged it', () => {
    expect(bundleEditDecision({ linked: true, isCreator: true, acknowledged: true })).toEqual({ canEdit: true, needsConfirm: false, reason: '' });
  });
  it('disables Edit for another builder and says why', () => {
    const d = bundleEditDecision({ linked: true, isCreator: false, acknowledged: true });
    expect(d).toEqual({ canEdit: false, needsConfirm: false, reason: NOT_CREATOR_REASON });
    expect(d.reason).toContain('Unbundle');
  });
  it('holds Edit back while ownership is unknown', () => {
    expect(bundleEditDecision({ linked: true, isCreator: null })).toEqual({ canEdit: false, needsConfirm: false, reason: CHECKING_CREATOR_REASON });
  });
});
