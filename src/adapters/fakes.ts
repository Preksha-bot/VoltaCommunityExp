import type { CalendarTransport, Clock, EmailTransport } from '../shared/contracts';
import { clone, PulseError, TransportError, type CalendarAttendee, type CalendarPrivacyAuthorization, type CalendarReceipt, type CalendarRequest, type EmailMessage, type EmailReceipt } from '../shared/types';
import { SystemClock } from '../shared/time';

export type FakeFault = 'DEFINITE' | 'UNKNOWN_BEFORE' | 'UNKNOWN_AFTER';
export class FakeEmailTransport implements EmailTransport {
  readonly kind = 'FAKE';
  readonly messages: EmailMessage[] = [];
  readonly receipts = new Map<string, EmailReceipt>();
  readonly trace: { action: string; id: string }[] = [];
  nextFault: FakeFault | null = null;
  constructor(private clock: Clock = new SystemClock()) {}
  reset():void {this.messages.length=0;this.receipts.clear();this.trace.length=0;this.nextFault=null;}
  failNext(fault: FakeFault): void { this.nextFault = fault; }
  send(message: EmailMessage): EmailReceipt {
    this.trace.push({ action:'send', id:message.message_id });
    const fault = this.nextFault; this.nextFault = null;
    if (fault === 'DEFINITE') throw new TransportError('DEFINITE','FAKE_DEFINITE_FAILURE');
    if (fault === 'UNKNOWN_BEFORE') throw new TransportError('UNKNOWN','FAKE_TIMEOUT');
    const known = this.receipts.get(message.message_id);
    if (known) return clone(known);
    const receipt: EmailReceipt = { provider_id:`fake-mail-${this.messages.length + 1}`, sent_at_utc:this.clock.now(), simulated:true };
    this.messages.push(clone(message)); this.receipts.set(message.message_id,receipt);
    if (fault === 'UNKNOWN_AFTER') throw new TransportError('UNKNOWN','FAKE_TIMEOUT_AFTER_WRITE');
    return clone(receipt);
  }
  reconcile(messageId: string): EmailReceipt | null { this.trace.push({action:'reconcile',id:messageId}); return clone(this.receipts.get(messageId) ?? null); }
}

export class FakeCalendarTransport implements CalendarTransport {
  readonly kind = 'FAKE';
  readonly events = new Map<string, CalendarReceipt>();
  readonly trace: { action: string; event_id: string; attendee_emails?: string[]; audit_id?:string }[] = [];
  nextFault: FakeFault | null = null;
  conferencePending = false;
  hasConflictOverride = false;
  reset():void {this.events.clear();this.trace.length=0;this.nextFault=null;this.conferencePending=false;this.hasConflictOverride=false;}
  failNext(fault: FakeFault): void { this.nextFault = fault; }
  ready(eventId: string): void { const event = this.events.get(eventId); if (event) { event.conference_status = 'READY'; event.meet_url = `https://meet.example.com/${eventId}`; } }
  seed(request: CalendarRequest, attendees: CalendarAttendee[] = []): void { this.events.set(request.event_id,{event_id:request.event_id,conference_status:'READY',meet_url:`https://meet.example.com/${request.event_id}`,attendee_emails:attendees.map(a=>a.email),cancelled:false,simulated:true,start_at_utc:request.start_at_utc,end_at_utc:request.end_at_utc}); }
  private faultBefore(): FakeFault | null { const fault = this.nextFault; this.nextFault = null; if(fault==='DEFINITE')throw new TransportError('DEFINITE','FAKE_CALENDAR_FAILURE'); if(fault==='UNKNOWN_BEFORE')throw new TransportError('UNKNOWN','FAKE_CALENDAR_TIMEOUT'); return fault; }
  reserve(request: CalendarRequest): CalendarReceipt {
    this.trace.push({action:'reserve',event_id:request.event_id});
    const fault = this.faultBefore();
    const known = this.events.get(request.event_id);
    if (known) return clone(known);
    const result: CalendarReceipt = {event_id:request.event_id,conference_status:this.conferencePending?'PENDING':'READY',meet_url:this.conferencePending?null:`https://meet.example.com/${request.event_id}`,attendee_emails:[],cancelled:false,simulated:true,start_at_utc:request.start_at_utc,end_at_utc:request.end_at_utc};
    this.events.set(request.event_id,result);
    if (fault === 'UNKNOWN_AFTER') throw new TransportError('UNKNOWN','FAKE_CALENDAR_TIMEOUT_AFTER_WRITE');
    return clone(result);
  }
  get(eventId: string): CalendarReceipt | null { this.trace.push({action:'get',event_id:eventId}); return clone(this.events.get(eventId) ?? null); }
  invite(eventId: string, attendees: CalendarAttendee[]): CalendarReceipt {
    this.trace.push({action:'invite',event_id:eventId,attendee_emails:attendees.map(a=>a.email)});
    const fault=this.faultBefore(), event=this.events.get(eventId);
    if(!event || event.conference_status!=='READY' || !event.meet_url) throw new PulseError('CONFERENCE_NOT_READY');
    event.attendee_emails=attendees.map(a=>a.email);
    if(fault==='UNKNOWN_AFTER')throw new TransportError('UNKNOWN','FAKE_INVITE_TIMEOUT_AFTER_WRITE');
    return clone(event);
  }
  removeAttendee(eventId: string,email: string,authorization?:CalendarPrivacyAuthorization): CalendarReceipt {this.trace.push({action:'remove',event_id:eventId,attendee_emails:[email],...(authorization?{audit_id:authorization.audit_id}:{})});const fault=this.faultBefore(),event=this.events.get(eventId);if(!event)throw new PulseError('EVENT_NOT_FOUND');event.attendee_emails=event.attendee_emails.filter(e=>e.toLowerCase()!==email.toLowerCase());if(fault==='UNKNOWN_AFTER')throw new TransportError('UNKNOWN','FAKE_WITHDRAWAL_TIMEOUT_AFTER_WRITE');return clone(event);}
  cancel(eventId: string,authorization?:CalendarPrivacyAuthorization): CalendarReceipt {this.trace.push({action:'cancel',event_id:eventId,...(authorization?{audit_id:authorization.audit_id}:{})});const fault=this.faultBefore(),event=this.events.get(eventId);if(!event)throw new PulseError('EVENT_NOT_FOUND');event.cancelled=true;if(fault==='UNKNOWN_AFTER')throw new TransportError('UNKNOWN','FAKE_CANCEL_TIMEOUT_AFTER_WRITE');return clone(event);}
  hasConflict(start: string,end: string,exceptEventId=''): boolean { return this.hasConflictOverride || [...this.events.values()].some(event=>!event.cancelled && event.event_id!==exceptEventId && Date.parse(event.start_at_utc??'')<Date.parse(end) && Date.parse(event.end_at_utc??'')>Date.parse(start)); }
}
