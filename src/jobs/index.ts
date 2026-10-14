import type { CalendarTransport, Clock, EmailTransport, Repository } from '../shared/contracts';
import { readConfig } from '../shared/config';
import { matchingWeekKey } from '../shared/time';
import { bool, clone, emptyDatabase, iso, list, num, plusDays, PulseError, str, TransportError, type CalendarAttendee, type CalendarReceipt, type CalendarRequest, type Database, type EmailMessage, type EmailReceipt, type Opportunity, type PulseConfig, type Row } from '../shared/types';
import { buildSnapshot, canBookConfirmedInterest, computeOpportunities, founderIsActive, latestConsent, selectCohort, evaluateGroup, storyEligible } from '../domain/index';
import { renderEmail } from '../email/index';

const ACTIVE = new Set(['SCHEDULING','BOOKING_PENDING','BOOKING_RETRYABLE','BOOKING_UNKNOWN','NEEDS_TECH_REVIEW','CONFIRMED']);
const MAIL_ACTIVE = new Set(['READY','DRAFT','RETRYABLE']);
const HOUR=3600000;
export const stableHash = (value:string):string => {let h=2166136261;for(let i=0;i<value.length;i++)h=Math.imul(h^value.charCodeAt(i),16777619);return(h>>>0).toString(16).padStart(8,'0');};
const id=(prefix:string,key:string) => `${prefix}-${stableHash(key)}`;
const nowIso=(time:number)=>new Date(time).toISOString().replace('.000Z','Z');
const plusHours=(now:string,hours:number)=>nowIso(iso(now)+hours*HOUR);
const errorCode=(error:unknown) => error instanceof PulseError || error instanceof TransportError ? error.code : 'UNEXPECTED_PROVIDER_ERROR';
const founder=(db:Database,founderId:string):Row=>db.Founders.find(f=>str(f,'founder_id')===founderId)??{};
const topic=(db:Database,topicId:string):Row=>db.Topics.find(t=>str(t,'topic_id')===topicId)??{};
const membership=(db:Database,groupId:string,founderId:string):Row|undefined=>db.ConversationMembers.find(m=>str(m,'conversation_id')===groupId && str(m,'founder_id')===founderId);
const log=(db:Database,action:string,objectId:string,now:string,reason='')=>db.ActivityLog.push({activity_id:id('activity',`${action}:${objectId}:${now}:${db.ActivityLog.length}`),actor:'SYSTEM',action,object_id:objectId,recorded_at_utc:now,reason_code:reason});
function exception(db:Database,type:string,target:string,now:string):void {if(!db.Exceptions.some(e=>str(e,'type')===type&&str(e,'target_id')===target&&!str(e,'resolved_at_utc')))db.Exceptions.push({exception_id:id('exception',`${type}:${target}`),type,target_id:target,severity:'ERROR',owner:'TECHNICAL_OWNER',created_at_utc:now,resolved_at_utc:null,safe_summary:type});}
function setJobHealth(db:Database,name:string,now:string):void {const key=`last_success_${name}_at_utc`,row=db.Settings.find(s=>str(s,'setting_key')===key);if(row)row.setting_value=now;else db.Settings.push({setting_key:key,setting_value:now});}

export interface OutboxSummary {sent:number;drafted:number;cancelled:number;unknown:number;retryable:number;reconciled:number;paused:boolean;}
export interface BookingResult {status:string;conversation_id:string;event_id?:string;meet_url?:string|null;reason_code?:string;simulated?:boolean;}

/** Translate a local wall-clock date using its own IANA-zone offset (including DST). */
export function localDateToUtc(year:number,month:number,day:number,hour:number,minute:number,timeZone:string):string {
  const wanted=Date.UTC(year,month-1,day,hour,minute);let guess=wanted;
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let n=0;n<4;n++){const parts=formatter.formatToParts(new Date(guess)),part=(name:string)=>Number(parts.find(p=>p.type===name)?.value);const observed=Date.UTC(part('year'),part('month')-1,part('day'),part('hour'),part('minute'),part('second'));const delta=wanted-observed;if(!delta)break;guess+=delta;}
  return nowIso(guess);
}

export function generateSlots(conversationId:string,now:string,config:PulseConfig,synthetic:boolean):Row[] {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:config.matching_timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const p=(name:string)=>Number(parts.find(v=>v.type===name)?.value),localDate=new Date(Date.UTC(p('year'),p('month')-1,p('day'),12));
  const slots:Row[]=[],dates=new Set<string>();
  for(let offset=0;offset<=14 && slots.length<2;offset++){
    const day=new Date(localDate.getTime()+offset*86400000);
    for(const window of config.slot_windows.filter(w=>w.weekday===day.getUTCDay()).sort((a,b)=>a.hour-b.hour||a.minute-b.minute)){
      const start=localDateToUtc(day.getUTCFullYear(),day.getUTCMonth()+1,day.getUTCDate(),window.hour,window.minute,config.matching_timezone),date=start.slice(0,10);
      if(iso(start)-iso(now)<48*HOUR||iso(start)-iso(now)>14*86400000||dates.has(date))continue;
      dates.add(date);slots.push({slot_id:id('slot',`${conversationId}:${start}`),conversation_id:conversationId,option_label:String.fromCharCode(65+slots.length),start_at_utc:start,end_at_utc:plusHours(start,config.meeting_duration_minutes/60),display_timezone:config.matching_timezone,minimum_notice_hours:48,is_synthetic:synthetic,revision:1});break;
    }
  }
  if(slots.length!==2)throw new PulseError('SLOT_WINDOWS_NOT_CONFIGURED');return slots;
}

export class PulseJobs {
  private readonly base:PulseConfig;
  constructor(private repo:Repository,private email:EmailTransport,private calendar:CalendarTransport,private clock:Clock,config:PulseConfig){this.base=clone(config);}
  private config(db=this.repo.read()):PulseConfig {
    const stored=readConfig(db),keys=new Set(db.Settings.map(s=>str(s,'setting_key'))),merged={...this.base};
    for(const key of Object.keys(stored) as (keyof PulseConfig)[])if(keys.has(key)&&!['environment','gates_approved','reconciliation_approved','auth_api_key'].includes(key))(merged as unknown as Record<string,unknown>)[key]=stored[key];
    // The host's immutable environment and approval flags cannot be escalated by editing Settings.
    return readConfig(emptyDatabase(),merged);
  }
  private simulatedAllowed(simulate:boolean):boolean {
    if(!simulate)return false;
    if(this.base.environment!=='DEMO'||(this.email as unknown as {kind?:string}).kind!=='FAKE'||(this.calendar as unknown as {kind?:string}).kind!=='FAKE')throw new PulseError('SIMULATION_REQUIRES_DEMO_FAKES');
    return true;
  }
  private canMutate(config:PulseConfig,simulate:boolean):boolean {return config.outreach_mode!=='PAUSED' && (simulate || (config.outreach_mode==='LIVE'&&config.environment!=='DEMO'));}

