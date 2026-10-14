import type { Repository } from '../shared/contracts';
import { bool, plusDays, str, type Database, type Row } from '../shared/types';
import { renderEmail, type EmailKind } from '../email/index';
import { stableHash } from '../jobs/index';

export const DEMO_SCHEDULING_GROUP_ID = 'DEMO-GROUP-US-EXPANSION';
export const DEMO_STORY_GROUP_ID = 'DEMO-GROUP-FIRST-SALESPERSON';
export const DEMO_STORY_ID = 'DEMO-STORY-FIRST-SALESPERSON';

const SCHEDULING_FOUNDERS = ['F004', 'F005', 'F006'];
const STORY_FOUNDERS = ['F001', 'F002', 'F003'];

function founder(db: Database, founderId: string): Row {
  const row = db.Founders.find(item => str(item, 'founder_id') === founderId);
  if (!row) throw new Error(`Demo founder ${founderId} is missing.`);
  return row;
}

function companyId(db: Database, founderId: string): string {
  return str(founder(db, founderId), 'company_id');
}

function addMember(db: Database, conversationId: string, founderId: string, role: string, status: string, selectedAt: string): void {
  db.ConversationMembers.push({
    conversation_id: conversationId,
    founder_id: founderId,
    company_id: companyId(db, founderId),
    participation_role: role,
    status,
    booking_state: status,
    selected_at_utc: selectedAt,
    updated_at_utc: selectedAt,
    is_synthetic: true,
    revision: 1,
    demo_showcase: true,
  });
}

function addInterest(db: Database, conversationId: string, founderId: string, topicId: string, role: string, respondedAt: string): void {
  db.InterestResponses.push({
    response_id: `DEMO-INTEREST-${conversationId}-${founderId}`,
    conversation_id: conversationId,
    founder_id: founderId,
    topic_id: topicId,
    participation_role: role,
    response: 'INTERESTED',
    responded_at_utc: respondedAt,
    expires_at_utc: plusDays(respondedAt, 14),
    identity_disclosure_consent: false,
    is_synthetic: true,
    demo_showcase: true,
  });
}

function addDraft(db: Database, kind: EmailKind, founderId: string, conversationId: string, topicLabel: string, now: string, appUrl: string, extra: Row = {}): void {
  const uniqueKey = `DEMO_PREVIEW:${kind}:${conversationId}:${founderId}`;
  if (db.WeeklyEmails.some(row => str(row, 'unique_key') === uniqueKey)) return;
  const owner = founder(db, founderId);
  const account = db.Accounts.find(row => str(row, 'founder_id') === founderId) ?? {};
  const rendered = renderEmail(kind, {
    first_name: str(owner, 'full_name').split(' ')[0],
    conversation_id: conversationId,
    topic_label: topicLabel,
    story_id: str(extra, 'story_id'),
    story_text: str(extra, 'story_text'),
  }, appUrl);
  db.WeeklyEmails.push({
    email_id: `demo-mail-${stableHash(uniqueKey)}`,
    unique_key: uniqueKey,
    founder_id: founderId,
    recipient_account_id: str(account, 'account_id'),
    recipient_email: str(owner, 'email'),
    type: kind,
    mode: 'DRAFT_ONLY',
    status: 'DRAFT',
    message_id: `pulse-${stableHash(uniqueKey)}@pulse.volta.invalid`,
    render_revision: 1,
    attempts: 0,
    created_at_utc: now,
    updated_at_utc: now,
    provider_id: null,
    sent_at_utc: null,
    error_code: null,
    conversation_id: conversationId,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    content_hash: stableHash(JSON.stringify(rendered)),
    is_synthetic: bool(owner, 'is_synthetic'),
    demo_preview: true,
    ...extra,
  });
}

/**
 * Adds a compact fictional lifecycle to the local demo only. It is separate from
 * the workbook oracle so reference matching counts and production seeds stay fixed.
 */
