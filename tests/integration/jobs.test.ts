import {describe,expect,it} from 'vitest';
import {loadFixture,FIXTURE_NOW} from '../../fixtures/load';
import {DEFAULT_CONFIG} from '../../src/shared/config';
import {FixedClock} from '../../src/shared/time';
import {bool,clone,plusDays,str,type Database,type PulseConfig} from '../../src/shared/types';
import {FakeCalendarTransport,FakeEmailTransport,MemoryRepository} from '../../src/adapters/index';
import {PulseJobs,generateSlots} from '../../src/jobs/index';

function setup(profile='BASE',overrides:Partial<PulseConfig>={}){const seed=loadFixture(profile);for(const account of seed.Accounts)if(account.role==='ADMIN')delete account.contact_email;const clock=new FixedClock(),repo=new MemoryRepository(seed),email=new FakeEmailTransport(clock),calendar=new FakeCalendarTransport(),config={...clone(DEFAULT_CONFIG),...overrides},jobs=new PulseJobs(repo,email,calendar,clock,config);return{clock,repo,email,calendar,config,jobs};}
function setMode(repo:MemoryRepository,value:string){repo.transaction(db=>{db.Settings.find(s=>s.setting_key==='outreach_mode')!.setting_value=value;});}
describe('weekly durable outbox',()=>{
  it('queues one private-data-free staff summary per active registered staff contact and week',()=>{
    const {jobs,repo,email}=setup();repo.transaction(db=>{db.Accounts.find(a=>a.role==='ADMIN')!.contact_email='laura.demo@example.com';});
    expect(jobs.runWeeklyMatching().queued).toBe(21);jobs.runWeeklyMatching();const staff=repo.read().WeeklyEmails.filter(e=>e.type==='STAFF_SUMMARY');expect(staff).toHaveLength(1);expect(staff[0].founder_id).toBeNull();expect(staff[0].text).toContain('21 founder digests prepared');expect(staff[0].text).not.toContain('Comparing approaches');expect(staff[0].text).not.toContain('Maya Chen');
    expect(jobs.processOutbox(true).sent).toBe(22);expect(email.messages.filter(m=>m.to==='laura.demo@example.com')).toHaveLength(1);
  });
  it('reports an unconfigured staff contact rather than inventing a destination',()=>{
    const {jobs,repo}=setup();jobs.runWeeklyMatching();expect(repo.read().WeeklyEmails.some(e=>e.type==='STAFF_SUMMARY')).toBe(false);expect(repo.read().Exceptions.some(e=>e.type==='STAFF_CONTACT_NOT_CONFIGURED')).toBe(true);
  });
  it('produces 21 recipient drafts without consuming novelty or contacting a provider',()=>{
    const {jobs,repo,email,calendar}=setup();const before=repo.read().OutreachHistory.length,run=jobs.runWeeklyMatching();expect(run.queued).toBe(21);expect(jobs.runWeeklyMatching().already_run).toBe(true);expect(jobs.processOutbox().drafted).toBe(21);expect(email.messages).toHaveLength(0);expect(calendar.trace).toHaveLength(0);expect(repo.read().OutreachHistory).toHaveLength(before);
    const first=repo.read().WeeklyEmails.find(e=>e.founder_id==='F001'&&e.status==='DRAFT')!;expect(first.text).toContain('Hiring the first salesperson');expect(first.text).toContain('Pricing a first paid offer');expect(first.text).toContain('Preparing a seed round');expect(first.text).not.toContain('Comparing approaches to hiring the first salesperson.');
  });
  it('commits edges and a seven-day response deadline only after simulated success',()=>{
    const {jobs,repo,email}=setup();jobs.runWeeklyMatching();const outcome=jobs.processOutbox(true);expect(outcome.sent).toBe(21);expect(email.messages).toHaveLength(21);const first=repo.read().Opportunities.find(o=>o.founder_id==='F001')!;expect(first.status).toBe('OFFERED');expect(first.expires_at_utc).toBe(plusDays(FIXTURE_NOW,7));expect(repo.read().OutreachHistory.filter(h=>h.email_id===first.email_id).length).toBe(3);expect(jobs.processOutbox(true).sent).toBe(0);
  });
  it('quarantines uncertain mail, then reconciles rather than resending',()=>{
    const {jobs,repo,email}=setup();jobs.runWeeklyMatching();email.failNext('UNKNOWN_AFTER');expect(jobs.processOutbox(true).unknown).toBe(1);const unknown=repo.read().WeeklyEmails.find(e=>e.status==='UNKNOWN')!;expect(unknown).toBeDefined();const sentCalls=email.trace.filter(t=>t.action==='send').length;expect(jobs.processOutbox(true).reconciled).toBe(1);expect(email.trace.filter(t=>t.action==='send')).toHaveLength(sentCalls);expect(repo.read().WeeklyEmails.find(e=>e.email_id===unknown.email_id)?.status).toBe('SENT');
  });
  it('does not blindly retry an uncertainty with no provider receipt',()=>{
    const {jobs,repo,email}=setup();jobs.runWeeklyMatching();email.failNext('UNKNOWN_BEFORE');jobs.processOutbox(true);const calls=email.trace.filter(t=>t.action==='send').length;expect(jobs.processOutbox(true).unknown).toBe(1);expect(email.trace.filter(t=>t.action==='send')).toHaveLength(calls);expect(repo.read().WeeklyEmails.filter(e=>e.status==='UNKNOWN')).toHaveLength(1);
  });
  it('rechecks opt-out and global pause against already queued messages',()=>{
    const {jobs,repo,email}=setup();jobs.runWeeklyMatching();repo.transaction(db=>{db.Founders.find(f=>f.founder_id==='F001')!.email_opt_in=false;});setMode(repo,'PAUSED');expect(jobs.processOutbox(true).paused).toBe(true);expect(email.messages).toHaveLength(0);setMode(repo,'DRAFT_ONLY');jobs.processOutbox(true);expect(email.messages.some(m=>m.to===str(repo.read().Founders.find(f=>f.founder_id==='F001')!,'email'))).toBe(false);expect(repo.read().WeeklyEmails.find(e=>e.founder_id==='F001'&&e.matching_week_key==='2026-10-12')?.status).toBe('CANCELLED');
  });
  it('anchors no-response cooldown at delivery deadline rather than housekeeping date',()=>{
    const {jobs,repo,clock}=setup();jobs.runWeeklyMatching();jobs.processOutbox(true);clock.advance(10);jobs.housekeeping();const history=repo.read().OutreachHistory.find(h=>h.founder_id==='F001'&&h.sent_at_utc===FIXTURE_NOW)!;expect(history.response).toBe('NO_RESPONSE');expect(history.cooldown_until_utc).toBe(plusDays(FIXTURE_NOW,37));
  });
  it('never duplicates a sent current-week fixture intent',()=>{
    const {jobs,repo,email}=setup('RETRY_SENT');jobs.runWeeklyMatching();jobs.processOutbox(true);expect(email.messages.some(m=>m.to===str(repo.read().Founders.find(f=>f.founder_id==='F001')!,'email'))).toBe(false);
  });
});

