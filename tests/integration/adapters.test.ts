import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/config';
import { FixedClock } from '../../src/shared/time';
import { clone, emptyDatabase, PulseError, type CalendarRequest, type EmailMessage, type PulseConfig } from '../../src/shared/types';
import { FakeCalendarTransport, FakeEmailTransport, GmailTransport, GoogleCalendarTransport, MemoryRepository, SheetsRepository, SHEET_COLUMNS, encodeBase64, type CalendarApi, type GmailApi, type SheetsApi } from '../../src/adapters/index';
import { loadFixture } from '../../fixtures/load';

const message:EmailMessage={intent_id:'mail-1',to:'approved@developer.org',subject:'Volta — founder conversation',html:'<p>Fictional example &amp; UTF-8 café</p>',text:'Fictional example & UTF-8 café',message_id:'pulse-1@voltaeffect.com',is_synthetic:false,recipient_subject:'real:1'};
const request:CalendarRequest={event_id:'pulse12345abcde',conversation_id:'conversation-1',topic_label:'Enterprise sales',start_at_utc:'2026-10-20T15:00:00Z',end_at_utc:'2026-10-20T15:30:00Z',conference_request_id:'unique-conf-1',is_synthetic:false};
const approved=(extra:Partial<PulseConfig>={}):PulseConfig=>({...clone(DEFAULT_CONFIG),environment:'TEST',outreach_mode:'LIVE',gates_approved:true,reconciliation_approved:true,live_sender_address:'pulse@voltaeffect.com',live_calendar_id:'volta-calendar',auth_backend:'FIREBASE',test_recipient_allowlist:['approved@developer.org'],...extra});

describe('repository boundaries',()=>{
  it('rolls back every table when a transaction throws',()=>{
    const repo=new MemoryRepository(loadFixture()),before=repo.read();
    expect(()=>repo.transaction(db=>{db.Founders[0].email_opt_in=false;db.ConsentLog=[];throw new Error('crash');})).toThrow('crash');
    expect(repo.read()).toEqual(before);
  });
  it('does not expose mutable state and rejects nested and async transactions',()=>{
    const repo=new MemoryRepository();const read=repo.read();read.Settings.push({setting_key:'outreach_mode',setting_value:'LIVE'});expect(repo.read().Settings).toEqual([]);
    expect(()=>repo.transaction(()=>repo.transaction(()=>null))).toThrow('REPOSITORY_BUSY');
    expect(()=>repo.transaction(()=>Promise.resolve(1))).toThrow('ASYNC_TRANSACTION_FORBIDDEN');
    expect(()=>repo.transaction(db=>{db.Settings.push({setting_key:'good',setting_value:true});})).not.toThrow();
  });
  it('requires stable primary keys and unique logical keys without conflating request IDs across accounts or methods',()=>{
    const repo=new MemoryRepository(loadFixture());
    expect(()=>repo.transaction(db=>{db.Topics.push({...db.Topics[0]});})).toThrow('DUPLICATE_RECORD_ID');
    expect(()=>repo.transaction(db=>{db.AuthSessions.push({session_id:'legacy-alias',account_id:'F001'});})).toThrow('RECORD_ID_REQUIRED');
    expect(()=>repo.transaction(db=>{db.PulseEntries.push({...db.PulseEntries[0],entry_id:'new-entry'});})).toThrow('DUPLICATE_LOGICAL_KEY');
    repo.transaction(db=>{db.RequestResults.push({account_id:'F001',method:'savePulse',request_id:'shared-id',result:null},{account_id:'F025',method:'savePulse',request_id:'shared-id',result:null},{account_id:'F001',method:'getPreferences',request_id:'shared-id',result:null});});
    expect(repo.read().RequestResults).toHaveLength(3);
    expect(()=>repo.transaction(db=>{db.RequestResults.push({...db.RequestResults[0]});})).toThrow('DUPLICATE_RECORD_ID');
  });
  it('preserves typed JSON in an atomic Sheets batch, with literal strings instead of formulas',()=>{
    const tabs=new Map<string,{id:number;values:unknown[][];rowCount:number}>(),batches:unknown[][]=[];let held=false;
    const api:SheetsApi={Spreadsheets:{
      get:()=>({sheets:[...tabs].map(([title,tab])=>({properties:{title,sheetId:tab.id,gridProperties:{rowCount:tab.rowCount}}}))}),
      batchUpdate:body=>{batches.push(body.requests);for(const request of body.requests as Record<string,any>[]){if(request.addSheet){const p=request.addSheet.properties;tabs.set(p.title,{id:p.sheetId,values:[],rowCount:p.gridProperties.rowCount});}if(request.appendDimension){const tab=[...tabs.values()].find(t=>t.id===request.appendDimension.sheetId)!;tab.rowCount+=request.appendDimension.length;}if(request.updateCells){const update=request.updateCells,tab=[...tabs.values()].find(t=>t.id===(update.start?.sheetId??update.range.sheetId))!;tab.values=update.rows.map((r:any)=>r.values.map((v:any)=>v.userEnteredValue.stringValue??v.userEnteredValue.numberValue));}}},
      Values:{batchGet:(_,options)=>({valueRanges:options.ranges.map(range=>({range,values:tabs.get(range.split("'")[1])!.values}))})}
    }};
    const lock={tryLock:()=>{if(held)return false;held=true;return true;},releaseLock:()=>{held=false;}};
    const repo=new SheetsRepository('restricted-sheet',api,lock);repo.ensureSchema();expect([...tabs.values()][0].values[0]).toEqual(SHEET_COLUMNS);const migrations=batches.length;repo.ensureSchema();expect(batches.length).toBe(migrations);
    repo.transaction(db=>Object.assign(db,loadFixture()));const importBatches=batches.length;
    repo.transaction(db=>{db.PulseEntries[0].private_context='=IMPORTXML("https://invalid","*")';db.PulseEntries[0].revision=2;db.ConsentLog.push({consent_event_id:'c-new',scope:'ENTRY_USE',permission_value:'PRIVATE_MATCH_ONLY'});});
    expect(batches.length).toBe(importBatches+1);expect(batches[batches.length-1]?.length).toBe(2);expect(repo.read().PulseEntries[0].private_context).toContain('=IMPORTXML');expect(repo.read().PulseEntries[0].revision).toBe(2);
    expect(JSON.stringify(batches[batches.length-1])).not.toContain('formulaValue');expect(held).toBe(false);
  });
});

