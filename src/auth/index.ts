import type { AuthProvider, Clock, Repository } from '../shared/contracts';
import { type Principal, type VerifiedSession, type Row, type PulseConfig, PulseError, str, num, iso, plusDays, bool } from '../shared/types';
export interface SecurityOps { id(): string; digest(value: string): string; }
export interface DemoLogin { account_id: string; company_id: string | null; username: string; company_login_alias: string | null; demo_password: string; account_role: string; }
export interface HttpClient { post(url: string, body: Record<string, unknown>): Record<string, unknown>; }
function activePrincipal(repo: Repository, accountId: string): Principal {
  const db = repo.read();
  const account = db.Accounts.find(row => str(row, 'account_id') === accountId);
  if (!account || str(account, 'status') !== 'ACTIVE') throw new PulseError('UNAUTHENTICATED');
  const founderId = str(account, 'founder_id') || null;
  const founder = founderId ? db.Founders.find(row => str(row, 'founder_id') === founderId) : null;
  const company = founder ? db.Companies.find(row => str(row, 'company_id') === str(founder, 'company_id')) : null;
  if (founderId && (!founder || !company || str(founder, 'status') !== 'ACTIVE' || str(company, 'status') !== 'ACTIVE')) throw new PulseError('UNAUTHENTICATED');
  if (!founderId && str(account, 'role') !== 'ADMIN') throw new PulseError('UNAUTHENTICATED');
  return { account_id: accountId, founder_id: founderId, company_id: founder ? str(founder, 'company_id') : null, role: str(account, 'role') === 'ADMIN' ? 'ADMIN' : 'FOUNDER' };
}
abstract class SessionAuth implements AuthProvider {
  constructor(protected repo: Repository, protected clock: Clock, protected security: SecurityOps) {}
  protected identifier(value: string): string { return value.trim().toLowerCase(); }
  protected throttle(identifier: string): void {
    const now = iso(this.clock.now()); const hash = this.security.digest(this.identifier(identifier));
    const attempts = this.repo.read().AuthAttempts.filter(row => row.purpose !== 'RESET' && row.success === false && iso(str(row, 'at_utc')) > now - 15 * 60000);
    if (attempts.filter(row => str(row, 'identifier_digest') === hash).length >= 5 || attempts.length >= 100) throw new PulseError('THROTTLED');
  }
  protected attempt(identifier: string, success: boolean): void { this.repo.transaction(db => { db.AuthAttempts.push({ attempt_id: this.security.id(), purpose:'LOGIN', identifier_digest: this.security.digest(this.identifier(identifier)), success, at_utc: this.clock.now() }); }); }
  protected resetThrottle(identifier: string): void {
    const now=iso(this.clock.now()),hash=this.security.digest(this.identifier(identifier));
    this.repo.transaction(db=>{const recent=db.AuthAttempts.filter(row=>row.purpose==='RESET'&&iso(str(row,'at_utc'))>now-3600000);if(recent.filter(row=>row.identifier_digest===hash).length>=3||recent.length>=50)throw new PulseError('THROTTLED');db.AuthAttempts.push({attempt_id:this.security.id(),purpose:'RESET',identifier_digest:hash,success:true,at_utc:this.clock.now()});});
  }
  protected issue(credential: string, accountId: string, providerExpiry = plusDays(this.clock.now(), 1 / 24)): VerifiedSession {
    const principal = activePrincipal(this.repo, accountId); const now = this.clock.now();
    const expiry = new Date(Math.min(iso(providerExpiry), iso(now) + 3600000)).toISOString().replace('.000Z', 'Z');
    this.repo.transaction(db => { db.AuthSessions.push({ session_ref: this.security.digest(credential), account_id: accountId, issued_at_utc: now, last_active_at_utc: now, expires_at_utc: expiry, revoked_at_utc: null }); });
    return { credential, principal, expires_at_utc: expiry };
  }
  protected session(credential: string): Row {
    if (!credential || credential.length > 8192) throw new PulseError('UNAUTHENTICATED');
    const session = this.repo.read().AuthSessions.find(row => str(row, 'session_ref') === this.security.digest(credential));
    const now = iso(this.clock.now());
    if (!session || session.revoked_at_utc || iso(str(session, 'expires_at_utc')) <= now || iso(str(session, 'last_active_at_utc')) + 30 * 60000 <= now) throw new PulseError('UNAUTHENTICATED');
    return session;
  }
  protected touch(credential: string): void { this.repo.transaction(db => { const row = db.AuthSessions.find(v => str(v, 'session_ref') === this.security.digest(credential)); if (row && !row.revoked_at_utc) row.last_active_at_utc = this.clock.now(); }); }
  signOut(credential: string): void { this.repo.transaction(db => { const session = db.AuthSessions.find(row => str(row, 'session_ref') === this.security.digest(credential)); if (session) session.revoked_at_utc = this.clock.now(); }); }
  abstract signIn(identifier: string, password: string): VerifiedSession;
  abstract verify(credential: string): Principal;
  abstract startPasswordReset(identifier: string): void;
}
export class DemoAuthProvider extends SessionAuth {
  constructor(repo: Repository, clock: Clock, security: SecurityOps, private logins: DemoLogin[], config: PulseConfig) { super(repo, clock, security); if (config.environment !== 'DEMO') throw new PulseError('DEMO_AUTH_FORBIDDEN'); }
  signIn(identifier: string, password: string): VerifiedSession {
    this.throttle(identifier);
    const normalized = this.identifier(identifier);
    const login = this.logins.find(row => row.username.toLowerCase() === normalized || !!row.company_login_alias && row.company_login_alias.toLowerCase() === normalized);
    if (!login || login.demo_password !== password) { this.attempt(identifier, false); throw new PulseError('INVALID_CREDENTIALS'); }
    const account = this.repo.read().Accounts.find(row => str(row, 'username_normalized') === login.username.toLowerCase());
    try {
      if (!account) throw new PulseError('INVALID_CREDENTIALS');
      const result = this.issue(`demo-session:${this.security.id()}:${this.security.id()}`, str(account, 'account_id'));
      this.attempt(identifier, true); return result;
    } catch { this.attempt(identifier, false); throw new PulseError('INVALID_CREDENTIALS'); }
  }
  verify(credential: string): Principal { const session = this.session(credential); const principal = activePrincipal(this.repo, str(session, 'account_id')); this.touch(credential); return principal; }
  startPasswordReset(identifier: string): void {
    this.resetThrottle(identifier);
    this.repo.transaction(db => { db.ActivityLog.push({ event_id: this.security.id(), actor: 'PUBLIC', action: 'DEMO_RESET_REQUEST', at_utc: this.clock.now(), reason_code: 'SIMULATED_NO_MESSAGE', identifier_digest: this.security.digest(this.identifier(identifier)) }); });
  }
}
export class ManagedAuthProvider extends SessionAuth {
  constructor(repo: Repository, clock: Clock, security: SecurityOps, private http: HttpClient, private config: PulseConfig) {
    super(repo, clock, security);
    if (config.environment === 'DEMO' || !config.gates_approved || config.auth_backend !== 'FIREBASE' || !config.auth_api_key) throw new PulseError('AUTH_NOT_CONFIGURED');
  }
  private call(action: string, body: Record<string, unknown>): Record<string, unknown> {
    return this.http.post(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(this.config.auth_api_key)}`, body);
  }
  signIn(identifier: string, password: string): VerifiedSession {
    this.throttle(identifier); const normalized = this.identifier(identifier); const db = this.repo.read();
    const account = db.Accounts.find(row => str(row, 'username_normalized') === normalized || str(row, 'company_alias').toLowerCase() === normalized && !!normalized);
    try {
      if (!account || bool(account, 'is_synthetic')) throw new PulseError('INVALID_CREDENTIALS');
      const founder = db.Founders.find(row => str(row, 'founder_id') === str(account, 'founder_id'));
      const email = founder ? str(founder, 'email') : str(account, 'contact_email');
      activePrincipal(this.repo, str(account, 'account_id'));
      if (!email) throw new PulseError('INVALID_CREDENTIALS');
      const result = this.call('signInWithPassword', { email, password, returnSecureToken: true });
      if (typeof result.idToken !== 'string' || result.localId !== account.provider_subject_id) throw new PulseError('INVALID_CREDENTIALS');
      // A provider may return the same token for two logins in one second. Bind it
      // to a fresh application nonce so logging in never reactivates a revoked bearer.
      const credential=JSON.stringify({session_nonce:this.security.id(),provider_token:result.idToken});
      const session = this.issue(credential, str(account, 'account_id'), plusDays(this.clock.now(), Number(result.expiresIn || 3600) / 86400));
      this.attempt(identifier, true); return session;
    } catch { this.attempt(identifier, false); throw new PulseError('INVALID_CREDENTIALS'); }
  }
  verify(credential: string): Principal {
    const session = this.session(credential); const principal = activePrincipal(this.repo, str(session, 'account_id'));
    const account = this.repo.read().Accounts.find(row => str(row, 'account_id') === principal.account_id)!;
    let bearer:{session_nonce:string;provider_token:string};
    try{bearer=JSON.parse(credential);if(!bearer||typeof bearer.session_nonce!=='string'||!bearer.session_nonce||typeof bearer.provider_token!=='string'||!bearer.provider_token||Object.keys(bearer).some(key=>!['session_nonce','provider_token'].includes(key)))throw new Error();}catch{throw new PulseError('UNAUTHENTICATED');}
    let result: Record<string, unknown>;
    try { result = this.call('lookup', { idToken: bearer.provider_token }); } catch { throw new PulseError('UNAUTHENTICATED'); }
    const user = Array.isArray(result.users) ? result.users[0] as Record<string, unknown> | undefined : undefined;
    if (!user || user.localId !== account.provider_subject_id || user.disabled === true || Number(user.validSince || 0) * 1000 > iso(str(session, 'issued_at_utc')) || Number(user.passwordUpdatedAt || 0) > iso(str(session, 'issued_at_utc'))) {
      this.signOut(credential); throw new PulseError('UNAUTHENTICATED');
    }
    this.touch(credential); return principal;
  }
  startPasswordReset(identifier: string): void {
    this.resetThrottle(identifier); const normalized = this.identifier(identifier); const db = this.repo.read();
    const account = db.Accounts.find(row => str(row, 'username_normalized') === normalized || str(row, 'company_alias').toLowerCase() === normalized && !!normalized);
    if (!account || str(account, 'status') !== 'ACTIVE' || bool(account, 'is_synthetic')) return;
    const founder = db.Founders.find(row => str(row, 'founder_id') === str(account, 'founder_id'));
    const email = founder ? str(founder, 'email') : str(account, 'contact_email');
    if (email) { try { this.call('sendOobCode', { requestType: 'PASSWORD_RESET', email }); } catch { /* Generic response prevents account discovery. */ } }
  }
}