  runWeeklyMatching():{run_id:string;week_key:string;queued:number;cards:number;staff_summary_queued:number;already_run:boolean;paused:boolean} {
    const now=this.clock.now();
    return this.repo.transaction(db=>{
      const config=this.config(db),week=matchingWeekKey(now,config.matching_timezone),runId=id('run',week),previous=db.MatchRuns.find(r=>str(r,'run_id')===runId&&str(r,'status')==='COMPLETED');
      if(previous)return {run_id:runId,week_key:week,queued:num(previous,'queued_count'),cards:num(previous,'card_count'),staff_summary_queued:num(previous,'staff_summary_count'),already_run:true,paused:config.outreach_mode==='PAUSED'};
      if(config.outreach_mode==='PAUSED'){const staffSummaryQueued=this.queueStaffSummaries(db,week,now,config);return {run_id:runId,week_key:week,queued:0,cards:0,staff_summary_queued:staffSummaryQueued,already_run:false,paused:true};}
      const generated=buildSnapshot(db,now,config);for(const batch of db.SnapshotBatches)batch.status='SUPERSEDED';db.SnapshotBatches.push(generated.batch);db.SnapshotCells.push(...generated.cells);
      const opportunities=computeOpportunities(db,now,config),founders=[...new Set(opportunities.map(o=>o.founder_id))];let queued=0,cards=0;
      for(const founderId of founders){
        if(this.digestQuarantined(db,founderId))continue;
        const key=`DIGEST:${founderId}:${week}`;
        if(db.WeeklyEmails.some(e=>str(e,'unique_key')===key || (str(e,'founder_id')===founderId&&str(e,'matching_week_key')===week&&str(e,'type')==='DIGEST')))continue;
        const selected=opportunities.filter(o=>o.founder_id===founderId).slice(0,config.max_cards_per_digest),emailId=id('mail',key);
        for(const opportunity of selected){opportunity.status='QUEUED';opportunity.email_id=emailId;db.Opportunities.push(opportunity);db.WeeklyEmailItems.push({email_item_id:id('item',`${emailId}:${opportunity.opportunity_id}`),email_id:emailId,opportunity_id:opportunity.opportunity_id,item_order:cards++,source_entry_versions:opportunity.source_entry_versions,candidate_edges:opportunity.candidate_edges,is_synthetic:opportunity.is_synthetic});}
        const row=this.makeMail(db,founderId,'DIGEST',key,now,config,{item_ids:selected.map(o=>o.opportunity_id),matching_week_key:week});
        this.render(db,row,now,config,selected);db.WeeklyEmails.push(row);queued++;
      }
      const staffSummaryQueued=this.queueStaffSummaries(db,week,now,config);
      db.MatchRuns.push({run_id:runId,matching_week_key:week,clock_at:now,started_at:now,finished_at:now,checkpoint:queued,status:'COMPLETED',queued_count:queued,card_count:cards,staff_summary_count:staffSummaryQueued,revision:1});
      setJobHealth(db,'weekly',now);log(db,'WEEKLY_MATCHING_COMPLETED',runId,now);return {run_id:runId,week_key:week,queued,cards,staff_summary_queued:staffSummaryQueued,already_run:false,paused:false};
    });
  }

  private makeMail(db:Database,founderId:string,type:string,key:string,now:string,config:PulseConfig,extra:Row={}):Row {
    const owner=founder(db,founderId),emailId=id('mail',key),domain=config.live_sender_address.split('@')[1]||'pulse.volta.invalid';
    return {email_id:emailId,unique_key:key,founder_id:founderId,recipient_account_id:str(db.Accounts.find(a=>str(a,'founder_id')===founderId)??{},'account_id'),recipient_email:str(owner,'email'),type,mode:config.outreach_mode,status:config.outreach_mode==='DRAFT_ONLY'?'DRAFT':'READY',message_id:`pulse-${stableHash(key)}@${domain}`,render_revision:0,attempts:0,created_at_utc:now,updated_at_utc:now,provider_id:null,sent_at_utc:null,error_code:null,is_synthetic:bool(owner,'is_synthetic'),...extra};
  }
  private queueTransactional(db:Database,founderId:string,type:string,groupId:string,now:string,config:PulseConfig):void {
    const key=`${type}:${groupId}:${founderId}`;if(db.WeeklyEmails.some(e=>str(e,'unique_key')===key))return;
    const mail=this.makeMail(db,founderId,type,key,now,config,{conversation_id:groupId});this.render(db,mail,now,config);db.WeeklyEmails.push(mail);
  }
  private queueStaffSummaries(db:Database,week:string,now:string,config:PulseConfig):number {
    const accounts=db.Accounts.filter(a=>str(a,'role')==='ADMIN'&&str(a,'status')==='ACTIVE');
    let queued=0;
    if(!accounts.length)exception(db,'STAFF_CONTACT_NOT_CONFIGURED','STAFF',now);
    for(const account of accounts){
      if(!str(account,'contact_email')){exception(db,'STAFF_CONTACT_NOT_CONFIGURED',str(account,'account_id'),now);continue;}
      const key=`STAFF_SUMMARY:${str(account,'account_id')}:${week}`;
      if(db.WeeklyEmails.some(e=>str(e,'unique_key')===key))continue;
      const mail=this.makeMail(db,'','STAFF_SUMMARY',key,now,config,{founder_id:null,recipient_account_id:str(account,'account_id'),recipient_email:str(account,'contact_email'),matching_week_key:week,is_synthetic:bool(account,'is_synthetic')});
      this.render(db,mail,now,config);db.WeeklyEmails.push(mail);queued++;
    }
    return queued;
  }
  private render(db:Database,row:Row,now:string,config:PulseConfig,cards?:Opportunity[]):void {
    if(str(row,'type')==='STAFF_SUMMARY'){
      const account=db.Accounts.find(a=>str(a,'account_id')===str(row,'recipient_account_id'))??{};
      const week=str(row,'matching_week_key'),digests=db.WeeklyEmails.filter(e=>str(e,'type')==='DIGEST'&&str(e,'matching_week_key')===week);
      const rendered=renderEmail('STAFF_SUMMARY',{first_name:str(account,'full_name').split(' ')[0]||'there',summary:`${digests.length} founder digests prepared; ${digests.filter(e=>str(e,'status')==='SENT').length} delivered. ${db.Conversations.filter(g=>str(g,'status')==='CONFIRMED').length} confirmed conversations; ${db.Conversations.filter(g=>str(g,'status')==='COMPLETED').length} completed conversations. ${db.Exceptions.filter(e=>!str(e,'resolved_at_utc')).length} unresolved operational exceptions.`},config.app_url);
      row.subject=rendered.subject;row.html=rendered.html;row.text=rendered.text;row.content_hash=stableHash(JSON.stringify(rendered));row.render_revision=num(row,'render_revision')+1;row.updated_at_utc=now;row.story_id=null;row.story_version=null;return;
    }
    const owner=founder(db,str(row,'founder_id')),group=db.Conversations.find(g=>str(g,'conversation_id')===str(row,'conversation_id'))??{};
    const requestedStory=str(row,'story_id')?db.Stories.find(s=>str(s,'story_id')===str(row,'story_id')):undefined;
    const opportunities=cards??db.Opportunities.filter(o=>list(row,'item_ids').includes(str(o,'opportunity_id'))) as Opportunity[];
    const priorStories=new Set(db.WeeklyEmails.filter(e=>str(e,'founder_id')===str(row,'founder_id')&&str(e,'status')==='SENT'&&iso(now)-iso(str(e,'sent_at_utc'))<30*86400000).map(e=>str(e,'story_id')));
    const story=db.Stories.filter(s=>opportunities.some(o=>o.topic_id===str(s,'topic_id'))&&!priorStories.has(str(s,'story_id'))&&storyEligible(db,s,now,config.environment)).sort((a,b)=>str(b,'approved_at_utc').localeCompare(str(a,'approved_at_utc'))||str(b,'story_id').localeCompare(str(a,'story_id')))[0];
    const data={first_name:str(owner,'full_name').split(' ')[0],email_id:str(row,'email_id'),conversation_id:str(row,'conversation_id'),story_id:str(row,'story_id'),story_text:requestedStory?str(requestedStory,'approved_text'):'',topic_label:str(topic(db,str(group,'topic_id')||str(requestedStory??{},'topic_id')),'topic_label'),cards:opportunities.map(o=>{const source=db.PulseEntries.filter(e=>o.source_entry_ids.includes(str(e,'entry_id'))),companies=(role:string)=>new Set(source.filter(e=>str(e,'entry_type')===role).map(e=>str(db.Founders.find(f=>f.founder_id===e.founder_id)??{},'company_id'))).size,topicRow=topic(db,o.topic_id),synonyms=(Array.isArray(topicRow.synonyms)?topicRow.synonyms.map(String):str(topicRow,'synonyms').split(/[;|]/)).filter(Boolean);return{topic_label:str(topicRow,'topic_label'),participation_role:o.participation_role,opportunity_id:o.opportunity_id,other_founder_count:o.candidate_company_ids.length,working_count:companies('WORKING_THROUGH'),experience_count:companies('LIVED_THROUGH'),subtopics:synonyms.slice(0,3)};}),...(story?{story:{approved_text:str(story,'approved_text'),permitted_for_recipient:true}}:{})};
    const rendered=renderEmail(str(row,'type') as Parameters<typeof renderEmail>[0],data,config.app_url);
    row.subject=rendered.subject;row.html=rendered.html;row.text=rendered.text;row.content_hash=stableHash(JSON.stringify(rendered));row.render_revision=num(row,'render_revision')+1;row.updated_at_utc=now;
    if(str(row,'type')==='STORY_APPROVAL'){
      row.story_id=requestedStory?str(requestedStory,'story_id'):str(row,'story_id');
      row.story_version=requestedStory?num(requestedStory,'version'):num(row,'story_version');
    }else{
      row.story_id=story?str(story,'story_id'):null;row.story_version=story?num(story,'version'):null;
    }
  }

