import { describe, expect, it } from 'vitest';
import { activeMessagesFromRows } from '../scripts/replay.js';

const message = (uuid: string, parentUuid: string | null, role: 'user' | 'assistant', text: string) => ({
  uuid,
  parentUuid: parentUuid ?? undefined,
  type: role,
  isSidechain: false,
  message: { role, content: [{ type: 'text', text }] },
});

describe('transcript branch reconstruction', () => {
  it('uses compact_boundary.parentUuid instead of a later sibling branch', () => {
    const rows: any[] = [
      message('root', null, 'user', 'root'),
      message('kept-assistant', 'root', 'assistant', 'kept assistant'),
      message('kept-user', 'kept-assistant', 'user', 'kept user'),
      message('wrong-assistant', 'root', 'assistant', 'wrong assistant'),
      message('wrong-user', 'wrong-assistant', 'user', 'wrong user'),
      { uuid: 'boundary', parentUuid: 'kept-user', type: 'system', subtype: 'compact_boundary' },
    ];

    expect(activeMessagesFromRows(rows, true).map((m) => m.text))
      .toEqual(['root', 'kept assistant', 'kept user']);
  });
});
