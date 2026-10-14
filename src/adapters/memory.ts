import type { Repository } from '../shared/contracts';
import { clone, emptyDatabase, PulseError, TABLES, type Database } from '../shared/types';
import { recordId } from './schema';

/** Copy-on-write transactions make the local demo obey the same rollback boundary as Sheets. */
export class MemoryRepository implements Repository {
  private state: Database;
  private locked = false;
  constructor(seed: Database = emptyDatabase()) { validateDatabase(seed); this.state = clone(seed); }
  read(): Database { return clone(this.state); }
  transaction<T>(operation: (db: Database) => T): T {
    if (this.locked) throw new PulseError('REPOSITORY_BUSY');
    this.locked = true;
    try {
      const working = clone(this.state);
      const result = operation(working);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new PulseError('ASYNC_TRANSACTION_FORBIDDEN');
      validateDatabase(working);
      this.state = working;
      return result === undefined ? result : clone(result);
    } finally { this.locked = false; }
  }
}

/** Runtime tables may be empty, but every account/entry/group reference must resolve. */
export function validateDatabase(db: Database): void {
  const jsonValue=(value:unknown):boolean=>value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||Array.isArray(value)&&value.every(jsonValue)||typeof value==='object'&&value!==null&&!(value instanceof Date)&&Object.values(value).every(jsonValue);
  for (const table of TABLES) {
    if (!Array.isArray(db[table])) throw new PulseError('INVALID_DATABASE');
    const ids=new Set<string>();
    for (const row of db[table]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new PulseError('INVALID_ROW');
      if (!jsonValue(row)) throw new PulseError('NON_JSON_ROW');
      const key=recordId(table,row);if(ids.has(key))throw new PulseError('DUPLICATE_RECORD_ID');ids.add(key);
      if(row.revision!==undefined && (typeof row.revision!=='number'||!Number.isInteger(row.revision)||row.revision<1))throw new PulseError('INVALID_REVISION');
    }
  }
  const unique=(table:keyof Database,fields:string[],filter:(row:Database[keyof Database][number])=>boolean=()=>true)=>{
    const keys=new Set<string>();for(const row of db[table].filter(filter)){if(fields.some(field=>typeof row[field]!=='string'||row[field]===''))continue;const key=JSON.stringify(fields.map(field=>row[field]));if(keys.has(key))throw new PulseError('DUPLICATE_LOGICAL_KEY');keys.add(key);}
  };
  unique('Accounts',['username_normalized']);unique('Accounts',['company_alias']);unique('Accounts',['provider_subject_id']);
  unique('WeeklyEmails',['unique_key']);unique('PulseEntries',['founder_id','topic_id','entry_type'],row=>row.status==='ACTIVE');
  unique('Availability',['conversation_id','founder_id','slot_id']);
  const exists = (table: keyof Database, key: string, value: unknown) => value == null || value === '' || db[table].some(row => row[key] === value);
  for (const row of db.Founders) if (!exists('Companies','company_id',row.company_id)) throw new PulseError('INVALID_COMPANY_REFERENCE');
  for (const row of db.PulseEntries) {
    if (!exists('Founders','founder_id',row.founder_id)) throw new PulseError('INVALID_FOUNDER_REFERENCE');
    if (!exists('Topics','topic_id',row.topic_id)) throw new PulseError('INVALID_TOPIC_REFERENCE');
  }
  for (const table of ['InterestResponses','Availability','ConversationMembers','Feedback'] as const) for (const row of db[table]) {
    if (!exists('Founders','founder_id',row.founder_id)) throw new PulseError('INVALID_FOUNDER_REFERENCE');
    if (!exists('Conversations','conversation_id',row.conversation_id)) throw new PulseError('INVALID_CONVERSATION_REFERENCE');
  }
  for (const row of db.Availability) if (!exists('TimeSlots','slot_id',row.slot_id)) throw new PulseError('INVALID_SLOT_REFERENCE');
  for(const row of db.AuthSessions)if(!exists('Accounts','account_id',row.account_id)||!row.account_id)throw new PulseError('INVALID_ACCOUNT_REFERENCE');
}
