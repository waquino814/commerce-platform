// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SymptomChart } from '../src/components/SymptomChart';
import { telemetry } from './support';

const symptom = () => {
  const s = telemetry().symptom;
  if (!s) throw new Error('the fixture has a symptom');
  return s;
};

const label = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('text')].find((t) => t.textContent === text);

describe('the symptom chart', () => {
  it('prints the fault start and a detection seconds later on different rows', () => {
    const base = symptom();
    const { container } = render(
      <SymptomChart
        symptom={{
          ...base,
          triggerStartedAt: '2026-10-26T01:55:30.000Z',
          detectedAt: '2026-10-26T01:55:40.000Z',
        }}
      />,
    );
    const start = label(container, 'fault start');
    const detected = label(container, 'detected');
    expect(start).toBeDefined();
    expect(detected).toBeDefined();
    expect(start?.getAttribute('y')).not.toBe(detected?.getAttribute('y'));
  });

  it('keeps the maximum value label inside the drawing', () => {
    const { container } = render(<SymptomChart symptom={symptom()} />);
    const max = label(container, '3');
    // Right-aligned at x, a label of n characters at 11px needs about 6.5 * n pixels to its left.
    expect(Number(max?.getAttribute('x'))).toBeGreaterThanOrEqual(6.5 * 4);
  });
});
