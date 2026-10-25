import { describe, expect, it } from 'vitest';
import { ListeningEvidence } from './listeningEvidence';
describe('listening evidence', () => {
    it('does not learn a seek to the end as a completed listen', () => {
        let time = 0;
        const tracker = new ListeningEvidence(() => time);
        tracker.observe('one', 0, true);
        time = 5000;
        tracker.observe('one', 5, true);
        time = 6000;
        tracker.observe('one', 179, true);
        time = 7000;
        tracker.observe('one', 180, false);
        expect(tracker.fraction('one', 180)).toBeCloseTo(6 / 180);
    });
    it('excludes pauses, stale notifications, and time belonging to another track', () => {
        let time = 0;
        const tracker = new ListeningEvidence(() => time);
        tracker.observe('one', 0, true);
        time = 5000;
        tracker.observe('one', 5, false);
        time = 55000;
        tracker.observe('one', 5, true);
        time = 60000;
        tracker.observe('one', 10, true);
        tracker.observe('two', 10, true);
        time = 65000;
        tracker.observe('two', 15, true);
        expect(tracker.fraction('one', 100)).toBe(0.1);
        expect(tracker.fraction('two', 100)).toBe(0.05);
        time = 100000;
        tracker.observe('two', 50, true);
        expect(tracker.fraction('two', 100)).toBe(0.05);
        tracker.reset();
        expect(tracker.fraction('one', 100)).toBe(0);
    });
});