describe('fake transports',()=>{
  it('simulates accepted-but-uncertain mail and reconciles it without a second send',()=>{
    const fake=new FakeEmailTransport(new FixedClock());fake.failNext('UNKNOWN_AFTER');expect(()=>fake.send(message)).toThrow('FAKE_TIMEOUT_AFTER_WRITE');expect(fake.messages).toHaveLength(1);expect(fake.reconcile(message.message_id)?.simulated).toBe(true);expect(fake.send(message).provider_id).toBe('fake-mail-1');expect(fake.messages).toHaveLength(1);
  });
  it('never invites attendees while a conference is pending and preserves deterministic event ID',()=>{
    const fake=new FakeCalendarTransport();fake.conferencePending=true;expect(fake.reserve(request).conference_status).toBe('PENDING');expect(()=>fake.invite(request.event_id,[])).toThrow('CONFERENCE_NOT_READY');fake.ready(request.event_id);fake.invite(request.event_id,[{founder_id:'F001',email:message.to,name:'Example',company_name:'ExampleCo',is_synthetic:true}]);fake.reserve(request);expect(fake.events.size).toBe(1);expect(fake.events.get(request.event_id)?.attendee_emails).toEqual([message.to]);
  });
  it('resets every fake provider record and failure switch between scenarios',()=>{
    const email=new FakeEmailTransport(),calendar=new FakeCalendarTransport();email.send(message);email.failNext('UNKNOWN_AFTER');calendar.seed(request);calendar.conferencePending=true;calendar.hasConflictOverride=true;calendar.failNext('UNKNOWN_AFTER');email.reset();calendar.reset();
    expect(email.messages).toEqual([]);expect(email.trace).toEqual([]);expect(email.receipts.size).toBe(0);expect(email.nextFault).toBeNull();
    expect(calendar.trace).toEqual([]);expect(calendar.events.size).toBe(0);expect(calendar.nextFault).toBeNull();expect(calendar.conferencePending).toBe(false);expect(calendar.hasConflictOverride).toBe(false);
  });
});

