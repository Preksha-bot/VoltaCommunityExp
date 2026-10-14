import type { Repository } from '../shared/contracts';
import { clone, emptyDatabase, PulseError, TABLES, type Database, type Row, type TableName } from '../shared/types';
import { validateDatabase } from './memory';
import { recordId } from './schema';

export const SHEET_COLUMNS = ['record_id','revision','schema_version','record_json'] as const;
export const SHEET_SCHEMA_VERSION = '1.0';
interface SheetMetadata {sheets?: {properties?: {sheetId?: number;title?: string;gridProperties?: {rowCount?: number;columnCount?: number}}}[];}
interface SheetCell {userEnteredValue: {stringValue?: string;numberValue?: number};}
export interface SheetsApi { Spreadsheets: {
  get(spreadsheetId: string,options?: {fields: string}): SheetMetadata;
  batchUpdate(resource: {requests: unknown[]},spreadsheetId: string): unknown;
  Values: {batchGet(spreadsheetId: string,options:{ranges:string[];valueRenderOption:string}):{valueRanges?:{range?:string;values?:unknown[][]}[]}};
} }
export interface ScriptLock {tryLock(milliseconds:number):boolean; releaseLock():void;}
interface LockServiceApi {getScriptLock():ScriptLock;}
const GAS = <T>(name:string):T => {const value=(globalThis as unknown as Record<string,unknown>)[name];if(!value)throw new PulseError(`${name.toUpperCase()}_NOT_CONFIGURED`);return value as T;};
function encodeRows(table:TableName,rows:Row[]): {values:SheetCell[]}[] {
  return [{values:SHEET_COLUMNS.map(value=>({userEnteredValue:{stringValue:value}}))},...rows.map(row=>({values:[
    {userEnteredValue:{stringValue:recordId(table,row)}},
    {userEnteredValue:{numberValue:typeof row.revision==='number'?row.revision:1}},
    {userEnteredValue:{stringValue:SHEET_SCHEMA_VERSION}},
    {userEnteredValue:{stringValue:JSON.stringify(row)}}
  ]}))];
}

/** One restricted tab per domain table; typed JSON cells preserve arrays and UTC strings.
 * Every cell uses stringValue/numberValue, so untrusted notes cannot become formulas.
 * Related mutations are one atomic Advanced Sheets batchUpdate, never separate cell writes.
 */
export class SheetsRepository implements Repository {
  constructor(private spreadsheetId:string,private api?:SheetsApi,private lock?:ScriptLock) {if(!spreadsheetId)throw new PulseError('SHEET_NOT_CONFIGURED');}
  private gateway():SheetsApi{return this.api??GAS<SheetsApi>('Sheets');}
  private metadata():Map<string,{id:number;rows:number}> {
    const result=new Map<string,{id:number;rows:number}>();
    for(const sheet of this.gateway().Spreadsheets.get(this.spreadsheetId,{fields:'sheets.properties'}).sheets??[]){const p=sheet.properties;if(p?.title && p.sheetId!==undefined)result.set(p.title,{id:p.sheetId,rows:p.gridProperties?.rowCount??1000});}
    return result;
  }
  /** Explicit owner-run migration; idempotent and never invoked by an unauthenticated request. */
  ensureSchema(): void {
    const lock=this.lock??GAS<LockServiceApi>('LockService').getScriptLock();if(!lock.tryLock(5000))throw new PulseError('REPOSITORY_BUSY');
    try {
      const metadata=this.metadata(),requests:unknown[]=[];
      let nextId=Math.max(-1,...[...metadata.values()].map(p=>p.id))+1;
      for(const table of TABLES)if(!metadata.has(table)){
        const sheetId=nextId++;requests.push({addSheet:{properties:{sheetId,title:table,gridProperties:{rowCount:1000,columnCount:SHEET_COLUMNS.length}}}});
        requests.push({updateCells:{start:{sheetId,rowIndex:0,columnIndex:0},rows:encodeRows(table,[]),fields:'userEnteredValue'}});
      }
      if(requests.length)this.gateway().Spreadsheets.batchUpdate({requests},this.spreadsheetId);
    }finally{lock.releaseLock();}
  }
  read():Database {
    const metadata=this.metadata(),present=TABLES.filter(table=>metadata.has(table)),db=emptyDatabase();if(!present.length)return db;
    const ranges=this.gateway().Spreadsheets.Values.batchGet(this.spreadsheetId,{ranges:present.map(table=>`'${table}'!A:D`),valueRenderOption:'UNFORMATTED_VALUE'}).valueRanges??[];
    if(ranges.length!==present.length)throw new PulseError('SHEET_READ_INCOMPLETE');
    ranges.forEach((range,index)=>{
      const table=present[index],values=range.values??[];
      if(values.length && JSON.stringify(values[0])!==JSON.stringify(SHEET_COLUMNS))throw new PulseError('SHEET_SCHEMA_MISMATCH');
      db[table]=values.slice(1).filter(cells=>cells.some(cell=>cell!=null && cell!=='')).map(cells=>{
        if(cells[2]!==SHEET_SCHEMA_VERSION || typeof cells[3]!=='string')throw new PulseError('SHEET_SCHEMA_MISMATCH');
        let row:Row;try{row=JSON.parse(cells[3]) as Row;}catch{throw new PulseError('SHEET_INVALID_JSON');}
        if(!row || Array.isArray(row) || typeof row!=='object' || recordId(table,row)!==cells[0])throw new PulseError('SHEET_INVALID_RECORD');
        if(typeof row.revision==='number' && row.revision!==Number(cells[1]))throw new PulseError('SHEET_REVISION_MISMATCH');
        return row;
      });
    });validateDatabase(db);return db;
  }
  transaction<T>(operation:(db:Database)=>T):T {
    const lock=this.lock??GAS<LockServiceApi>('LockService').getScriptLock();if(!lock.tryLock(5000))throw new PulseError('REPOSITORY_BUSY');
    try {
      const before=this.read(),working=clone(before),result=operation(working);
      if(result && typeof(result as {then?:unknown}).then==='function')throw new PulseError('ASYNC_TRANSACTION_FORBIDDEN');
      validateDatabase(working);const metadata=this.metadata(),requests:unknown[]=[];
      for(const table of TABLES)if(JSON.stringify(before[table])!==JSON.stringify(working[table])){
        const sheet=metadata.get(table);if(!sheet)throw new PulseError('SHEET_SCHEMA_NOT_INSTALLED');
        const rows=encodeRows(table,working[table]);
        if(rows.length>sheet.rows)requests.push({appendDimension:{sheetId:sheet.id,dimension:'ROWS',length:rows.length-sheet.rows}});
        requests.push({updateCells:{range:{sheetId:sheet.id,startRowIndex:0,endRowIndex:Math.max(rows.length,before[table].length+1),startColumnIndex:0,endColumnIndex:SHEET_COLUMNS.length},rows,fields:'userEnteredValue'}});
      }
      if(requests.length)this.gateway().Spreadsheets.batchUpdate({requests},this.spreadsheetId);
      return result===undefined?result:clone(result);
    }finally{lock.releaseLock();}
  }
}