  /** Rebuild against current consents, never add an unreviewed card or candidate edge. */
  private digestQuarantined(db:Database,founderId:string,exceptEmailId=''):boolean {
    return db.WeeklyEmails.some(e=>str(e,'type')==='DIGEST'&&str(e,'founder_id')===founderId&&str(e,'email_id')!==exceptEmailId&&['UNKNOWN','SENDING'].includes(str(e,'status')));
  }
  private eligibleCards(db:Database,row:Row,now:string,config:PulseConfig):Opportunity[] {
    if(this.digestQuarantined(db,str(row,'founder_id'),str(row,'email_id')))return [];
    const clean=clone(db);clean.Opportunities=[];
    const fresh=computeOpportunities(clean,now,config),selected:Opportunity[]=[];
    for(const existing of db.Opportunities.filter(o=>list(row,'item_ids').includes(str(o,'opportunity_id')))){
      const actual=fresh.find(o=>o.founder_id===str(row,'founder_id')&&o.topic_id===str(existing,'topic_id')&&o.participation_role===str(existing,'participation_role'));if(!actual)continue;
      const edges=actual.candidate_edges.filter(edge=>list(existing,'candidate_edges').includes(edge));
      // Pool quorum includes all current companies captured by this card. Role-specific
      // novelty edges may cover only the complementary participants in that same pool.
      const companies=actual.candidate_company_ids.filter(company=>list(existing,'candidate_company_ids').includes(company)).sort();
      if(!edges.length||companies.length<config.min_potential_companies)continue;
      selected.push({...actual,opportunity_id:str(existing,'opportunity_id'),candidate_edges:edges,candidate_company_ids:companies,fingerprint:`${actual.participation_role}|${edges.join('|')}`,email_id:str(row,'email_id'),status:'QUEUED'});
    }return selected.slice(0,config.max_cards_per_digest);
  }
  private transactionMailEligible(db:Database,row:Row,now:string,config:PulseConfig):boolean {
    if(str(row,'type')==='STAFF_SUMMARY'){
      const account=db.Accounts.find(a=>str(a,'account_id')===str(row,'recipient_account_id'));
      return !!account&&str(account,'role')==='ADMIN'&&str(account,'status')==='ACTIVE'&&!!str(account,'contact_email')&&str(account,'contact_email')===str(row,'recipient_email');
    }
    const founderId=str(row,'founder_id'),groupId=str(row,'conversation_id'),group=db.Conversations.find(g=>str(g,'conversation_id')===groupId),member=membership(db,groupId,founderId);
    const type=str(row,'type');
    if(!founderIsActive(db,founderId)||!group||bool(founder(db,founderId),'interaction_opt_out')||member&&(str(member,'status')==='WITHDRAWN'||(type!=='POLL_CLOSED'&&['CANCELLED','RELEASED'].includes(str(member,'status')))))return false;
    if(type==='STORY_APPROVAL'){
      const story=db.Stories.find(s=>str(s,'story_id')===str(row,'story_id'));
      if(!story||bool(story,'review_required')||['PRIVATE','WITHDRAWN','WITHHELD','EXPIRED'].includes(str(story,'status'))||num(story,'version',1)!==num(row,'story_version'))return false;
      if(!list(story,'required_approver_ids').includes(founderId))return false;
      return !db.StoryApprovals.some(a=>str(a,'story_id')===str(story,'story_id')&&str(a,'founder_id')===founderId&&num(a,'approved_version')===num(story,'version')&&str(a,'approved_text')===str(story,'approved_text')&&str(a,'sharing_mode')===str(story,'sharing_mode')&&str(a,'decision')==='APPROVED');
    }
    const response=db.InterestResponses.filter(r=>str(r,'conversation_id')===groupId&&str(r,'founder_id')===founderId).sort((a,b)=>str(b,'responded_at_utc').localeCompare(str(a,'responded_at_utc')))[0];
    if(type==='FEEDBACK')return ['CONFIRMED','COMPLETED'].includes(str(group,'status'))&&member!==undefined&&['CONFIRMED','INVITED','COMPLETED'].includes(str(member,'status'));
    if(type==='POLL_CLOSED')return str(group,'status')==='NO_COMMON_SLOT'&&response!==undefined&&str(response,'response')==='INTERESTED';
    if(!response||!canBookConfirmedInterest(db,response,now,config)||str(group,'status')!=='SCHEDULING'||iso(str(group,'poll_closes_at_utc'))<=iso(now))return false;
    if(type==='REMINDER' && db.Availability.some(a=>str(a,'conversation_id')===groupId&&str(a,'founder_id')===founderId))return false;
    return true;
  }
  private capturedMailEligible(db:Database,captured:Row,message:EmailMessage,now:string,config:PulseConfig):boolean {
    const claim=db.WeeklyEmails.find(e=>str(e,'email_id')===message.intent_id);
    if(!claim||str(claim,'status')!=='SENDING'||num(claim,'attempts')!==num(captured,'attempts')||str(claim,'attempted_at_utc')!==str(captured,'attempted_at_utc')||iso(now)-iso(str(claim,'attempted_at_utc'))>=15*60000)return false;
    const isDigest=str(captured,'type')==='DIGEST',cards=isDigest?this.eligibleCards(db,captured,now,config):[];
    if(isDigest?!cards.length:!this.transactionMailEligible(db,captured,now,config))return false;
    const recipient=str(captured,'type')==='STAFF_SUMMARY'?db.Accounts.find(a=>str(a,'account_id')===str(captured,'recipient_account_id')):founder(db,str(captured,'founder_id'));
    if(!recipient||str(recipient,str(captured,'type')==='STAFF_SUMMARY'?'contact_email':'email')!==message.to)return false;
    if(str(captured,'type')!=='STAFF_SUMMARY'&&str(recipient,'auth_subject_id')!==(message.recipient_subject||''))return false;
    const rendered=clone(captured);this.render(db,rendered,now,config,cards);
    return str(rendered,'html')===message.html&&str(rendered,'text')===message.text&&str(rendered,'subject')===message.subject&&str(rendered,'story_id')===str(captured,'story_id')&&num(rendered,'story_version')===num(captured,'story_version')&&
      (!isDigest||JSON.stringify(cards.map(c=>({id:c.opportunity_id,edges:c.candidate_edges})))===JSON.stringify(db.Opportunities.filter(o=>list(captured,'item_ids').includes(str(o,'opportunity_id'))).map(o=>({id:str(o,'opportunity_id'),edges:list(o,'candidate_edges')}))));
  }

