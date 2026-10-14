import type { Database, VerifiedSession, Principal, EmailMessage, EmailReceipt, CalendarRequest, CalendarReceipt, CalendarAttendee, CalendarPrivacyAuthorization, Row, StoryDraftResult, TopicClassification } from './types';
export interface Clock { now(): string; }
export interface TopicClassifier { classify(originalText: string, topics: Row[]): TopicClassification; }
export interface StoryDrafter { draft(input: { topic_label: string; helped_boolean: boolean; feedback_text: string; sharing_permission: 'anonymous_story' | 'named_story'; permitted_named_companies: string[] }): StoryDraftResult; }
export interface Repository { read(): Database; transaction<T>(operation: (db: Database) => T): T; }
export interface AuthProvider { signIn(identifier: string, password: string): VerifiedSession; verify(credential: string): Principal; signOut(credential: string): void; startPasswordReset(identifier: string): void; }
export interface EmailTransport { send(message: EmailMessage): EmailReceipt; reconcile(messageId: string): EmailReceipt | null; }
export interface CalendarTransport { reserve(request: CalendarRequest): CalendarReceipt; get(eventId: string): CalendarReceipt | null; invite(eventId: string, attendees: CalendarAttendee[]): CalendarReceipt; removeAttendee(eventId: string, email: string, authorization?: CalendarPrivacyAuthorization): CalendarReceipt; cancel(eventId: string, authorization?: CalendarPrivacyAuthorization): CalendarReceipt; hasConflict(start: string, end: string, exceptEventId?: string): boolean; }
