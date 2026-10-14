import type { CalendarTransport, Clock, EmailTransport } from '../shared/contracts';
import { SystemClock } from '../shared/time';
import { PulseError, TransportError, type CalendarAttendee, type CalendarPrivacyAuthorization, type CalendarReceipt, type CalendarRequest, type EmailMessage, type EmailReceipt, type PulseConfig } from '../shared/types';
import { assertCalendarSafe, assertEmailSafe, assertGoogleEnabled, assertPrivacyCalendarSafe, assertRecipient } from './guards';

type ConfigSource = PulseConfig | (() => PulseConfig);
const configOf = (source: ConfigSource): PulseConfig => typeof source === 'function' ? source() : source;
interface GoogleMessage { id?: string; internalDate?: string; }
export interface GmailApi { Users: { Messages: {
  send(resource: { raw: string }, userId: string): GoogleMessage;
  list(userId: string, options: {q: string; maxResults: number}): {messages?: GoogleMessage[]};
  get(userId: string, messageId: string, options?: {format: string}): GoogleMessage;
} }; }
interface GoogleEvent {
  id?: string; status?: string; attendees?: {email?: string}[];
  start?: {dateTime?: string}; end?: {dateTime?: string};
  conferenceData?: {createRequest?: {status?: {statusCode?: string}}; entryPoints?: {entryPointType?: string; uri?: string}[]};
  extendedProperties?: {private?: Record<string,string>};
  [key: string]: unknown;
}
export interface CalendarApi { Events: {
  insert(resource: GoogleEvent, calendarId: string, options: {conferenceDataVersion: number; sendUpdates: string}): GoogleEvent;
  get(calendarId: string, eventId: string): GoogleEvent;
  patch(resource: GoogleEvent, calendarId: string, eventId: string, options: {sendUpdates: string; conferenceDataVersion?: number}): GoogleEvent;
  remove(calendarId: string,eventId: string,options: {sendUpdates: string}): void;
  list(calendarId: string,options: {timeMin: string; timeMax: string; singleEvents: boolean; maxResults: number}): {items?: GoogleEvent[]};
} }
const apiGlobal = <T>(name: string): T => {
  const result = (globalThis as unknown as Record<string,unknown>)[name];
  if(!result)throw new PulseError(`${name.toUpperCase()}_NOT_CONFIGURED`);
  return result as T;
};
const errorStatus = (error: unknown) => {
  if(error && typeof error === 'object') { const e=error as {code?: number; status?: number; message?: string}; if(e.code || e.status)return e.code??e.status; if(/(?:not found|404)/i.test(e.message??''))return 404; if(/(?:already exists|409)/i.test(e.message??''))return 409; }
  return null;
};
function providerError(error: unknown, code: string): never {
  if(error instanceof PulseError || error instanceof TransportError)throw error;
  const status=errorStatus(error);
  // Transport timeouts/5xx can occur after a write. Only definitive 4xx is retryable by policy.
  throw new TransportError(status && status>=400 && status<500 && status!==408 ? 'DEFINITE':'UNKNOWN',code);
}

/** Pure UTF-8/Base64 encoder: the deployed Apps Script bundle needs no Buffer or Node runtime. */
export function encodeBase64(value: string, urlSafe = false): string {
  const bytes: number[]=[];
  const encoded=encodeURIComponent(value);
  for(let i=0;i<encoded.length;i++){ if(encoded[i]==='%'){bytes.push(parseInt(encoded.slice(i+1,i+3),16));i+=2;}else bytes.push(encoded.charCodeAt(i)); }
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result='';
  for(let i=0;i<bytes.length;i+=3){const a=bytes[i],b=bytes[i+1],c=bytes[i+2];result+=alphabet[a>>2]+alphabet[((a&3)<<4)|((b??0)>>4)]+(b===undefined?'=':alphabet[((b&15)<<2)|((c??0)>>6)])+(c===undefined?'=':alphabet[c&63]);}
  return urlSafe?result.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''):result;
}
const mimeBody = (value:string) => encodeBase64(value).match(/.{1,76}/g)?.join('\r\n')??'';
export function renderMime(message: EmailMessage, sender: string, sentAt = new Date().toISOString()): string {
  if(/[\r\n]/.test([sender,message.to,message.subject,message.message_id].join('')))throw new PulseError('INVALID_EMAIL_HEADER');
  const marker=message.message_id.replace(/[<>]/g,'');
  if(!/^[a-z0-9._+\-]+@[a-z0-9.\-]+$/i.test(marker))throw new PulseError('INVALID_MESSAGE_ID');
  const boundary=`pulse_${marker.replace(/[^a-z0-9]/gi,'_')}`;
  return [
    `From: Volta Pulse <${sender}>`,`To: ${message.to}`,`Date: ${new Date(sentAt).toUTCString()}`,`Subject: =?UTF-8?B?${encodeBase64(message.subject)}?=`,
    `Message-ID: <${marker}>`,`MIME-Version: 1.0`,`Content-Type: multipart/alternative; boundary="${boundary}"`,'',
    `--${boundary}`,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',mimeBody(message.text),
    `--${boundary}`,'Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',mimeBody(message.html),`--${boundary}--`,''
  ].join('\r\n');
}

