import { expect, it } from 'vitest';
import { loadFixture, FIXTURE_NOW } from '../../fixtures/load';
import { FakeCalendarTransport, FakeEmailTransport, MemoryRepository } from '../../src/adapters';
import { seedDemoEmailDrafts, DEMO_SCHEDULING_GROUP_ID, DEMO_STORY_ID } from '../../src/demo/email-drafts';
import { PulseJobs } from '../../src/jobs';
import { readConfig } from '../../src/shared/config';
import { FixedClock } from '../../src/shared/time';
import { str } from '../../src/shared/types';

it('preloads valid meeting and feedback emails plus a staff-review story draft in the local demo', () => {
  const repo = new MemoryRepository(loadFixture());
  const clock = new FixedClock(FIXTURE_NOW);
  const config = readConfig(repo.read());
  const email = new FakeEmailTransport(clock);
  const jobs = new PulseJobs(repo, email, new FakeCalendarTransport(), clock, config);

  seedDemoEmailDrafts(repo, clock.now(), config.app_url);
  seedDemoEmailDrafts(repo, clock.now(), config.app_url);

  const db = repo.read();
  const groupMembers = db.ConversationMembers.filter(row => row.conversation_id === DEMO_SCHEDULING_GROUP_ID);
  expect(new Set(groupMembers.map(row => row.company_id)).size).toBe(3);

  const drafts = db.WeeklyEmails.filter(row => row.demo_preview === true);
  expect(drafts.map(row => row.type).sort()).toEqual(['FEEDBACK', 'SCHEDULING']);
  expect(drafts).toHaveLength(2);

  const scheduling = drafts.find(row => row.type === 'SCHEDULING')!;
  expect(str(scheduling, 'text')).toContain('At least three founders from different companies');
  expect(str(scheduling, 'text')).toContain('Entering the US market');

  const feedback = drafts.find(row => row.type === 'FEEDBACK')!;
  expect(str(feedback, 'subject')).toBe('Did this founder conversation help?');
  expect(str(feedback, 'text')).toContain('Yes:');
  expect(str(feedback, 'text')).toContain('I didn’t attend:');

  const story = db.Stories.find(row => row.story_id === DEMO_STORY_ID)!;
  expect(story.status).toBe('DRAFT');
  expect(story.review_required).toBe(true);
  expect(str(story, 'approved_text')).toContain('We revised the scorecard');
  expect(db.StoryApprovals.filter(row => row.story_id === DEMO_STORY_ID)).toHaveLength(0);

  expect(jobs.processOutbox(true).sent).toBe(2);
  expect(email.messages).toHaveLength(2);
});