  processOutbox(simulate=false):OutboxSummary {
    const simulated=this.simulatedAllowed(simulate),summary:OutboxSummary={sent:0,drafted:0,cancelled:0,unknown:0,retryable:0,reconciled:0,paused:false},now=this.clock.now();
    // Crash after provider acceptance leaves SENDING. Convert it to uncertainty, never READY.
    this.repo.transaction(db=>{for(const row of db.WeeklyEmails)if(str(row,'status')==='SENDING'&&iso(now)-iso(str(row,'attempted_at_utc'))>=15*60000){row.status='UNKNOWN';row.error_code='STALE_SEND_CLAIM';exception(db,'UNKNOWN_DELIVERY',str(row,'email_id'),now);}});
    for(const unknown of this.repo.read().WeeklyEmails.filter(e=>str(e,'status')==='UNKNOWN').slice(0,10)){
      try {const receipt=this.email.reconcile(str(unknown,'message_id'));if(receipt){this.markSent(str(unknown,'email_id'),receipt);summary.reconciled++;}else summary.unknown++;}
      catch(error){this.repo.transaction(db=>exception(db,errorCode(error),str(unknown,'email_id'),now));summary.unknown++;}
    }
    for(const candidate of this.repo.read().WeeklyEmails.filter(e=>MAIL_ACTIVE.has(str(e,'status'))&&(!str(e,'retry_after_utc')||iso(str(e,'retry_after_utc'))<=iso(now))).slice(0,25)){
      const claim=this.repo.transaction(db=>{
        const config=this.config(db),row=db.WeeklyEmails.find(e=>str(e,'email_id')===str(candidate,'email_id'));
        if(!row||!MAIL_ACTIVE.has(str(row,'status')))return null;
        if(config.outreach_mode==='PAUSED'){summary.paused=true;return null;}
        const cards=str(row,'type')==='DIGEST'?this.eligibleCards(db,row,now,config):[];
        if(str(row,'type')==='DIGEST'?!cards.length:!this.transactionMailEligible(db,row,now,config)){
          row.status='CANCELLED';row.error_code='CURRENT_CONSENT_OR_ELIGIBILITY';for(const o of db.Opportunities.filter(o=>list(row,'item_ids').includes(str(o,'opportunity_id'))))o.status='CANCELLED';summary.cancelled++;return null;
        }
        for(const card of cards){const existing=db.Opportunities.find(o=>str(o,'opportunity_id')===card.opportunity_id);if(existing)Object.assign(existing,card);}
        row.item_ids=cards.length?cards.map(c=>c.opportunity_id):list(row,'item_ids');this.render(db,row,now,config,cards);
        if(!this.canMutate(config,simulated)){row.status='DRAFT';row.mode=config.outreach_mode;summary.drafted++;return null;}
        row.status='SENDING';row.attempts=num(row,'attempts')+1;row.attempted_at_utc=now;row.updated_at_utc=now;log(db,'EMAIL_CLAIMED',str(row,'email_id'),now);
        const subject=str(row,'type')==='STAFF_SUMMARY'?str(db.Accounts.find(a=>str(a,'account_id')===str(row,'recipient_account_id'))??{},'provider_subject_id'):str(founder(db,str(row,'founder_id')),'auth_subject_id');
        return {message:{intent_id:str(row,'email_id'),to:str(row,'recipient_email'),subject:str(row,'subject'),html:str(row,'html'),text:str(row,'text'),message_id:str(row,'message_id'),is_synthetic:bool(row,'is_synthetic'),recipient_subject:subject} as EmailMessage,row:clone(row)};
      });
      if(!claim)continue;
      // Recheck pause and revocation after releasing the claim lock; network never occurs under it.
      const current=this.repo.read(),currentConfig=this.config(current);
      if(!this.canMutate(currentConfig,simulated)||!this.capturedMailEligible(current,claim.row,claim.message,this.clock.now(),currentConfig)){this.repo.transaction(db=>{const row=db.WeeklyEmails.find(e=>str(e,'email_id')===claim.message.intent_id);if(row&&str(row,'status')==='SENDING'&&num(row,'attempts')===num(claim.row,'attempts')&&str(row,'attempted_at_utc')===str(claim.row,'attempted_at_utc')){row.status=currentConfig.outreach_mode==='PAUSED'?'READY':'CANCELLED';row.error_code='PRE_SEND_RECHECK';}else log(db,'SEND_CLAIM_LOST',claim.message.intent_id,this.clock.now());});continue;}
      try {const receipt=this.email.send(claim.message);try{this.markSent(claim.message.intent_id,receipt);summary.sent++;}catch{this.quarantine(claim.message.intent_id,'RECEIPT_PERSIST_FAILED');summary.unknown++;}}
      catch(error){if(error instanceof TransportError&&error.certainty==='DEFINITE'){this.repo.transaction(db=>{const row=db.WeeklyEmails.find(e=>str(e,'email_id')===claim.message.intent_id);if(row){row.status=num(row,'attempts')>=3?'NEEDS_TECH_REVIEW':'RETRYABLE';row.error_code=errorCode(error);row.retry_after_utc=plusHours(now,Math.pow(2,num(row,'attempts')));if(str(row,'status')==='NEEDS_TECH_REVIEW')exception(db,'EMAIL_RETRIES_EXHAUSTED',claim.message.intent_id,now);}});summary.retryable++;}else if(error instanceof PulseError){this.repo.transaction(db=>{const row=db.WeeklyEmails.find(e=>str(e,'email_id')===claim.message.intent_id);if(row){row.status='NEEDS_TECH_REVIEW';row.error_code=error.code;}exception(db,error.code,claim.message.intent_id,now);});}else{this.quarantine(claim.message.intent_id,errorCode(error));summary.unknown++;}}
    }
    this.repo.transaction(db=>setJobHealth(db,'worker',now));return summary;
  }
  private quarantine(emailId:string,code:string):void {try{this.repo.transaction(db=>{const row=db.WeeklyEmails.find(e=>str(e,'email_id')===emailId);if(row){row.status='UNKNOWN';row.error_code=code;}exception(db,'UNKNOWN_DELIVERY',emailId,this.clock.now());});}catch{/* A retained SENDING claim is reconciled by the next worker after 15 minutes. */}}
  private markSent(emailId:string,receipt:EmailReceipt):void {
    this.repo.transaction(db=>{
      const row=db.WeeklyEmails.find(e=>str(e,'email_id')===emailId);if(!row||str(row,'status')==='SENT')return;
      const config=this.config(db);row.status='SENT';row.provider_id=receipt.provider_id;row.sent_at_utc=receipt.sent_at_utc;row.simulated=receipt.simulated;row.error_code=null;row.updated_at_utc=this.clock.now();
      if(str(row,'type')==='DIGEST')for(const o of db.Opportunities.filter(o=>list(row,'item_ids').includes(str(o,'opportunity_id')))){
        o.status='OFFERED';o.sent_at_utc=receipt.sent_at_utc;o.expires_at_utc=plusDays(receipt.sent_at_utc,config.opportunity_response_days);
        if(!db.OutreachHistory.some(h=>str(h,'email_id')===emailId&&str(h,'topic_id')===str(o,'topic_id')))db.OutreachHistory.push({history_id:id('history',`${emailId}:${str(o,'opportunity_id')}`),founder_id:str(o,'founder_id'),topic_id:str(o,'topic_id'),opportunity_id:str(o,'opportunity_id'),participation_role:str(o,'participation_role'),candidate_company_ids:list(o,'candidate_company_ids'),candidate_edges:list(o,'candidate_edges'),fingerprint:str(o,'fingerprint'),sent_at_utc:receipt.sent_at_utc,response:'PENDING',response_deadline_utc:str(o,'expires_at_utc'),cooldown_until_utc:null,email_id:emailId,provider_id:receipt.provider_id,is_synthetic:bool(o,'is_synthetic'),simulated:receipt.simulated});
      }
      for(const e of db.Exceptions.filter(e=>str(e,'target_id')===emailId&&!str(e,'resolved_at_utc')))e.resolved_at_utc=this.clock.now();log(db,'EMAIL_SENT',emailId,this.clock.now(),receipt.simulated?'SIMULATED':'PROVIDER_RECEIPT');
    });
  }

  evaluateInterest(topicId:string):Row|null {
    const now=this.clock.now();
    return this.repo.transaction(db=>{
      const config=this.config(db);if(config.outreach_mode==='PAUSED')return null;
      const selected=selectCohort(db,topicId,now,config);if(selected.length<config.min_confirmed_companies)return null;
      const groupId=id('conversation',`${topicId}:${selected.map(s=>str(s,'response_id')).sort().join('|')}`),existing=db.Conversations.find(g=>str(g,'conversation_id')===groupId);if(existing)return existing;
      const synthetic=selected.some(s=>bool(s,'is_synthetic')),slots=generateSlots(groupId,now,config,synthetic),group:Row={conversation_id:groupId,topic_id:topicId,status:'SCHEDULING',created_at_utc:now,poll_closes_at_utc:plusDays(now,config.poll_window_days),minimum_companies:config.min_confirmed_companies,maximum_participants:config.max_group_participants,meeting_minutes:config.meeting_duration_minutes,calendar_event_id:null,selected_slot_id:null,is_synthetic:synthetic,revision:1};
      db.Conversations.push(group);db.TimeSlots.push(...slots);
      for(const response of selected){const actual=db.InterestResponses.find(r=>str(r,'response_id')===str(response,'response_id'));if(actual)actual.conversation_id=groupId;db.ConversationMembers.push({conversation_id:groupId,founder_id:str(response,'founder_id'),company_id:str(response,'company_id'),participation_role:str(response,'participation_role'),response_id:str(response,'response_id'),status:'RESERVED',booking_state:'RESERVED',selected_at_utc:now,updated_at_utc:now,is_synthetic:bool(response,'is_synthetic'),revision:1});this.queueTransactional(db,str(response,'founder_id'),'SCHEDULING',groupId,now,config);}
      log(db,'COHORT_RESERVED',groupId,now);return group;
    });
  }

