import { describe, it, expect, vi } from 'vitest';
import { eventBus } from '../../src/transport/events.js';

describe('eventBus', () => {
  it('emits memory:stored event', () => {
    const listener = vi.fn();
    eventBus.on('memory', listener);

    eventBus.stored({
      id: 'test-1', namespace: 'default', category: 'general',
      surprise_score: 0.5, contradictions: 0, entities_extracted: 2,
    });

    expect(listener).toHaveBeenCalledWith({
      type: 'memory:stored',
      data: expect.objectContaining({ id: 'test-1', surprise_score: 0.5 }),
    });

    eventBus.off('memory', listener);
  });

  it('emits memory:forgotten event', () => {
    const listener = vi.fn();
    eventBus.on('memory', listener);

    eventBus.forgotten({ ids: ['a', 'b'], count: 2, namespace: 'default' });

    expect(listener).toHaveBeenCalledWith({
      type: 'memory:forgotten',
      data: expect.objectContaining({ count: 2 }),
    });

    eventBus.off('memory', listener);
  });
});
