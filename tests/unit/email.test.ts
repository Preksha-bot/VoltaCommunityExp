import { describe, expect, it } from 'vitest';
import { renderEmail } from '../../src/email/index';

describe('founder opportunity email copy', () => {
  it('does not repeat the group threshold and booking disclaimer after the cards', () => {
    const email = renderEmail('DIGEST', {
      first_name: 'Maya',
      cards: [{ topic_label: 'Entering the US market', participation_role: 'WORKING_THROUGH', opportunity_id: 'opp-1', other_founder_count: 3 }],
    }, 'http://127.0.0.1:5173');

    const removed = "If at least three founders from different companies are interested, we'll offer times for a 30-minute online conversation. No one has been booked yet.";
    expect(email.html).not.toContain(removed);
    expect(email.text).not.toContain(removed);
  });
});