  private bookingEvaluation(db:Database,conversationId:string,now:string,config:PulseConfig){
    const group=db.Conversations.find(g=>str(g,'conversation_id')===conversationId),slotId=str(group??{},'selected_slot_id');
    if(!slotId||!str(group??{},'calendar_event_id'))return evaluateGroup(db,conversationId,now,config);
    const pinned=clone(db),copy=pinned.Conversations.find(g=>str(g,'conversation_id')===conversationId)!;
    pinned.TimeSlots=pinned.TimeSlots.filter(s=>str(s,'conversation_id')!==conversationId||str(s,'slot_id')===slotId);
    for(const slot of pinned.TimeSlots.filter(s=>str(s,'slot_id')===slotId))slot.minimum_notice_hours=0;
    // An already-authorized, reserved slot is not a second scheduling poll.
    if(str(copy,'booking_authorized_at_utc')&&iso(str(copy,'booking_authorized_at_utc'))<=iso(str(copy,'poll_closes_at_utc')))copy.poll_closes_at_utc=plusDays(now,1);
    return evaluateGroup(pinned,conversationId,now,config);
  }
  private continuingMembers(db:Database,group:Row,now:string):Row[]{
    const groupId=str(group,'conversation_id'),slotId=str(group,'selected_slot_id');
    const allowed=list(group,'authorized_founder_ids');
    return db.ConversationMembers.filter(member=>str(member,'conversation_id')===groupId&&(!allowed.length||allowed.includes(str(member,'founder_id')))).filter(member=>{
      const founderId=str(member,'founder_id');
      if(['WITHDRAWN','CANCELLED','RELEASED'].includes(str(member,'status'))||!founderIsActive(db,founderId))return false;
      const response=db.InterestResponses.filter(r=>str(r,'conversation_id')===groupId&&str(r,'founder_id')===founderId).slice().reverse().sort((a,b)=>str(b,'responded_at_utc').localeCompare(str(a,'responded_at_utc')))[0];
      if(!response||str(response,'response')!=='INTERESTED')return false;
      // Natural entry/interest expiry stops new use; it does not revoke a specific meeting already authorized.
      if(!db.PulseEntries.some(entry=>str(entry,'founder_id')===founderId&&str(entry,'topic_id')===str(group,'topic_id')&&['ACTIVE','EXPIRED'].includes(str(entry,'status'))&&(()=>{const consent=latestConsent(db,founderId,'ENTRY_USE',str(entry,'entry_id'),now);return !!consent&&str(consent,'action')==='GRANTED'&&str(consent,'permission_value')===str(entry,'visibility');})()))return false;
      const availability=db.Availability.filter(a=>str(a,'conversation_id')===groupId&&str(a,'founder_id')===founderId&&str(a,'slot_id')===slotId).slice().reverse().sort((a,b)=>str(b,'confirmed_at_utc').localeCompare(str(a,'confirmed_at_utc')))[0];
      return !!availability&&bool(availability,'available')&&bool(availability,'booking_consent')&&bool(availability,'identity_disclosure_consent');
    });
  }
  private receiptMatchesSlot(receipt:CalendarReceipt,request:CalendarRequest):boolean {
    return receipt.event_id===request.event_id&&Number.isFinite(iso(receipt.start_at_utc||''))&&Number.isFinite(iso(receipt.end_at_utc||''))&&iso(receipt.start_at_utc!)===iso(request.start_at_utc)&&iso(receipt.end_at_utc!)===iso(request.end_at_utc);
  }
  private cancelBooking(conversationId:string,eventId:string,reason:string):BookingResult {
    this.calendar.cancel(eventId);
    this.repo.transaction(db=>{const group=db.Conversations.find(g=>str(g,'conversation_id')===conversationId)!;group.status='CANCELLED';group.error_code=reason;group.meet_url=null;group.booking_claim_until_utc=null;this.release(db,conversationId,this.clock.now());log(db,'CONVERSATION_CANCELLED',conversationId,this.clock.now(),reason);});
    return {status:'CANCELLED',conversation_id:conversationId,reason_code:reason};
  }
  private confirmBooking(conversationId:string,receipt:CalendarReceipt,attendees:CalendarAttendee[],now:string):boolean {
    return this.repo.transaction(db=>{
      const group=db.Conversations.find(g=>str(g,'conversation_id')===conversationId)!;
      const continuing=this.continuingMembers(db,group,this.clock.now());
      if(attendees.some(a=>!continuing.some(m=>str(m,'founder_id')===a.founder_id))){group.status='BOOKING_UNKNOWN';group.booking_claim_until_utc=null;group.error_code='POST_INVITE_CONSENT_CHANGED';exception(db,'POST_INVITE_CONSENT_CHANGED',conversationId,now);return false;}
      group.status='CONFIRMED';group.meet_url=receipt.meet_url;group.conference_status='READY';group.simulated=receipt.simulated;group.confirmed_at_utc=now;group.booking_claim_until_utc=null;group.invited_founder_ids=attendees.map(a=>a.founder_id);group.revision=num(group,'revision',1)+1;
      for(const attendee of attendees){const member=membership(db,conversationId,attendee.founder_id)!;member.status='CONFIRMED';member.booking_state='INVITED';member.identity_disclosure_consent=true;member.booked_email=attendee.email;member.updated_at_utc=now;}
      for(const member of db.ConversationMembers.filter(m=>str(m,'conversation_id')===conversationId&&!attendees.some(a=>a.founder_id===str(m,'founder_id')))){member.status='RELEASED';member.booking_state='RELEASED';}
      log(db,'CONVERSATION_CONFIRMED',conversationId,now,receipt.simulated?'SIMULATED':'PROVIDER_RECEIPT');return true;
    });
  }

