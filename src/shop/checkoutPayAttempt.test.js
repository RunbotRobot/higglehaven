// #3116: a finalize failure after the card was charged must be retryable
// without confirming the card a second time.
import { describe, expect, it, vi } from 'vitest';
import {
  createCheckoutPayState, runPayAttempt, describePayFailure, PAY_STAGES, CHARGED_RETRY_MESSAGE, CONNECTION_LOST_MESSAGE,
  isAlreadySucceededConfirmError,
} from './checkoutPayAttempt.js';

describe('runPayAttempt (#3116)', () => {
  it('confirms then finalizes on the happy path', async () => {
    const state = createCheckoutPayState();
    const confirm = vi.fn(async () => ({}));
    const finalize = vi.fn(async () => ({ purchase: { purchaseId: 'p1' } }));
    const result = await runPayAttempt(state, { confirm, finalize });
    expect(result).toEqual({ purchase: { purchaseId: 'p1' } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(state.paymentConfirmed).toBe(true);
  });

  it('retries only finalize after a finalize failure, never confirming the card twice', async () => {
    const state = createCheckoutPayState();
    const confirm = vi.fn(async () => ({}));
    const finalize = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ purchase: { purchaseId: 'p1' } });

    await expect(runPayAttempt(state, { confirm, finalize })).rejects.toThrow('network down');
    expect(state.paymentConfirmed).toBe(true);
    // The buyer is told they were charged and may retry -- no raw error text.
    expect(describePayFailure(state, new Error('network down'))).toBe(CHARGED_RETRY_MESSAGE);

    const result = await runPayAttempt(state, { confirm, finalize });
    expect(result).toEqual({ purchase: { purchaseId: 'p1' } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it('keeps the card-declined message and stays retryable via confirm when the charge itself failed', async () => {
    const state = createCheckoutPayState();
    const confirm = vi.fn()
      .mockResolvedValueOnce({ error: { message: 'Your card was declined.' } })
      .mockResolvedValueOnce({});
    const finalize = vi.fn(async () => ({ purchase: { purchaseId: 'p2' } }));

    const failure = await runPayAttempt(state, { confirm, finalize }).catch((e) => e);
    expect(failure.message).toBe('Your card was declined.');
    expect(state.paymentConfirmed).toBe(false);
    expect(describePayFailure(state, failure)).toBe('Your card was declined.');
    expect(finalize).not.toHaveBeenCalled();

    await runPayAttempt(state, { confirm, finalize });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('treats Stripe\'s already-succeeded confirm error as success and goes straight to finalize', async () => {
    const state = createCheckoutPayState();
    const confirm = vi.fn(async () => ({
      error: { code: 'payment_intent_unexpected_state', message: 'raw provider words', payment_intent: { status: 'succeeded' } },
    }));
    const finalize = vi.fn(async () => ({ purchase: { purchaseId: 'p3' } }));
    const result = await runPayAttempt(state, { confirm, finalize });
    expect(result).toEqual({ purchase: { purchaseId: 'p3' } });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('only the succeeded-state confirm error counts as already-succeeded', () => {
    expect(isAlreadySucceededConfirmError({ code: 'payment_intent_unexpected_state', payment_intent: { status: 'canceled' } })).toBe(false);
    expect(isAlreadySucceededConfirmError({ code: 'card_declined', payment_intent: { status: 'succeeded' } })).toBe(false);
    expect(isAlreadySucceededConfirmError(undefined)).toBe(false);
  });

  it('reports the real step it is on, so the bar follows the work (#3947)', async () => {
    const stages = [];
    const state = createCheckoutPayState();
    await runPayAttempt(state, {
      confirm: async () => ({ paymentIntent: { status: 'succeeded' } }),
      finalize: async () => ({ purchase: { purchaseId: 'p4' } }),
      onStage: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(['checking', 'recording']);
  });

  it('a retry after the charge starts at recording and never says it is checking the card again (#3947)', async () => {
    const stages = [];
    const state = createCheckoutPayState();
    const confirm = vi.fn(async () => ({}));
    const finalize = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ purchase: { purchaseId: 'p5' } });
    await runPayAttempt(state, { confirm, finalize, onStage: (s) => stages.push(s) }).catch(() => {});
    await runPayAttempt(state, { confirm, finalize, onStage: (s) => stages.push(s) });
    expect(stages).toEqual(['checking', 'recording', 'recording']);
  });

  it('a declined card never reaches recording (#3947)', async () => {
    const stages = [];
    await runPayAttempt(createCheckoutPayState(), {
      confirm: async () => ({ error: { message: 'Your card was declined.' } }),
      finalize: async () => ({}),
      onStage: (s) => stages.push(s),
    }).catch(() => {});
    expect(stages).toEqual(['checking']);
  });

  it('the bar only ever grows from one real step to the next', () => {
    expect(PAY_STAGES.checking.share).toBeGreaterThan(0);
    expect(PAY_STAGES.recording.share).toBeGreaterThan(PAY_STAGES.checking.share);
    expect(PAY_STAGES.recording.share).toBeLessThan(1);
  });
});

// #3948: every way paying can fail before the card is charged says what happened, whether
// anything was charged, and what to do next, in the app's own words.
describe('describePayFailure copy (#3948)', () => {
  async function failureFor(error) {
    const state = createCheckoutPayState();
    const failure = await runPayAttempt(state, { confirm: async () => ({ error }), finalize: async () => ({}) }).catch((e) => e);
    return { state, failure };
  }

  it.each([
    ['card_declined', /declined.*not charged.*another card/i],
    ['insufficient_funds', /enough.*not charged.*another card/i],
    ['expired_card', /expired.*not charged.*another card/i],
    ['incorrect_cvc', /security code.*not charged/i],
    ['incorrect_number', /card number.*not charged/i],
    ['processing_error', /not charged.*again/i],
  ])('says what to do for %s, and that nothing was charged', async (code, pattern) => {
    const { state, failure } = await failureFor({ code, message: 'raw provider words' });
    const text = describePayFailure(state, failure);
    expect(text).toMatch(pattern);
    expect(text).not.toMatch(/raw provider words/);
  });

  it('does not claim nothing was charged when the connection dropped mid-confirmation', async () => {
    const { state, failure } = await failureFor({ type: 'api_connection_error', message: 'Network error' });
    expect(describePayFailure(state, failure)).toBe(CONNECTION_LOST_MESSAGE);
    expect(CONNECTION_LOST_MESSAGE).toMatch(/My purchases/);
    // Whether the card was charged is unknown, so the only charge claim is conditional.
    expect(CONNECTION_LOST_MESSAGE).toMatch(/if the order isn't there/);
  });

  it('keeps the provider text for a failure it has no copy for', async () => {
    const { state, failure } = await failureFor({ code: 'some_new_code', message: 'Something specific.' });
    expect(describePayFailure(state, failure)).toBe('Something specific.');
  });
});
