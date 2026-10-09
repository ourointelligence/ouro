import { describe, expect, it } from 'vitest';
import { bestCI, capabilityIndex, ceilingDetected, populationCI, takeoff } from '../../src/si.js';

const trial = (holdoutScore: number) => ({ trial: { trainScore: 0, holdoutScore, trainN: 1, holdoutN: 1, maxDrawdown: 0 } });

describe('capabilityIndex', () => {
  it('is holdout / baseline - 1 for a positive baseline', () => {
    expect(capabilityIndex(trial(0.12), 0.1)).toBeCloseTo(0.2, 10);
    expect(capabilityIndex(trial(0.1), 0.1)).toBeCloseTo(0, 10);
    expect(capabilityIndex(trial(0.05), 0.1)).toBeCloseTo(-0.5, 10);
  });
  it('keeps "better is higher" when the baseline is negative or zero', () => {
    expect(capabilityIndex(trial(-0.2), -0.5)).toBeCloseTo(0.6, 10);
    expect(capabilityIndex(trial(-0.8), -0.5)).toBeCloseTo(-0.6, 10);
    expect(capabilityIndex(trial(0.3), 0)).toBeCloseTo(0.3, 10);
  });
  it('is 0 without a trial', () => {
    expect(capabilityIndex({}, 0.1)).toBe(0);
  });
});

describe('populationCI / bestCI', () => {
  it('averages and maximises over defined CIs', () => {
    const live = [{ ci: 0.1 }, { ci: 0.3 }, { ci: undefined }, { ci: NaN }];
    expect(populationCI(live)).toBeCloseTo(0.2, 10);
    expect(bestCI(live)).toBeCloseTo(0.3, 10);
    expect(populationCI([])).toBe(0);
  });
});

describe('takeoff and ceiling', () => {
  const history = [
    { cycle: 1, populationCI: 0.0, bestCI: 0.0 },
    { cycle: 2, populationCI: 0.04, bestCI: 0.09 },
    { cycle: 3, populationCI: 0.09, bestCI: 0.14 },
    { cycle: 4, populationCI: 0.11, bestCI: 0.19 },
    { cycle: 5, populationCI: 0.115, bestCI: 0.19 },
    { cycle: 6, populationCI: 0.118, bestCI: 0.19 },
    { cycle: 7, populationCI: 0.12, bestCI: 0.19 },
  ];
  it('computes velocity as the change in population CI since the previous cycle', () => {
    const rows = takeoff(history);
    expect(rows.map((r) => r.cycle)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows[0]!.velocity).toBe(0);
    expect(rows[1]!.velocity).toBeCloseTo(0.04, 10);
    expect(rows[2]!.velocity).toBeCloseTo(0.05, 10);
    expect(rows[3]!.velocity).toBeCloseTo(0.02, 10);
    expect(rows[3]!.bestCI).toBeCloseTo(0.19, 10);
  });
  it('detects a ceiling when the last k velocities are all below the threshold', () => {
    const rows = takeoff(history);
    expect(ceilingDetected(rows, 3, 0.01)).toBe(true);
    expect(ceilingDetected(rows.slice(0, 4), 3, 0.01)).toBe(false);
    expect(ceilingDetected(rows, 3, 0.001)).toBe(false);
    expect(ceilingDetected(rows.slice(0, 2), 3)).toBe(false);
  });
});
