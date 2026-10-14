import type { Clock } from './contracts';
export class SystemClock implements Clock { now(): string { return new Date().toISOString().replace('.000Z', 'Z'); } }
export class FixedClock implements Clock { constructor(public value = '2026-10-13T12:00:00Z') {} now(): string { return this.value; } advance(days: number): void { this.value = new Date(Date.parse(this.value) + days * 86400000).toISOString().replace('.000Z', 'Z'); } }
export function matchingWeekKey(now: string, timeZone = 'America/Halifax'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const get = (name: string) => parts.find(p => p.type === name)!.value;
  const date = new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0,10);
}
