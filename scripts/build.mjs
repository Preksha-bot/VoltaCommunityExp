import fs from 'node:fs/promises';
import path from 'node:path';
import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
await viteBuild({configFile:false,build:{outDir:'dist/web',emptyOutDir:true,assetsInlineLimit:1000000,cssCodeSplit:false,rollupOptions:{output:{inlineDynamicImports:true}}}});
await fs.mkdir('dist/apps-script',{recursive:true});
const server=await esbuild({entryPoints:['src/server/apps-script.ts'],bundle:true,write:false,platform:'neutral',format:'iife',globalName:'PulseServer',target:'es2019',treeShaking:true});
const functions=['doGet','pulseRpc','runWeeklyMatching_','processOutbox_','housekeeping_','monitor_','installTriggers_','initializeSheet_','importApprovedData_'];
const wrappers=functions.map(name=>`function ${name}() { return PulseServer.${name}.apply(null, arguments); }`).join('\n');
await fs.writeFile('dist/apps-script/Code.gs',server.outputFiles[0].text+'\n'+wrappers+'\n');
let html=await fs.readFile('dist/web/index.html','utf8');
const scriptTag=/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g;
for(const match of [...html.matchAll(scriptTag)]){const js=await fs.readFile(path.join('dist/web',match[1]),'utf8');html=html.replace(match[0],`<script type="module">${js.replace(/<\/script/gi,'<\\/script')}</script>`);}
const cssTag=/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g;
for(const match of [...html.matchAll(cssTag)]){const css=await fs.readFile(path.join('dist/web',match[1]),'utf8');html=html.replace(match[0],`<style>${css}</style>`);}
html=html.replace('</head>','<script>window.__PULSE_INITIAL_ROUTE__ = <?!= initialRoute ?>;</script></head>');
await fs.writeFile('dist/apps-script/Index.html',html);
await fs.writeFile('dist/apps-script/appsscript.json',JSON.stringify({timeZone:'America/Halifax',runtimeVersion:'V8',exceptionLogging:'STACKDRIVER',dependencies:{enabledAdvancedServices:[{userSymbol:'Sheets',version:'v4',serviceId:'sheets'},{userSymbol:'Gmail',version:'v1',serviceId:'gmail'},{userSymbol:'Calendar',version:'v3',serviceId:'calendar'}]},oauthScopes:['https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/script.external_request','https://www.googleapis.com/auth/script.scriptapp']},null,2));
await fs.writeFile('dist/build-manifest.json',JSON.stringify({version:'1.0',built_at:new Date().toISOString(),target:'GATED_GOOGLE_ADAPTERS',demo_credentials_included:false,fixtures_included:false,live_activation:false,public_rpc_functions:['doGet','pulseRpc'],private_job_functions:functions.filter(f=>f.endsWith('_'))},null,2));
process.stdout.write('Built local web assets and gated Apps Script package. No deployment performed.\n');
