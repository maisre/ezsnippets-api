import { aboutForInstance, instanceKeys, isRepeat, REPEAT_NOTE } from './snippet-instances';

describe('instanceKeys', () => {
  it('keeps the bare id for a first use and numbers the repeats', () => {
    expect(instanceKeys(['a', 'b', 'a', 'c', 'a', 'b'])).toEqual([
      'a', 'b', 'a#1', 'c', 'a#2', 'b#1',
    ]);
  });

  it('marks only repeats, and only repeats get the note', () => {
    expect(isRepeat('a')).toBe(false);
    expect(isRepeat('a#1')).toBe(true);
    expect(aboutForInstance('Hero', 'a')).toBe('Hero');
    expect(aboutForInstance('Hero', 'a#1')).toBe(`Hero ${REPEAT_NOTE}`);
    expect(aboutForInstance(undefined, 'a#1')).toBe(REPEAT_NOTE);
  });
});
