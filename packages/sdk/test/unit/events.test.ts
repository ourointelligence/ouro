import { describe, expect, it } from 'vitest';
import { TypedEmitter } from '../../src/events.js';

describe('TypedEmitter', () => {
  it('delivers typed payloads, supports off and unsubscribe functions', () => {
    const em = new TypedEmitter();
    const seen: number[] = [];
    const off = em.on('cycle:start', (p) => seen.push(p.cycle));
    em.emit('cycle:start', { cycle: 1 });
    off();
    em.emit('cycle:start', { cycle: 2 });
    const h = (p: { cycle: number }) => seen.push(p.cycle * 10);
    em.on('cycle:start', h);
    em.emit('cycle:start', { cycle: 3 });
    em.off('cycle:start', h);
    em.emit('cycle:start', { cycle: 4 });
    expect(seen).toEqual([1, 30]);
  });

  it('a throwing handler never reaches the emitter and is reported as an error event', () => {
    const em = new TypedEmitter();
    const errors: string[] = [];
    const after: number[] = [];
    em.on('error', (e) => errors.push(`${e.scope}: ${e.message}`));
    em.on('pending', () => {
      throw new Error('boom');
    });
    em.on('pending', (p) => after.push(p.cycle));
    expect(() => em.emit('pending', { cycle: 7 })).not.toThrow();
    expect(after).toEqual([7]);
    expect(errors).toEqual(['handler:pending: boom']);
    // a throwing error handler is swallowed rather than recursing
    em.on('error', () => {
      throw new Error('again');
    });
    expect(() => em.emit('error', { scope: 'x', message: 'y' })).not.toThrow();
  });
});