describe('group booking lifecycle',()=>{
  it('books G001 once, with no attendee exposure until conference readiness',()=>{
    const {jobs,repo,calendar}=setup('GROUP_READY');calendar.conferencePending=true;expect(jobs.evaluateBooking('G001',true).status).toBe('BOOKING_PENDING');const group=repo.read().Conversations.find(g=>g.conversation_id==='G001')!,eventId=str(group,'calendar_event_id');expect(calendar.events.get(eventId)?.attendee_emails).toEqual([]);calendar.ready(eventId);expect(jobs.evaluateBooking('G001',true).status).toBe('CONFIRMED');expect(jobs.evaluateBooking('G001',true).status).toBe('CONFIRMED');expect(calendar.events.size).toBe(1);expect(calendar.trace.filter(t=>t.action==='invite')).toHaveLength(1);expect(calendar.events.get(eventId)?.attendee_emails).toHaveLength(3);
  });
  it('reconciles an uncertain Calendar reserve using the same event ID',()=>{
    const {jobs,repo,calendar}=setup('GROUP_READY');calendar.failNext('UNKNOWN_AFTER');expect(jobs.evaluateBooking('G001',true).status).toBe('BOOKING_UNKNOWN');const eventId=str(repo.read().Conversations.find(g=>g.conversation_id==='G001')!,'calendar_event_id');expect(jobs.evaluateBooking('G001',true).status).toBe('CONFIRMED');expect(calendar.events.size).toBe(1);expect(calendar.trace.filter(t=>t.action==='reserve')).toHaveLength(1);expect(str(repo.read().Conversations.find(g=>g.conversation_id==='G001')!,'calendar_event_id')).toBe(eventId);
  });
  it('holds without a common slot and closes the poll without a scheduling chase',()=>{
    const {jobs,repo,clock,calendar}=setup('NO_COMMON_SLOT');expect(jobs.evaluateBooking('G002',true).reason_code).toBe('NO_COMMON_SLOT');clock.advance(4);expect(jobs.housekeeping().polls_closed).toBe(1);expect(repo.read().Conversations.find(g=>g.conversation_id==='G002')?.status).toBe('NO_COMMON_SLOT');expect(calendar.events.size).toBe(0);expect(repo.read().WeeklyEmails.filter(e=>e.type==='POLL_CLOSED')).toHaveLength(3);expect(jobs.processOutbox(true).sent).toBe(3);
  });
  it('withdrawal before booking lowers quorum and sends no invitation',()=>{
    const {jobs,repo,calendar}=setup('GROUP_READY');repo.transaction(db=>{db.InterestResponses.find(r=>r.conversation_id==='G001'&&r.founder_id==='F003')!.response='WITHDRAWN';});expect(jobs.evaluateBooking('G001',true).reason_code).toBe('INSUFFICIENT_COMPANIES');expect(calendar.events.size).toBe(0);
  });
  it('withdrawal after booking cancels a future group below three companies',()=>{
    const {jobs,repo,calendar}=setup('GROUP_READY');jobs.evaluateBooking('G001',true);repo.transaction(db=>{db.InterestResponses.find(r=>r.conversation_id==='G001'&&r.founder_id==='F003')!.response='WITHDRAWN';const m=db.ConversationMembers.find(r=>r.conversation_id==='G001'&&r.founder_id==='F003')!;m.status='WITHDRAWN';});jobs.housekeeping();expect(repo.read().Conversations.find(g=>g.conversation_id==='G001')?.status).toBe('CANCELLED');expect([...calendar.events.values()][0].cancelled).toBe(true);
  });
  it('does not equate email opt-out with withdrawal from an already accepted meeting',()=>{
    const {jobs,repo,calendar}=setup('GROUP_READY');repo.transaction(db=>{db.Founders.find(r=>r.founder_id==='F001')!.email_opt_in=false;});expect(jobs.evaluateBooking('G001',true).status).toBe('CONFIRMED');expect([...calendar.events.values()][0].attendee_emails).toHaveLength(3);
  });
  it('PAUSED blocks all new Calendar writes and makes privacy cancellation an exception',()=>{
    const {jobs,repo,calendar}=setup('GROUP_READY');setMode(repo,'PAUSED');expect(jobs.evaluateBooking('G001',true).reason_code).toBe('GLOBAL_PAUSED');expect(calendar.trace).toHaveLength(0);setMode(repo,'DRAFT_ONLY');jobs.evaluateBooking('G001',true);repo.transaction(db=>{db.InterestResponses.find(r=>r.conversation_id==='G001'&&r.founder_id==='F003')!.response='WITHDRAWN';});setMode(repo,'PAUSED');jobs.housekeeping();expect([...calendar.events.values()][0].cancelled).toBe(false);expect(repo.read().Exceptions.some(e=>e.type==='PAUSED_PRIVACY_CANCELLATION_REQUIRED')).toBe(true);
  });
  it('completes elapsed meetings without inventing attendance and sends feedback once',()=>{
    const {jobs,repo,clock,email}=setup('GROUP_READY');jobs.evaluateBooking('G001',true);clock.value='2026-10-21T16:00:00Z';expect(jobs.housekeeping().feedback_queued).toBe(3);expect(repo.read().Feedback).toHaveLength(0);expect(jobs.processOutbox(true).sent).toBe(3);jobs.housekeeping();expect(jobs.processOutbox(true).sent).toBe(0);expect(email.messages).toHaveLength(3);
  });
  it('converts future Halifax windows with the November offset rather than October offset',()=>{
    const slots=generateSlots('group-dst','2026-10-31T12:00:00Z',DEFAULT_CONFIG,true);expect(slots[0].start_at_utc).toBe('2026-11-03T16:00:00Z');expect(new Set(slots.map(s=>str(s,'start_at_utc').slice(0,10))).size).toBe(2);
  });
  it('detects stale jobs even if a failed trigger wrote no error',()=>{
    const {jobs,repo}=setup();expect(jobs.monitor().stale_jobs).toEqual(['weekly','worker','housekeeping']);expect(repo.read().Exceptions.filter(e=>e.type==='STALE_JOB')).toHaveLength(3);jobs.monitor();expect(repo.read().Exceptions.filter(e=>e.type==='STALE_JOB')).toHaveLength(3);
  });
});
