/** What an app's main module needs from telemetry: flush and shut down at exit. */
export interface TelemetryHandle {
  readonly enabled: boolean;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export const DISABLED_TELEMETRY: TelemetryHandle = Object.freeze({
  enabled: false,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
});

const ACTIVE = Symbol.for('commerce.telemetry.handle');
type Holder = { [ACTIVE]?: TelemetryHandle };

/**
 * The preload entrypoint (`node --import`) runs before an app's main module, so it hands the
 * handle over through one process-global slot. This is the only global the package keeps; the
 * OpenTelemetry API itself is process-global by design.
 */
export function setActiveTelemetry(handle: TelemetryHandle): void {
  (globalThis as Holder)[ACTIVE] = handle;
}

export function getActiveTelemetry(): TelemetryHandle {
  return (globalThis as Holder)[ACTIVE] ?? DISABLED_TELEMETRY;
}