export class GmailTransport implements EmailTransport {
  readonly kind='GOOGLE';
  constructor(private config: ConfigSource, private api?: GmailApi,private clock: Clock=new SystemClock()) {}
  send(message: EmailMessage): EmailReceipt {
    const config=configOf(this.config);assertEmailSafe(config,message);
    try { const receipt=(this.api??apiGlobal<GmailApi>('Gmail')).Users.Messages.send({raw:encodeBase64(renderMime(message,config.live_sender_address,this.clock.now()),true)},'me');if(!receipt.id)throw new TransportError('UNKNOWN','GMAIL_RECEIPT_MISSING');return {provider_id:receipt.id,sent_at_utc:this.clock.now(),simulated:false}; }
    catch(error){return providerError(error,'GMAIL_SEND_FAILED');}
  }
  reconcile(messageId: string): EmailReceipt | null {
    const config=configOf(this.config);assertGoogleEnabled(config,false);
    if(!config.reconciliation_approved)throw new PulseError('RECONCILIATION_NOT_APPROVED');
    const marker=messageId.replace(/[<>]/g,'');if(!/^[a-z0-9._+\-]+@[a-z0-9.\-]+$/i.test(marker))throw new PulseError('INVALID_MESSAGE_ID');
    try {const api=this.api??apiGlobal<GmailApi>('Gmail'),matches=api.Users.Messages.list('me',{q:`in:sent rfc822msgid:${marker}`,maxResults:2}).messages??[];
      if(matches.length>1)throw new PulseError('MULTIPLE_DELIVERY_RECEIPTS');if(!matches.length)return null;
      const receipt=api.Users.Messages.get('me',matches[0].id!,{format:'metadata'});
      if(!receipt.id || !receipt.internalDate)throw new PulseError('RECONCILIATION_RECEIPT_INCOMPLETE');
      return {provider_id:receipt.id,sent_at_utc:new Date(Number(receipt.internalDate)).toISOString().replace('.000Z','Z'),simulated:false};
    }catch(error){return providerError(error,'GMAIL_RECONCILIATION_FAILED');}
  }
}

function calendarReceipt(event: GoogleEvent): CalendarReceipt {
  if(!event.id)throw new TransportError('UNKNOWN','CALENDAR_RECEIPT_INCOMPLETE');
  const meet=event.conferenceData?.entryPoints?.find(p=>p.entryPointType==='video')?.uri;
  const status=event.conferenceData?.createRequest?.status?.statusCode;
  return {event_id:event.id??'',conference_status:status==='failure'?'FAILED':meet?'READY':'PENDING',meet_url:meet??null,attendee_emails:(event.attendees??[]).map(a=>a.email??'').filter(Boolean),cancelled:event.status==='cancelled',simulated:false,...(event.start?.dateTime?{start_at_utc:event.start.dateTime}:{}),...(event.end?.dateTime?{end_at_utc:event.end.dateTime}:{})};
}

