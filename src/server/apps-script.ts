import { SheetsRepository, GmailTransport, GoogleCalendarTransport } from '../adapters';
import { ManagedAuthProvider } from '../auth';
import { PulseJobs } from '../jobs';
import { PulseService, safeRoute, type RpcRequest } from '../service/pulse';
import { readConfig } from '../shared/config';
import { SystemClock } from '../shared/time';
import { PulseError, emptyDatabase, TABLES, type Row, type TableName, clone, str } from '../shared/types';
function props() { return PropertiesService.getScriptProperties(); }
function configuration() {
  const p=props();const environment=p.getProperty('PULSE_ENVIRONMENT')||'TEST';
  if(environment!=='TEST'&&environment!=='LIVE')throw new PulseError('ENVIRONMENT_NOT_CONFIGURED');
  return readConfig(emptyDatabase(),{environment,outreach_mode:'DRAFT_ONLY',auth_backend:'FIREBASE',auth_api_key:p.getProperty('PULSE_AUTH_API_KEY')||'',app_url:p.getProperty('PULSE_APP_URL')||'',live_sender_address:p.getProperty('PULSE_SENDER_ADDRESS')||'',live_calendar_id:p.getProperty('PULSE_CALENDAR_ID')||'',authenticated_return_url:p.getProperty('PULSE_RETURN_URL')||'',test_recipient_allowlist:(p.getProperty('PULSE_TEST_ALLOWLIST')||'').split('|').filter(Boolean),gates_approved:p.getProperty('PULSE_GATES_APPROVED')==='YES',reconciliation_approved:p.getProperty('PULSE_RECONCILIATION_APPROVED')==='YES',slot_windows:JSON.parse(p.getProperty('PULSE_SLOT_WINDOWS')||'[]')});
}
function repository() { return new SheetsRepository(props().getProperty('PULSE_SHEET_ID')||''); }
function runtime() {
  const repo=repository(),clock=new SystemClock(),config=configuration();
  const current=()=>readConfig(repo.read(),{...config,outreach_mode:(repo.read().Settings.find(r=>r.setting_key==='outreach_mode')?.setting_value as 'DRAFT_ONLY'|'PAUSED'|'LIVE')||'DRAFT_ONLY'});
  const security={id:()=>Utilities.getUuid(),digest:(value:string)=>Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8).map(b=>(b&255).toString(16).padStart(2,'0')).join('')};
  const auth=new ManagedAuthProvider(repo,clock,security,{post(url,payload){const response=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',payload:JSON.stringify(payload),muteHttpExceptions:true});if(response.getResponseCode()!==200)throw new PulseError('AUTH_PROVIDER_FAILED');return JSON.parse(response.getContentText()) as Record<string,unknown>;}},config);
  const jobs=new PulseJobs(repo,new GmailTransport(current,undefined,clock),new GoogleCalendarTransport(current),clock,config);
  const service=new PulseService({repo,auth,jobs,clock,config,security});return{repo,clock,config,jobs,service};
}
export function doGet(e:GoogleAppsScript.Events.DoGet) {
  const route=safeRoute(e?.parameter?.view||'signin',e?.parameter?.id||'');
  const template=HtmlService.createTemplateFromFile('Index');template.initialRoute=JSON.stringify(route);
  return template.evaluate().setTitle('Volta Pulse').addMetaTag('viewport','width=device-width, initial-scale=1');
}
export function pulseRpc(request:RpcRequest) {
  try{return runtime().service.rpc({...request,payload:request.payload||{}});}catch(error){return{ok:false,errorCode:error instanceof PulseError?error.code:'RETRY_LATER',requestId:Utilities.getUuid()};}
}
export function runWeeklyMatching_(){return runtime().jobs.runWeeklyMatching();}
export function processOutbox_(){const r=runtime();r.jobs.processOutbox();r.jobs.housekeeping();}
export function housekeeping_(){return runtime().jobs.housekeeping();}
export function monitor_(){return runtime().jobs.monitor();}
export function installTriggers_(){
  const names=['runWeeklyMatching_','processOutbox_','housekeeping_','monitor_'];
  const existing=ScriptApp.getProjectTriggers();for(const trigger of existing)if(names.includes(trigger.getHandlerFunction()))ScriptApp.deleteTrigger(trigger);
  ScriptApp.newTrigger('runWeeklyMatching_').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).inTimezone('America/Halifax').create();
  ScriptApp.newTrigger('processOutbox_').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('housekeeping_').timeBased().everyDays(1).atHour(7).inTimezone('America/Halifax').create();
  ScriptApp.newTrigger('monitor_').timeBased().everyDays(1).atHour(11).inTimezone('America/Halifax').create();
}
export function initializeSheet_(){
  const repo=repository();repo.ensureSchema();
  repo.transaction(db=>{if(!db.Settings.some(r=>r.setting_key==='outreach_mode'))db.Settings.push({setting_key:'outreach_mode',setting_value:'DRAFT_ONLY'});});
}
/** Owner-only onboarding importer. Existing records cannot be silently overwritten. */
export function importApprovedData_(payload: Record<string, Row[]>) {
  if(!configuration().gates_approved)throw new PulseError('LIVE_GATES_NOT_APPROVED');
  const allowed=['Companies','Founders','Topics','PulseEntries','ConsentLog','Accounts','Settings'];
  const idKeys:Record<string,string>={Companies:'company_id',Founders:'founder_id',Topics:'topic_id',PulseEntries:'entry_id',ConsentLog:'consent_event_id',Accounts:'account_id',Settings:'setting_key'};
  if(!payload||Array.isArray(payload)||Object.keys(payload).some(key=>!allowed.includes(key)))throw new PulseError('VALIDATION_ERROR');
  const repo=repository();repo.ensureSchema();
  return repo.transaction(db=>{
    let added=0;
    for(const [table,rows] of Object.entries(payload)){
      if(!Array.isArray(rows))throw new PulseError('VALIDATION_ERROR');
      for(const row of rows){
        if(!row||row.is_synthetic!==false||Object.keys(row).some(key=>/password|secret|token|monthly.*review|private.*review/i.test(key))||Object.values(row).some(v=>typeof v==='string'&&(/^demo:/.test(v)||/@(?:[^@]+\.)?example\.(?:com|org|net)$/i.test(v))))throw new PulseError('UNSAFE_IMPORT');
        const key=idKeys[table],id=str(row,key);if(!id)throw new PulseError('VALIDATION_ERROR');
        const existing=db[table as TableName].find(r=>r[key]===id);
        if(existing){if(JSON.stringify(existing)!==JSON.stringify(row))throw new PulseError('EXISTING_IMPORT_RECORD_CHANGED');continue;}
        db[table as TableName].push(clone(row));added++;
      }
    }
    db.ActivityLog.push({event_id:Utilities.getUuid(),actor:'DEPLOYMENT_OWNER',action:'APPROVED_OPERATIONAL_IMPORT',at_utc:new Date().toISOString(),record_count:added,reason_code:'OWNER_APPROVED_CREATE_ONLY'});
    return{added};
  });
}
