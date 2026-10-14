import fs from 'node:fs';
import { emptyDatabase, TABLES, type Database, type Row } from '../src/shared/types';
import { validateDatabase } from '../src/adapters/memory';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: npx tsx scripts/prepare-import.ts approved-data.json validated-import.json');
const source=JSON.parse(fs.readFileSync(input,'utf8')) as Partial<Database>;
const db=emptyDatabase();
const allowed=['Companies','Founders','Topics','PulseEntries','ConsentLog','Accounts','Settings'] as const;
for(const [table,rows] of Object.entries(source)){
  if(!allowed.includes(table as typeof allowed[number])||!Array.isArray(rows))throw new Error('Unexpected import table');
  for(const row of rows as Row[]){if(row.is_synthetic!==false)throw new Error('Every approved operational record must explicitly be nonsynthetic');if(Object.keys(row).some(key=>/password|secret|token|monthly.*review|private.*review/i.test(key)))throw new Error('Credential or private review fields are forbidden');if(Object.values(row).some(value=>typeof value==='string'&&(/^demo:/.test(value)||/@(?:[^@]+\.)?example\.(?:com|net|org)$/i.test(value))))throw new Error('Synthetic identity cannot be imported');}
  db[table as keyof Database]=rows as Row[];
}
validateDatabase(db);
fs.writeFileSync(output,JSON.stringify(Object.fromEntries(allowed.map(table=>[table,db[table]])),null,2));
process.stdout.write('Validated nonsynthetic operational import. No Google write or account provisioning performed.\n');