export class GoogleCalendarTransport implements CalendarTransport {
  readonly kind='GOOGLE';
  constructor(private config: ConfigSource,private api?: CalendarApi) {}
  private gateway(): CalendarApi {return this.api??apiGlobal<CalendarApi>('Calendar');}
  reserve(request: CalendarRequest): CalendarReceipt {
    const config=configOf(this.config);assertCalendarSafe(config,request);
    if(!/^[a-v0-9]{5,1024}$/.test(request.event_id))throw new PulseError('INVALID_GOOGLE_EVENT_ID');
    if(!request.conference_request_id || Date.parse(request.end_at_utc)<=Date.parse(request.start_at_utc))throw new PulseError('INVALID_CALENDAR_REQUEST');
    try {const existing=this.get(request.event_id);if(existing){if(Date.parse(existing.start_at_utc??'')!==Date.parse(request.start_at_utc)||Date.parse(existing.end_at_utc??'')!==Date.parse(request.end_at_utc))throw new PulseError('MANAGED_EVENT_TIME_MISMATCH');return existing;}
      const result=this.gateway().Events.insert({id:request.event_id,summary:`Volta founder conversation: ${request.topic_label}`,description:"A 30-minute conversation with founders who chose to compare notes on this topic.\nNo slides. Bring one question. Share what you experienced, not instructions.\n\nSuggested start: What are you working through, or what did you learn?\n\nYour confirmed group's names and emails are visible in this invitation.\nYou may decline or withdraw. No recording or transcript is created by Pulse.",start:{dateTime:request.start_at_utc},end:{dateTime:request.end_at_utc},attendees:[],conferenceData:{createRequest:{requestId:request.conference_request_id,conferenceSolutionKey:{type:'hangoutsMeet'}}} as GoogleEvent['conferenceData'],extendedProperties:{private:{pulse_conversation_id:request.conversation_id,pulse_managed:'true',pulse_synthetic:String(request.is_synthetic)}}},config.live_calendar_id,{conferenceDataVersion:1,sendUpdates:'none'});
      return calendarReceipt(result);
    }catch(error){if(errorStatus(error)===409){const found=this.get(request.event_id);if(found)return found;}return providerError(error,'CALENDAR_RESERVE_FAILED');}
  }
  get(eventId: string): CalendarReceipt | null {
    const config=configOf(this.config);assertCalendarSafe(config,undefined,[],false,eventId);
    try {const event=this.gateway().Events.get(config.live_calendar_id,eventId);if(event.id!==eventId)throw new TransportError('UNKNOWN','CALENDAR_EVENT_ID_MISMATCH');if(event.extendedProperties?.private?.pulse_managed!=='true')throw new PulseError('UNMANAGED_CALENDAR_EVENT');if(event.extendedProperties?.private?.pulse_synthetic==='true')throw new PulseError('SYNTHETIC_PROVIDER_EVENT_BLOCKED');return calendarReceipt(event);}
    catch(error){if(errorStatus(error)===404)return null;return providerError(error,'CALENDAR_LOOKUP_FAILED');}
  }
  invite(eventId: string,attendees: CalendarAttendee[]): CalendarReceipt {
    const config=configOf(this.config);assertCalendarSafe(config,undefined,attendees,true,eventId);
    const event=this.get(eventId);if(!event || event.cancelled || event.conference_status!=='READY' || !event.meet_url)throw new PulseError('CONFERENCE_NOT_READY');
    try {return calendarReceipt(this.gateway().Events.patch({attendees:attendees.map(a=>({email:a.email,displayName:`${a.name} (${a.company_name})`}))},config.live_calendar_id,eventId,{sendUpdates:'all',conferenceDataVersion:1}));}
    catch(error){return providerError(error,'CALENDAR_INVITE_FAILED');}
  }
  removeAttendee(eventId: string,email: string,authorization?:CalendarPrivacyAuthorization): CalendarReceipt {
    const config=configOf(this.config);assertPrivacyCalendarSafe(config,eventId,authorization);assertRecipient(config,email,false);
    const event=this.get(eventId);if(!event)throw new PulseError('EVENT_NOT_FOUND');
    for(const address of event.attendee_emails)assertRecipient(config,address,false);
    try {return calendarReceipt(this.gateway().Events.patch({attendees:event.attendee_emails.filter(address=>address.toLowerCase()!==email.toLowerCase()).map(address=>({email:address}))},config.live_calendar_id,eventId,{sendUpdates:'all'}));}
    catch(error){return providerError(error,'CALENDAR_WITHDRAWAL_FAILED');}
  }
  cancel(eventId: string,authorization?:CalendarPrivacyAuthorization): CalendarReceipt {
    const config=configOf(this.config);assertPrivacyCalendarSafe(config,eventId,authorization);
    const event=this.get(eventId);if(!event)throw new PulseError('EVENT_NOT_FOUND');if(event.cancelled)return event;
    for(const address of event.attendee_emails)assertRecipient(config,address,false);
    try {this.gateway().Events.remove(config.live_calendar_id,eventId,{sendUpdates:'all'});return {...event,cancelled:true};}
    catch(error){return providerError(error,'CALENDAR_CANCEL_FAILED');}
  }
  hasConflict(start: string,end: string,exceptEventId=''): boolean {
    const config=configOf(this.config);assertCalendarSafe(config,undefined,[],false,exceptEventId);
    try {return (this.gateway().Events.list(config.live_calendar_id,{timeMin:start,timeMax:end,singleEvents:true,maxResults:250}).items??[]).some(event=>event.status!=='cancelled' && event.id!==exceptEventId);}
    catch(error){return providerError(error,'CALENDAR_CONFLICT_CHECK_FAILED');}
  }
}