  evaluateBooking(conversationId:string,simulate=false):BookingResult {
    const simulated=this.simulatedAllowed(simulate),now=this.clock.now();
    const prepared=this.repo.transaction(db=>{
      const config=this.config(db),group=db.Conversations.find(g=>str(g,'conversation_id')===conversationId);
      if(!group)throw new PulseError('CONVERSATION_NOT_FOUND');
      if(config.environment==='LIVE'&&(bool(group,'is_synthetic')||bool(group,'simulated')))throw new PulseError('SYNTHETIC_LIVE_EVENT_BLOCKED');
      if(str(group,'status')==='CONFIRMED')return {done:{status:'CONFIRMED',conversation_id:conversationId,event_id:str(group,'calendar_event_id'),meet_url:str(group,'meet_url')||null,simulated:bool(group,'simulated')}};
      if(['CANCELLED','NO_COMMON_SLOT','EXPIRED','COMPLETED'].includes(str(group,'status')))return {done:{status:str(group,'status'),conversation_id:conversationId,reason_code:'TERMINAL_CONVERSATION'}};
      if(config.outreach_mode==='PAUSED')return {done:{status:str(group,'status'),conversation_id:conversationId,reason_code:'GLOBAL_PAUSED'}};
      const result=this.bookingEvaluation(db,conversationId,now,config),priorStatus=str(group,'status'),existingEvent=str(group,'calendar_event_id'),pinnedSlot=db.TimeSlots.find(s=>str(s,'slot_id')===str(group,'selected_slot_id'));
      if(!result.selected_slot&&!existingEvent){if(result.reason_code==='POLL_EXPIRED'){group.status='NO_COMMON_SLOT';this.release(db,conversationId,now);for(const response of result.eligible_members)this.queueTransactional(db,str(response,'founder_id'),'POLL_CLOSED',conversationId,now,config);}return {done:{status:str(group,'status'),conversation_id:conversationId,reason_code:result.reason_code}};}
      if(!result.selected_slot&&!pinnedSlot)return {done:{status:'NEEDS_TECH_REVIEW',conversation_id:conversationId,reason_code:'PINNED_SLOT_MISSING'}};
      if(!this.canMutate(config,simulated))return {done:{status:'DRAFT_BOOKING',conversation_id:conversationId,reason_code:'DRAFT_ONLY'}};
      const slot=result.selected_slot||pinnedSlot!,eventId=existingEvent||`pulse${stableHash(`${conversationId}:${str(slot,'slot_id')}`)}${stableHash(`${str(slot,'slot_id')}:${conversationId}`)}`;
      if(str(group,'booking_claim_until_utc')&&iso(str(group,'booking_claim_until_utc'))>iso(now))return {done:{status:str(group,'status'),conversation_id:conversationId,reason_code:'BOOKING_IN_PROGRESS'}};
      group.status='BOOKING_PENDING';group.calendar_event_id=eventId;group.selected_slot_id=str(slot,'slot_id');group.booking_claim_until_utc=plusHours(now,0.25);group.booking_attempts=num(group,'booking_attempts')+1;group.simulated=simulated;
      if(result.selected_slot&&!str(group,'booking_authorized_at_utc'))group.booking_authorized_at_utc=now;
      const request:CalendarRequest={event_id:eventId,conversation_id:conversationId,topic_label:str(topic(db,str(group,'topic_id')),'topic_label'),start_at_utc:str(slot,'start_at_utc'),end_at_utc:str(slot,'end_at_utc'),conference_request_id:`conference-${stableHash(`${eventId}:${conversationId}`)}`,is_synthetic:bool(group,'is_synthetic')};
      return {request,slotId:str(slot,'slot_id'),priorStatus,reconciliationOnly:!result.selected_slot,memberIds:result.eligible_members.map(m=>str(m,'founder_id'))};
    });
    if(prepared.done)return prepared.done as BookingResult;
    const request=prepared.request!;
    try {
      if(!this.canMutate(this.config(),simulated))return this.clearBookingClaim(conversationId,'BOOKING_PENDING','GLOBAL_PAUSED');
      if(this.calendar.hasConflict(request.start_at_utc,request.end_at_utc,request.event_id))return this.clearBookingClaim(conversationId,'NEEDS_TECH_REVIEW','ORGANIZER_CONFLICT');
      let receipt=this.calendar.get(request.event_id);
      if(!receipt && prepared.priorStatus==='BOOKING_UNKNOWN')return this.clearBookingClaim(conversationId,'BOOKING_UNKNOWN','UNCERTAIN_EVENT_NOT_FOUND');
      const beforeReserve=this.repo.read(),reserveConfig=this.config(beforeReserve),reserveEvaluation=this.bookingEvaluation(beforeReserve,conversationId,this.clock.now(),reserveConfig);
      if(!this.canMutate(reserveConfig,simulated))return this.clearBookingClaim(conversationId,'BOOKING_PENDING','GLOBAL_PAUSED',receipt||undefined);
      if(!receipt){
        if(prepared.reconciliationOnly||!reserveEvaluation.selected_slot||str(reserveEvaluation.selected_slot,'slot_id')!==prepared.slotId)return this.clearBookingClaim(conversationId,'SCHEDULING','QUORUM_RECHECK_FAILED');
        receipt=this.calendar.reserve(request);
      }
      if(receipt.cancelled)return this.clearBookingClaim(conversationId,'CANCELLED','PROVIDER_EVENT_CANCELLED',receipt);
      if(!this.receiptMatchesSlot(receipt,request))return this.clearBookingClaim(conversationId,'NEEDS_TECH_REVIEW','PROVIDER_EVENT_TIME_MISMATCH',receipt);
      if(receipt.attendee_emails.length){
        const existing=this.repo.read(),group=existing.Conversations.find(g=>str(g,'conversation_id')===conversationId)!,valid=this.continuingMembers(existing,group,this.clock.now());
        const attendees=valid.map(m=>({...this.attendee(existing,str(m,'founder_id')),email:str(m,'booked_email')||this.attendee(existing,str(m,'founder_id')).email}));
        if(new Set(valid.map(m=>str(m,'company_id'))).size<reserveConfig.min_confirmed_companies)return this.cancelBooking(conversationId,request.event_id,'WITHDRAWAL_BELOW_QUORUM');
        const emails=new Set(attendees.map(a=>a.email));
        for(const email of receipt.attendee_emails.filter(email=>!emails.has(email)))receipt=this.calendar.removeAttendee(request.event_id,email);
        // Never add a replacement or another identity to a possibly delivered invitation.
        const actual=new Set(receipt.attendee_emails),confirmed=attendees.filter(a=>actual.has(a.email));
        if(new Set(confirmed.map(a=>str(founder(existing,a.founder_id),'company_id'))).size<reserveConfig.min_confirmed_companies)return this.cancelBooking(conversationId,request.event_id,'PROVIDER_ATTENDEES_BELOW_QUORUM');
        if(receipt.conference_status!=='READY'||!receipt.meet_url)return this.clearBookingClaim(conversationId,'BOOKING_UNKNOWN','INVITED_CONFERENCE_NOT_READY',receipt);
        if(!this.confirmBooking(conversationId,receipt,confirmed,this.clock.now())){this.reconcileWithdrawals();return {status:str(this.repo.read().Conversations.find(g=>str(g,'conversation_id')===conversationId)!,'status'),conversation_id:conversationId,reason_code:'POST_INVITE_CONSENT_CHANGED'};}
        return {status:'CONFIRMED',conversation_id:conversationId,event_id:request.event_id,meet_url:receipt.meet_url,simulated:receipt.simulated};
      }
      if(!reserveEvaluation.selected_slot)return this.cancelBooking(conversationId,request.event_id,'QUORUM_RECHECK_FAILED');
      if(receipt.conference_status==='FAILED')return this.clearBookingClaim(conversationId,'NEEDS_TECH_REVIEW','CONFERENCE_FAILED',receipt);
      if(receipt.conference_status!=='READY'||!receipt.meet_url)return this.clearBookingClaim(conversationId,'BOOKING_PENDING','CONFERENCE_PENDING',receipt);
      // Consent is checked again after asynchronous conference creation and before disclosure.
      const current=this.repo.read(),config=this.config(current),evaluation=this.bookingEvaluation(current,conversationId,this.clock.now(),config);
      if(!this.canMutate(config,simulated))return this.clearBookingClaim(conversationId,'BOOKING_PENDING','GLOBAL_PAUSED',receipt);
      const group=current.Conversations.find(g=>str(g,'conversation_id')===conversationId)!;
      if(!evaluation.selected_slot||str(evaluation.selected_slot,'slot_id')!==str(group,'selected_slot_id')){
        return this.cancelBooking(conversationId,request.event_id,'QUORUM_RECHECK_FAILED');
      }
      const attendees=evaluation.eligible_members.map(member=>this.attendee(current,str(member,'founder_id')));
      const expected=attendees.map(a=>a.email).sort(),actual=receipt.attendee_emails.slice().sort();
      this.repo.transaction(db=>{const g=db.Conversations.find(g=>str(g,'conversation_id')===conversationId)!;g.authorized_founder_ids=attendees.map(a=>a.founder_id);g.invitation_authorized_at_utc=this.clock.now();for(const attendee of attendees){const member=membership(db,conversationId,attendee.founder_id)!;member.booked_email=attendee.email;}});
      const final=this.repo.read(),finalConfig=this.config(final),finalEvaluation=this.bookingEvaluation(final,conversationId,this.clock.now(),finalConfig);
      if(!this.canMutate(finalConfig,simulated))return this.clearBookingClaim(conversationId,'BOOKING_PENDING','GLOBAL_PAUSED',receipt);
      if(!finalEvaluation.selected_slot||JSON.stringify(finalEvaluation.eligible_members.map(m=>str(m,'founder_id')).sort())!==JSON.stringify(attendees.map(a=>a.founder_id).sort())||attendees.some(a=>str(founder(final,a.founder_id),'email')!==a.email))return this.cancelBooking(conversationId,request.event_id,'PRE_INVITE_CONSENT_CHANGED');
      if(JSON.stringify(expected)!==JSON.stringify(actual))receipt=this.calendar.invite(request.event_id,attendees);
      if(receipt.cancelled||receipt.conference_status!=='READY'||JSON.stringify(receipt.attendee_emails.slice().sort())!==JSON.stringify(expected))throw new TransportError('UNKNOWN','CALENDAR_INVITATION_RECEIPT_INCOMPLETE');
      if(!this.confirmBooking(conversationId,receipt,attendees,this.clock.now())){this.reconcileWithdrawals();return {status:str(this.repo.read().Conversations.find(g=>str(g,'conversation_id')===conversationId)!,'status'),conversation_id:conversationId,reason_code:'POST_INVITE_CONSENT_CHANGED'};}
      return {status:'CONFIRMED',conversation_id:conversationId,event_id:request.event_id,meet_url:receipt.meet_url,simulated:receipt.simulated};
    }catch(error){const status=error instanceof TransportError&&error.certainty==='DEFINITE'?'BOOKING_RETRYABLE':error instanceof PulseError?'NEEDS_TECH_REVIEW':'BOOKING_UNKNOWN';return this.clearBookingClaim(conversationId,status,errorCode(error));}
  }
  private clearBookingClaim(conversationId:string,status:string,reason:string,receipt?:CalendarReceipt):BookingResult {
    this.repo.transaction(db=>{const group=db.Conversations.find(g=>str(g,'conversation_id')===conversationId)!;group.status=status;group.booking_claim_until_utc=null;group.error_code=reason;if(receipt){group.conference_status=receipt.conference_status;group.meet_url=receipt.meet_url;}if(['BOOKING_UNKNOWN','NEEDS_TECH_REVIEW'].includes(status))exception(db,reason,conversationId,this.clock.now());if(status==='BOOKING_RETRYABLE'){group.retry_after_utc=plusHours(this.clock.now(),Math.pow(2,num(group,'booking_attempts')));if(num(group,'booking_attempts')>=3){group.status='NEEDS_TECH_REVIEW';exception(db,'BOOKING_RETRIES_EXHAUSTED',conversationId,this.clock.now());}}});return {status,conversation_id:conversationId,reason_code:reason};
  }
  private attendee(db:Database,founderId:string):CalendarAttendee {const owner=founder(db,founderId),company=db.Companies.find(c=>str(c,'company_id')===str(owner,'company_id'))??{};return {founder_id:founderId,email:str(owner,'email'),name:str(owner,'full_name'),company_name:str(company,'company_name'),is_synthetic:bool(owner,'is_synthetic'),auth_subject_id:str(owner,'auth_subject_id')};}
  private release(db:Database,groupId:string,now:string):void {for(const member of db.ConversationMembers.filter(m=>str(m,'conversation_id')===groupId)){member.status='RELEASED';member.booking_state='RELEASED';member.updated_at_utc=now;}}