describe('real transport gates and wire contracts',()=>{
  it('DEMO, empty TEST allowlist and synthetic LIVE records fail before an API call',()=>{
    let calls=0;const api:GmailApi={Users:{Messages:{send:()=>{calls++;return{id:'provider'};},list:()=>({}),get:()=>({})}}};
    expect(()=>new GmailTransport(DEFAULT_CONFIG,api).send(message)).toThrow('DEMO_EXTERNAL_TRANSPORT_BLOCKED');
    expect(()=>new GmailTransport(approved({test_recipient_allowlist:[]}),api).send(message)).toThrow('TEST_RECIPIENT_NOT_ALLOWLISTED');
    expect(()=>new GmailTransport(approved(),api).send({...message,is_synthetic:true})).toThrow('SYNTHETIC_TEST_RECIPIENT_BLOCKED');
    expect(()=>new GmailTransport(approved(),api).send({...message,recipient_subject:'demo:developer'})).toThrow('SYNTHETIC_TEST_RECIPIENT_BLOCKED');
    expect(()=>new GmailTransport(approved({environment:'LIVE'}),api).send({...message,is_synthetic:true})).toThrow('SYNTHETIC_LIVE_RECIPIENT_BLOCKED');
    expect(()=>new GmailTransport(approved({environment:'LIVE'}),api).send({...message,to:'person@volta.example.com'})).toThrow('SYNTHETIC_LIVE_RECIPIENT_BLOCKED');expect(calls).toBe(0);
  });
  it('uses encoded UTF-8 MIME alternatives, stable Message-ID and only approved reconciliation',()=>{
    let raw='',query='';const api:GmailApi={Users:{Messages:{send:r=>{raw=r.raw;return{id:'provider-1'};},list:(_,options)=>{query=options.q;return{messages:[{id:'provider-1'}]};},get:()=>({id:'provider-1',internalDate:String(Date.parse('2026-10-13T12:00:00Z'))})}}};
    const config=approved(),transport=new GmailTransport(()=>config,api,new FixedClock());expect(transport.send(message).simulated).toBe(false);
    const mime=Buffer.from(raw,'base64url').toString('utf8');expect(mime).toContain('From: Volta Pulse <pulse@voltaeffect.com>');expect(mime).toContain('Message-ID: <pulse-1@voltaeffect.com>');expect(mime).toContain('multipart/alternative');expect(mime).toContain('Content-Type: text/plain');expect(mime).toContain('Content-Type: text/html');expect(mime).toContain(encodeBase64(message.text));
    expect(transport.reconcile(message.message_id)?.sent_at_utc).toBe('2026-10-13T12:00:00Z');expect(query).toContain('rfc822msgid:pulse-1@voltaeffect.com');config.reconciliation_approved=false;expect(()=>transport.reconcile(message.message_id)).toThrow('RECONCILIATION_NOT_APPROVED');config.outreach_mode='PAUSED';expect(()=>transport.send(message)).toThrow('OUTREACH_MODE_BLOCKED');
  });
  it('rejects header injection and never queries fixture Calendar IDs',()=>{
    let calls=0;const api:CalendarApi={Events:{get:()=>{calls++;throw new Error('404 Not found');},insert:()=>({}),patch:()=>({}),remove:()=>{},list:()=>({})}};
    const calendar=new GoogleCalendarTransport(approved(),api);expect(()=>calendar.get('FAKE_EVENT_NEVER_CALL_API')).toThrow('FIXTURE_CALENDAR_EVENT_BLOCKED');expect(calls).toBe(0);
    expect(()=>new GmailTransport(approved()).send({...message,subject:'safe\r\nBcc: unexpected@recipient.org'})).toThrow('INVALID_EMAIL_HEADER');
  });
  it('reserves organizer-only and issues native invitations only after Meet is READY',()=>{
    let stored:Record<string,any>|null=null;const trace:string[]=[],api:CalendarApi={Events:{
      get:()=>{if(!stored)throw{code:404};return stored;},
      insert:(resource,_,options)=>{trace.push(`insert:${options.sendUpdates}`);stored={...resource,conferenceData:{createRequest:{status:{statusCode:'pending'}}}};return stored;},
      patch:(resource,_,__,options)=>{trace.push(`patch:${options.sendUpdates}`);stored={...stored,...resource};return stored;},remove:()=>{},list:()=>({})
    }};
    const calendar=new GoogleCalendarTransport(approved(),api);expect(calendar.reserve(request).conference_status).toBe('PENDING');expect(stored!.attendees).toEqual([]);expect(()=>calendar.invite(request.event_id,[])).toThrow('CONFERENCE_NOT_READY');
    stored!.conferenceData={entryPoints:[{entryPointType:'video',uri:'https://meet.google.com/abc-defg-hij'}],createRequest:{status:{statusCode:'success'}}};
    calendar.invite(request.event_id,[{founder_id:'F001',email:message.to,name:'Approved',company_name:'ApprovedCo',is_synthetic:false}]);calendar.reserve(request);expect(trace).toEqual(['insert:none','patch:all']);
  });
  it('rejects a synthetic TEST event before touching Google, even with approved developer destinations',()=>{
    let calls=0;const api:CalendarApi={Events:{get:()=>{calls++;throw{code:404};},insert:()=>{calls++;return{};},patch:()=>({}),remove:()=>{},list:()=>({})}};
    expect(()=>new GoogleCalendarTransport(approved(),api).reserve({...request,is_synthetic:true})).toThrow('SYNTHETIC_TEST_EVENT_BLOCKED');expect(calls).toBe(0);
  });
  it('permits only audited privacy removal/cancellation while PAUSED and keeps reserve/invite closed',()=>{
    const event:Record<string,any>={id:request.event_id,start:{dateTime:request.start_at_utc},end:{dateTime:request.end_at_utc},extendedProperties:{private:{pulse_managed:'true',pulse_synthetic:'false'}},attendees:[{email:message.to}],conferenceData:{entryPoints:[{entryPointType:'video',uri:'https://meet.google.com/abc-defg-hij'}]}};
    const trace:string[]=[],api:CalendarApi={Events:{get:()=>event,insert:()=>{trace.push('insert');return event;},patch:resource=>{trace.push('remove');Object.assign(event,resource);return event;},remove:()=>{trace.push('cancel');event.status='cancelled';},list:()=>({})}},config=approved({outreach_mode:'PAUSED'}),calendar=new GoogleCalendarTransport(()=>config,api),permit={actor_account_id:'staff-1',audit_id:'audited-explicit-request'};
    expect(()=>calendar.reserve(request)).toThrow('OUTREACH_MODE_BLOCKED');expect(()=>calendar.invite(request.event_id,[])).toThrow('OUTREACH_MODE_BLOCKED');expect(()=>calendar.cancel(request.event_id)).toThrow('OUTREACH_MODE_BLOCKED');expect(()=>calendar.cancel(request.event_id,{actor_account_id:'',audit_id:'forged'})).toThrow('INVALID_PRIVACY_AUTHORIZATION');expect(trace).toEqual([]);
    expect(calendar.removeAttendee(request.event_id,message.to,permit).attendee_emails).toEqual([]);expect(calendar.cancel(request.event_id,permit).cancelled).toBe(true);expect(trace).toEqual(['remove','cancel']);
    config.outreach_mode='DRAFT_ONLY';expect(()=>calendar.cancel(request.event_id,permit)).toThrow('OUTREACH_MODE_BLOCKED');
  });
  it('fails closed when an existing managed event no longer matches the authorized times',()=>{
    const existing={id:request.event_id,start:{dateTime:'2026-10-20T16:00:00Z'},end:{dateTime:'2026-10-20T16:30:00Z'},extendedProperties:{private:{pulse_managed:'true',pulse_synthetic:'false'}}};let inserts=0;
    const api:CalendarApi={Events:{get:()=>existing,insert:()=>{inserts++;return existing;},patch:()=>existing,remove:()=>{},list:()=>({})}};
    expect(()=>new GoogleCalendarTransport(approved(),api).reserve(request)).toThrow('MANAGED_EVENT_TIME_MISMATCH');expect(inserts).toBe(0);
  });
});
