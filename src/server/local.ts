import { createServer, type IncomingMessage } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { loadFixture, demoLogins, FIXTURE_NOW } from '../../fixtures/load';
import { DemoAuthProvider, type DemoLogin } from '../auth';
import { MemoryRepository, FakeEmailTransport, FakeCalendarTransport } from '../adapters';
import { PulseJobs } from '../jobs';
import { PulseService, type RpcRequest } from '../service/pulse';
import { FixedClock } from '../shared/time';
import { readConfig } from '../shared/config';
import { TABLES, clone, str, plusDays } from '../shared/types';
import { seedDemoEmailDrafts } from '../demo/email-drafts';
const clock = new FixedClock(FIXTURE_NOW);
const repo = new MemoryRepository(loadFixture());
const config = readConfig(repo.read());
const security = { id: () => randomUUID(), digest: (value: string) => createHash('sha256').update(value).digest('hex') };
const logins = demoLogins as unknown as DemoLogin[];
const auth = new DemoAuthProvider(repo,clock,security,logins,config);
const email = new FakeEmailTransport(clock);
const calendar = new FakeCalendarTransport();
const jobs = new PulseJobs(repo,email,calendar,clock,config);
const service = new PulseService({repo,auth,jobs,clock,config,security,demoLogins:logins,resetDemo(profile){
  const staff = repo.read().AuthSessions.filter(s=>repo.read().Accounts.some(a=>a.account_id===s.account_id && a.role==='ADMIN') && !s.revoked_at_utc);
  clock.value=FIXTURE_NOW;
  repo.transaction(db=>{const fresh=loadFixture(profile);for(const table of TABLES)db[table]=clone(fresh[table]);db.AuthSessions=staff.map(s=>({...s,issued_at_utc:FIXTURE_NOW,last_active_at_utc:FIXTURE_NOW,expires_at_utc:plusDays(FIXTURE_NOW,1/24)}));});
  email.reset();calendar.reset();
  jobs.runWeeklyMatching();
  seedDemoEmailDrafts(repo, clock.now(), config.app_url);
}});
jobs.runWeeklyMatching();
seedDemoEmailDrafts(repo, clock.now(), config.app_url);
async function body(req:IncomingMessage):Promise<RpcRequest> {
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>65536)throw new Error('REQUEST_TOO_LARGE');chunks.push(Buffer.from(chunk));}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest;
}
const vite=await createViteServer({server:{middlewareMode:true,hmr:{port:5174}},appType:'spa'});
const server=createServer(async(req,res)=>{
  const path=(req.url||'/').split('?')[0];
  if(path==='/api/demo-info'&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(service.demoInfo()));return;}
  if(path==='/api/rpc'){
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method!=='POST'){res.statusCode=405;res.end(JSON.stringify({ok:false,errorCode:'METHOD_NOT_ALLOWED',requestId:randomUUID()}));return;}
    if(req.headers.origin && !['http://127.0.0.1:5173','http://localhost:5173'].includes(req.headers.origin)){res.statusCode=403;res.end(JSON.stringify({ok:false,errorCode:'FORBIDDEN',requestId:randomUUID()}));return;}
    if(!(req.headers['content-type']||'').includes('application/json')){res.statusCode=415;res.end(JSON.stringify({ok:false,errorCode:'VALIDATION_ERROR',requestId:randomUUID()}));return;}
    try{const request=await body(req);res.end(JSON.stringify(service.rpc({...request,payload:request.payload||{}})));}catch{res.statusCode=400;res.end(JSON.stringify({ok:false,errorCode:'VALIDATION_ERROR',requestId:randomUUID()}));}return;
  }
  vite.middlewares(req,res,()=>{res.statusCode=404;res.end('Not found');});
});
server.listen(5173,'127.0.0.1',()=>process.stdout.write('Volta Pulse fictional demo: http://127.0.0.1:5173\n'));
process.on('SIGINT',()=>{void vite.close();server.close(()=>process.exit(0));});