  /** Explicit staff privacy action: no booking, invitations, or additional identities. */
  privacyCancel(conversationId:string,actorAccountId:string,requestId:string):BookingResult {
    const now=this.clock.now();
    const intent=this.repo.transaction(db=>{
      const actor=db.Accounts.find(a=>str(a,'account_id')===actorAccountId);
      if(!actor||str(actor,'role')!=='ADMIN'||str(actor,'status')!=='ACTIVE')throw new PulseError('FORBIDDEN');
      const group=db.Conversations.find(g=>str(g,'conversation_id')===conversationId);
      if(!group)throw new PulseError('CONVERSATION_NOT_FOUND');
      if(this.config(db).environment==='LIVE'&&(bool(group,'is_synthetic')||bool(group,'simulated')||bool(actor,'is_synthetic')||str(actor,'provider_subject_id').startsWith('demo:')))throw new PulseError('SYNTHETIC_LIVE_EVENT_BLOCKED');
      if(str(group,'status')==='CANCELLED')return {done:{status:'CANCELLED',conversation_id:conversationId}};
      if(!['CONFIRMED','BOOKING_PENDING','BOOKING_UNKNOWN','BOOKING_RETRYABLE','NEEDS_TECH_REVIEW'].includes(str(group,'status'))||!str(group,'calendar_event_id'))throw new PulseError('PRIVACY_CANCELLATION_UNAVAILABLE');
      const auditId=id('privacy',`${actorAccountId}:${requestId}:${conversationId}`);
      if(!db.ActivityLog.some(r=>str(r,'activity_id')===auditId))db.ActivityLog.push({activity_id:auditId,actor:actorAccountId,action:'STAFF_PRIVACY_CANCEL_INTENT',object_id:conversationId,request_id:requestId,recorded_at_utc:now,reason_code:'EXPLICIT_STAFF_PRIVACY_ACTION'});
      group.privacy_cancel_audit_id=auditId;group.privacy_cancel_requested_at_utc=now;
      return {eventId:str(group,'calendar_event_id'),authorization:{actor_account_id:actorAccountId,audit_id:auditId}};
    });
    if(intent.done)return intent.done as BookingResult;
    try{
      const current=this.repo.read(),config=this.config(current),actor=current.Accounts.find(a=>str(a,'account_id')===actorAccountId);
      if(!actor||str(actor,'role')!=='ADMIN'||str(actor,'status')!=='ACTIVE'||!current.ActivityLog.some(r=>str(r,'activity_id')===intent.authorization!.audit_id&&str(r,'action')==='STAFF_PRIVACY_CANCEL_INTENT'))throw new PulseError('FORBIDDEN');
      if(config.environment==='DEMO'&&(this.calendar as unknown as {kind?:string}).kind!=='FAKE')throw new PulseError('DEMO_EXTERNAL_TRANSPORT_BLOCKED');
      const receipt=this.calendar.get(intent.eventId!);
      const rechecked=this.repo.read().Accounts.find(a=>str(a,'account_id')===actorAccountId);
      if(!rechecked||str(rechecked,'role')!=='ADMIN'||str(rechecked,'status')!=='ACTIVE')throw new PulseError('FORBIDDEN');
      if(receipt&&!receipt.cancelled){const cancelled=this.calendar.cancel(intent.eventId!,intent.authorization);if(!cancelled.cancelled)throw new TransportError('UNKNOWN','PRIVACY_CANCELLATION_RECEIPT_MISSING');}
      this.repo.transaction(db=>{const group=db.Conversations.find(g=>str(g,'conversation_id')===conversationId)!;group.status='CANCELLED';group.meet_url=null;group.booking_claim_until_utc=null;group.error_code='STAFF_PRIVACY_CANCELLATION';group.privacy_cancelled_at_utc=this.clock.now();this.release(db,conversationId,this.clock.now());for(const e of db.Exceptions.filter(e=>str(e,'target_id')===conversationId&&!str(e,'resolved_at_utc')))e.resolved_at_utc=this.clock.now();log(db,'STAFF_PRIVACY_CANCELLED',conversationId,this.clock.now(),intent.authorization!.audit_id);});
      return {status:'CANCELLED',conversation_id:conversationId,event_id:intent.eventId,reason_code:'STAFF_PRIVACY_CANCELLATION'};
    }catch(error){return this.clearBookingClaim(conversationId,error instanceof TransportError&&error.certainty==='UNKNOWN'?'BOOKING_UNKNOWN':'NEEDS_TECH_REVIEW',errorCode(error));}
  }

