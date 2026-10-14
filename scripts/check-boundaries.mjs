import fs from 'node:fs/promises';
import path from 'node:path';
async function files(directory){const result=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())result.push(...await files(file));else result.push(file);}return result;}
const errors=[];
for(const file of await files('src/ui')){if(!/\.ts$/.test(file))continue;const source=await fs.readFile(file,'utf8');if(/(?:from\s*|import\s*\()["'][^"']*(?:fixtures|auth\/|adapters\/|server\/)/.test(source))errors.push(`${file}: server data imported into browser`);if(/localStorage|sessionStorage|document\.cookie/.test(source))errors.push(`${file}: persistent credential storage`);}
const gas=await fs.readFile('src/server/apps-script.ts','utf8');
for(const match of gas.matchAll(/export function (\w+)\(/g))if(!['doGet','pulseRpc'].includes(match[1])&&!match[1].endsWith('_'))errors.push(`Unsafe Apps Script export: ${match[1]}`);
for(const file of await files('src')){if(!/\.(ts|css)$/.test(file))continue;const source=await fs.readFile(file,'utf8');if(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,}/.test(source))errors.push(`${file}: secret material`);}
if(errors.length){process.stderr.write(errors.join('\n')+'\n');process.exit(1);}process.stdout.write('Browser data, credential storage, Apps Script exports and secret boundaries passed.\n');