export function seedDemoEmailDrafts(repo: Repository, now: string, appUrl: string): void {
  repo.transaction(db => {
    if (db.Conversations.some(row => str(row, 'conversation_id') === DEMO_SCHEDULING_GROUP_ID)) return;

    const scheduleCreated = now;
    db.Conversations.push({
      conversation_id: DEMO_SCHEDULING_GROUP_ID,
      topic_id: 'T05',
      status: 'SCHEDULING',
      created_at_utc: scheduleCreated,
      poll_closes_at_utc: plusDays(scheduleCreated, 5),
      minimum_companies: 3,
      maximum_participants: 5,
      meeting_minutes: 30,
      calendar_event_id: null,
      selected_slot_id: null,
      is_synthetic: true,
      revision: 1,
      demo_showcase: true,
    });
    db.TimeSlots.push(
      { slot_id: 'DEMO-SLOT-US-A', conversation_id: DEMO_SCHEDULING_GROUP_ID, option_label: 'A', start_at_utc: '2026-10-20T15:00:00Z', end_at_utc: '2026-10-20T15:30:00Z', display_timezone: 'America/Halifax', minimum_notice_hours: 48, is_synthetic: true, revision: 1, demo_showcase: true },
      { slot_id: 'DEMO-SLOT-US-B', conversation_id: DEMO_SCHEDULING_GROUP_ID, option_label: 'B', start_at_utc: '2026-10-22T15:00:00Z', end_at_utc: '2026-10-22T15:30:00Z', display_timezone: 'America/Halifax', minimum_notice_hours: 48, is_synthetic: true, revision: 1, demo_showcase: true },
    );
    const schedulingRoles = ['WORKING_THROUGH', 'LIVED_THROUGH', 'WORKING_THROUGH'];
    SCHEDULING_FOUNDERS.forEach((founderId, index) => {
      addInterest(db, DEMO_SCHEDULING_GROUP_ID, founderId, 'T05', schedulingRoles[index], scheduleCreated);
      addMember(db, DEMO_SCHEDULING_GROUP_ID, founderId, schedulingRoles[index], 'RESERVED', scheduleCreated);
    });

    const completedAt = '2026-10-10T15:30:00Z';
    db.Conversations.push({
      conversation_id: DEMO_STORY_GROUP_ID,
      topic_id: 'T01',
      status: 'COMPLETED',
      created_at_utc: '2026-10-01T12:00:00Z',
      poll_closes_at_utc: '2026-10-05T12:00:00Z',
      minimum_companies: 3,
      maximum_participants: 5,
      meeting_minutes: 30,
      calendar_event_id: 'FAKE_DEMO_EVENT_FIRST_SALESPERSON',
      selected_slot_id: 'DEMO-SLOT-STORY-A',
      completed_at_utc: completedAt,
      is_synthetic: true,
      revision: 1,
      demo_showcase: true,
    });
    db.TimeSlots.push({ slot_id: 'DEMO-SLOT-STORY-A', conversation_id: DEMO_STORY_GROUP_ID, option_label: 'A', start_at_utc: '2026-10-10T15:00:00Z', end_at_utc: completedAt, display_timezone: 'America/Halifax', minimum_notice_hours: 48, is_synthetic: true, revision: 1, demo_showcase: true });
    const storyRoles = ['WORKING_THROUGH', 'LIVED_THROUGH', 'WORKING_THROUGH'];
    STORY_FOUNDERS.forEach((founderId, index) => {
      addInterest(db, DEMO_STORY_GROUP_ID, founderId, 'T01', storyRoles[index], '2026-09-30T12:00:00Z');
      addMember(db, DEMO_STORY_GROUP_ID, founderId, storyRoles[index], 'COMPLETED', '2026-10-01T12:00:00Z');
    });
    db.Feedback.push({
      feedback_id: 'DEMO-FEEDBACK-STORY',
      conversation_id: DEMO_STORY_GROUP_ID,
      founder_id: 'F001',
      company_id: companyId(db, 'F001'),
      topic_id: 'T01',
      attendance_status: 'attended',
      helped_boolean: true,
      feedback_text: 'We revised the scorecard for our first salesperson interviews.',
      sharing_permission: 'anonymous_story',
      attended: true,
      usefulness: 'YES',
      next_step: 'We revised the scorecard for our first salesperson interviews.',
      follow_on_contact: 'PLANNED',
      story_requested: true,
      created_at_utc: '2026-10-12T12:00:00Z',
      updated_at_utc: '2026-10-12T12:00:00Z',
      is_synthetic: true,
      demo_showcase: true,
    });
    const storyText = 'A Volta founder reported that a founder conversation about hiring the first salesperson helped: We revised the scorecard for our first salesperson interviews.';
    db.Stories.push({
      story_id: DEMO_STORY_ID,
      topic_id: 'T01',
      source_feedback_id: 'DEMO-FEEDBACK-STORY',
      approved_text: storyText,
      sharing_mode: 'ANONYMOUS',
      status: 'DRAFT',
      version: 1,
      required_approver_ids: [],
      sharing_permission: 'anonymous_story',
      draft_text: storyText,
      detail_level: 'HIGH',
      source_facts_used: ['topic', 'helped_boolean', 'feedback_text'],
      review_required: true,
      expires_at_utc: plusDays(now, 180),
      is_synthetic: true,
      demo_showcase: true,
    });
    db.Exceptions.push({
      exception_id: 'DEMO-STORY-DRAFT-REVIEW',
      type: 'STORY_DRAFT_REVIEW',
      target_id: DEMO_STORY_ID,
      severity: 'LOW',
      owner: 'STAFF',
      created_at_utc: now,
      summary: 'Review the AI-assisted story draft against the founder feedback and sharing permission.',
      is_synthetic: true,
      demo_showcase: true,
    });

    addDraft(db, 'SCHEDULING', 'F004', DEMO_SCHEDULING_GROUP_ID, 'Entering the US market', now, appUrl);
    addDraft(db, 'FEEDBACK', 'F003', DEMO_STORY_GROUP_ID, 'Hiring the first salesperson', now, appUrl);
  });
}