  housekeeping():{expired_opportunities:number;expired_entries:number;purged_notes:number;polls_closed:number;reminders:number;feedback_queued:number;pending_bookings:number} {
    const now=this.clock.now();
    const summary=this.repo.transaction(db=>{
      const config=this.config(db),result={expired_opportunities:0,expired_entries:0,purged_notes:0,polls_closed:0,reminders:0,feedback_queued:0,pending_bookings:0};
      for(const history of db.OutreachHistory.filter(h=>str(h,'opportunity_id')&&['PENDING','NO_RESPONSE'].includes(str(h,'response')))){
        const response=db.InterestResponses.filter(r=>str(r,'opportunity_id')===str(history,'opportunity_id')&&str(r,'founder_id')===str(history,'founder_id')).slice().reverse().sort((a,b)=>str(b,'responded_at_utc').localeCompare(str(a,'responded_at_utc')))[0];
        if(!response||!['INTERESTED','NOT_NOW','WITHDRAWN'].includes(str(response,'response')))continue;
        if(str(response,'response')!=='WITHDRAWN'&&str(history,'response_deadline_utc')&&iso(str(response,'responded_at_utc'))>iso(str(history,'response_deadline_utc')))continue;
        history.response=str(response,'response');history.cooldown_until_utc=str(response,'response')==='NOT_NOW'?plusDays(str(response,'responded_at_utc'),config.opportunity_cooldown_days):null;
      }
      for(const entry of db.PulseEntries){if(str(entry,'status')==='ACTIVE'&&iso(str(entry,'expires_at_utc'))<=iso(now)){entry.status='EXPIRED';result.expired_entries++;}if(['EXPIRED','WITHDRAWN'].includes(str(entry,'status'))&&str(entry,'private_context')&&iso(str(entry,'expires_at_utc'))+config.private_note_grace_days*86400000<=iso(now)){entry.private_context='';entry.private_context_purged_at_utc=now;result.purged_notes++;}}
      for(const opportunity of db.Opportunities)if(['OFFERED','SENT','OPEN','QUEUED'].includes(str(opportunity,'status'))&&iso(str(opportunity,'expires_at_utc'))<=iso(now)){
        opportunity.status='EXPIRED';result.expired_opportunities++;
        for(const history of db.OutreachHistory.filter(h=>str(h,'opportunity_id')===str(opportunity,'opportunity_id')&&['PENDING','NO_RESPONSE',''].includes(str(h,'response')))){const deadline=str(history,'response_deadline_utc')||str(opportunity,'expires_at_utc');history.response='NO_RESPONSE';if(!str(history,'cooldown_until_utc'))history.cooldown_until_utc=plusDays(deadline,config.opportunity_cooldown_days);}
      }
      for(const history of db.OutreachHistory)if(['PENDING','NO_RESPONSE',''].includes(str(history,'response'))&&str(history,'response_deadline_utc')&&iso(str(history,'response_deadline_utc'))<=iso(now)){history.response='NO_RESPONSE';if(!str(history,'cooldown_until_utc'))history.cooldown_until_utc=plusDays(str(history,'response_deadline_utc'),config.opportunity_cooldown_days);}
      for(const group of db.Conversations){const groupId=str(group,'conversation_id'),status=str(group,'status');
        if(status==='SCHEDULING'&&iso(str(group,'poll_closes_at_utc'))<=iso(now)){group.status='NO_COMMON_SLOT';this.release(db,groupId,now);result.polls_closed++;if(config.outreach_mode!=='PAUSED')for(const response of db.InterestResponses.filter(r=>str(r,'conversation_id')===groupId&&str(r,'response')==='INTERESTED'))this.queueTransactional(db,str(response,'founder_id'),'POLL_CLOSED',groupId,now,config);}
        else if(status==='SCHEDULING'&&config.outreach_mode!=='PAUSED'&&iso(str(group,'created_at_utc'))+config.poll_reminder_after_hours*HOUR<=iso(now))for(const response of db.InterestResponses.filter(r=>str(r,'conversation_id')===groupId&&canBookConfirmedInterest(db,r,now,config)))if(!db.Availability.some(a=>str(a,'conversation_id')===groupId&&str(a,'founder_id')===str(response,'founder_id'))&&!db.WeeklyEmails.some(e=>str(e,'unique_key')===`REMINDER:${groupId}:${str(response,'founder_id')}`)){this.queueTransactional(db,str(response,'founder_id'),'REMINDER',groupId,now,config);result.reminders++;}
        const slot=db.TimeSlots.find(s=>str(s,'slot_id')===str(group,'selected_slot_id'));
        if(status==='CONFIRMED'&&slot&&iso(str(slot,'end_at_utc'))<=iso(now)){group.status='COMPLETED';group.completed_at_utc=str(slot,'end_at_utc');for(const member of db.ConversationMembers.filter(m=>str(m,'conversation_id')===groupId&&str(m,'status')==='CONFIRMED'))member.status='COMPLETED';}
        if(['CONFIRMED','COMPLETED'].includes(str(group,'status'))&&slot&&iso(str(slot,'end_at_utc'))+config.feedback_delay_hours*HOUR<=iso(now)&&config.outreach_mode!=='PAUSED')for(const member of db.ConversationMembers.filter(m=>str(m,'conversation_id')===groupId&&['CONFIRMED','COMPLETED'].includes(str(m,'status'))))if(!db.WeeklyEmails.some(e=>str(e,'unique_key')===`FEEDBACK:${groupId}:${str(member,'founder_id')}`)){this.queueTransactional(db,str(member,'founder_id'),'FEEDBACK',groupId,now,config);result.feedback_queued++;}
        if(['BOOKING_PENDING','BOOKING_UNKNOWN','BOOKING_RETRYABLE'].includes(status))result.pending_bookings++;
      }
      // Retain minimal consent evidence; purge diagnostic logs, expired request cache and stale auth attempts.
      const cutoff=iso(now)-config.runtime_logging_retention_days*86400000;db.ActivityLog=db.ActivityLog.filter(r=>!str(r,'recorded_at_utc')&&!str(r,'at_utc')||iso(str(r,'recorded_at_utc')||str(r,'at_utc'))>=cutoff);
      db.AuthAttempts=db.AuthAttempts.filter(r=>!str(r,'attempted_at_utc')&&!str(r,'at_utc')||iso(str(r,'attempted_at_utc')||str(r,'at_utc'))>=iso(now)-86400000);
      db.RequestResults=db.RequestResults.filter(r=>str(r,'expires_at_utc')?iso(str(r,'expires_at_utc'))>iso(now):!str(r,'at_utc')||iso(str(r,'at_utc'))>=cutoff);
      setJobHealth(db,'housekeeping',now);return result;
    });
    if(this.config().outreach_mode!=='PAUSED')for(const group of this.repo.read().Conversations.filter(g=>['BOOKING_PENDING','BOOKING_UNKNOWN','BOOKING_RETRYABLE'].includes(str(g,'status'))&&(!str(g,'retry_after_utc')||iso(str(g,'retry_after_utc'))<=iso(now))).slice(0,5))this.evaluateBooking(str(group,'conversation_id'),bool(group,'simulated'));
    this.reconcileWithdrawals();return summary;
  }

  /** Consent loss cancels a future subquorum event; there is no automatic replacement guest. */
  reconcileWithdrawals():void {
    const now=this.clock.now(),initial=this.repo.read(),config=this.config(initial);
    for(const group of initial.Conversations.filter(g=>['CONFIRMED','BOOKING_UNKNOWN'].includes(str(g,'status')))){
      if(config.environment==='LIVE'&&(bool(group,'is_synthetic')||bool(group,'simulated'))){this.repo.transaction(db=>exception(db,'SYNTHETIC_LIVE_EVENT_BLOCKED',str(group,'conversation_id'),now));continue;}
      const groupId=str(group,'conversation_id'),slot=initial.TimeSlots.find(s=>str(s,'slot_id')===str(group,'selected_slot_id'));if(!slot||iso(str(slot,'start_at_utc'))<=iso(now))continue;
      const all=initial.ConversationMembers.filter(m=>str(m,'conversation_id')===groupId&&!['CANCELLED','RELEASED'].includes(str(m,'status'))),valid=this.continuingMembers(initial,group,now),removed=all.filter(m=>!valid.includes(m));if(!removed.length)continue;
      if(config.outreach_mode==='PAUSED'){this.repo.transaction(db=>exception(db,'PAUSED_PRIVACY_CANCELLATION_REQUIRED',groupId,now));continue;}
      if(config.environment==='DEMO'&&(this.calendar as unknown as {kind?:string}).kind!=='FAKE')continue;
      try{
        const existing=this.calendar.get(str(group,'calendar_event_id'));if(!existing)continue;
        if(new Set(valid.map(m=>str(m,'company_id'))).size<config.min_confirmed_companies){this.calendar.cancel(str(group,'calendar_event_id'));this.repo.transaction(db=>{const g=db.Conversations.find(g=>str(g,'conversation_id')===groupId)!;g.status='CANCELLED';g.error_code='WITHDRAWAL_BELOW_QUORUM';this.release(db,groupId,now);log(db,'CONVERSATION_CANCELLED',groupId,now,'WITHDRAWAL_BELOW_QUORUM');});}
        else {for(const member of removed)this.calendar.removeAttendee(str(group,'calendar_event_id'),str(member,'booked_email')||str(founder(initial,str(member,'founder_id')),'email'));this.repo.transaction(db=>{for(const member of removed){const actual=membership(db,groupId,str(member,'founder_id'));if(actual){actual.status='WITHDRAWN';actual.booking_state='WITHDRAWN';actual.updated_at_utc=now;}}});}
      }catch(error){this.repo.transaction(db=>exception(db,errorCode(error),groupId,now));}
    }
  }

  monitor():{environment:string;outreach_mode:string;queue_count:number;unknown_count:number;exception_count:number;upcoming_groups:number;last_success:Record<string,string|null>;stale_jobs:string[];gates:string;staff_summary_gate:string} {
    const db=this.repo.read(),config=this.config(db),now=this.clock.now(),last_success:Record<string,string|null>={},stale_jobs:string[]=[];
    for(const [name,limit] of [['weekly',8*24],['worker',1],['housekeeping',26]] as const){const value=str(db.Settings.find(s=>str(s,'setting_key')===`last_success_${name}_at_utc`)??{},'setting_value');last_success[name]=value||null;if(!value||iso(now)-iso(value)>limit*HOUR)stale_jobs.push(name);}
    this.repo.transaction(state=>{for(const name of stale_jobs)exception(state,'STALE_JOB',name,now);setJobHealth(state,'watchdog',now);});
    return {environment:config.environment,outreach_mode:config.outreach_mode,queue_count:db.WeeklyEmails.filter(e=>MAIL_ACTIVE.has(str(e,'status'))).length,unknown_count:db.WeeklyEmails.filter(e=>str(e,'status')==='UNKNOWN').length,exception_count:db.Exceptions.filter(e=>!str(e,'resolved_at_utc')).length,upcoming_groups:db.Conversations.filter(g=>ACTIVE.has(str(g,'status'))).length,last_success,stale_jobs,gates:config.gates_approved?'APPROVED':'NOT_CONFIGURED',staff_summary_gate:db.Accounts.some(a=>str(a,'role')==='ADMIN'&&str(a,'status')==='ACTIVE'&&!!str(a,'contact_email'))?'CONFIGURED':'NOT_CONFIGURED'};
  }
}
