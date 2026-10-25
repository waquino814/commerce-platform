import { describe, expect, it } from 'vitest';
import { createFaultController, DISABLED_FAULTS } from '../src/controller.js';
import { manualTimers, recordingEffect } from './support.js';

/** M5a criteria A1 (off by default), A3 (stop and expiry) and A4 (one scenario at a time). */
describe('fault controller', () => {
  it('disabled: nothing can ever become active', () => {
    expect(DISABLED_FAULTS.enabled).toBe(false);
    expect(DISABLED_FAULTS.start('poison-order', 1, 1000)).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(DISABLED_FAULTS.active()).toBeNull();
    expect(DISABLED_FAULTS.isActive('poison-order')).toBe(false);
    expect(DISABLED_FAULTS.stop()).toEqual({ stopped: false, scenario: null });
    expect(() => {
      DISABLED_FAULTS.shutdown();
    }).not.toThrow();
  });

  it('enabled but never started: nothing is active and no effect runs', () => {
    const effect = recordingEffect();
    const controller = createFaultController({ effects: { 'poison-order': effect } });
    expect(controller.enabled).toBe(true);
    expect(controller.active()).toBeNull();
    expect(effect.calls).toEqual([]);
  });

  it('starts one scenario, activates its effect with the seed, and reports it', () => {
    const effect = recordingEffect();
    const timers = manualTimers();
    const controller = createFaultController({
      effects: { 'poison-order': effect },
      now: () => Date.parse('2026-10-25T00:00:00Z'),
      timers,
    });
    const result = controller.start('poison-order', 42, 90_000);
    expect(result).toEqual({
      ok: true,
      activation: {
        scenario: 'poison-order',
        version: 1,
        seed: 42,
        durationMs: 90_000,
        startedAt: '2026-10-25T00:00:00.000Z',
        expiresAt: '2026-10-25T00:01:30.000Z',
      },
    });
    expect(effect.calls).toEqual(['activate:42']);
    expect(controller.isActive('poison-order')).toBe(true);
    expect(controller.isActive('payment-timeouts')).toBe(false);
  });

  it('refuses a second start while one is active', () => {
    const controller = createFaultController({ timers: manualTimers() });
    controller.start('poison-order', 1, 1000);
    const second = controller.start('payment-timeouts', 1, 1000);
    expect(second).toMatchObject({
      ok: false,
      reason: 'scenario_active',
      active: { scenario: 'poison-order' },
    });
  });

  it('stop deactivates once and is idempotent; expiry stops on its own', () => {
    const effect = recordingEffect();
    const timers = manualTimers();
    const controller = createFaultController({ effects: { 'payment-timeouts': effect }, timers });
    controller.start('payment-timeouts', 3, 5_000);
    expect(controller.stop()).toEqual({ stopped: true, scenario: 'payment-timeouts' });
    expect(controller.stop()).toEqual({ stopped: false, scenario: null });
    expect(timers.pending()).toBe(0);

    controller.start('payment-timeouts', 4, 5_000);
    timers.fire();
    expect(controller.active()).toBeNull();
    expect(effect.calls).toEqual(['activate:3', 'deactivate', 'activate:4', 'deactivate']);
  });

  it('a stale expiry never stops a later activation', () => {
    // Keep every expiry callback, even cleared ones, to fire an old one after a restart.
    const callbacks: (() => void)[] = [];
    const controller = createFaultController({
      timers: {
        setTimeout: (fn) => callbacks.push(fn),
        clearTimeout: () => undefined,
      },
    });
    controller.start('poison-order', 1, 1000);
    controller.stop();
    controller.start('poison-order', 2, 1000);
    callbacks[0]?.();
    expect(controller.active()?.seed).toBe(2);
    callbacks[1]?.();
    expect(controller.active()).toBeNull();
  });

  it('shutdown stops the active scenario and refuses every later start', () => {
    const effect = recordingEffect();
    const controller = createFaultController({
      effects: { 'poison-order': effect },
      timers: manualTimers(),
    });
    controller.start('poison-order', 1, 1000);
    controller.shutdown();
    expect(effect.calls).toEqual(['activate:1', 'deactivate']);
    expect(controller.start('poison-order', 1, 1000)).toEqual({ ok: false, reason: 'shut_down' });
  });
});
