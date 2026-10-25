/**
 * The capture clients' injected dependencies (docs/prompts/m5-design.md, "Package boundaries").
 * The clients never read the clock: the capture window is passed in, so the same inputs always
 * give the same queries.
 */
export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (command: string, args: readonly string[]) => Promise<CommandResult>;

export interface CaptureWindow {
  captureFrom: Date;
  captureTo: Date;
}

/** True for `/admin` and anything under it, query string ignored; `/administrator` is not. */
export function isAdminPath(url: unknown, prefix: string): boolean {
  if (typeof url !== 'string') return false;
  const path = url.split('?')[0] ?? '';
  return path === prefix || path.startsWith(`${prefix}/`);
}
