import { PulseError, type Row, type TableName } from '../shared/types';

/** An alternative key is allowed only for the two documented audit ID spellings. */
export const PRIMARY_KEYS:Record<TableName,string[][]>={
  Companies:[['company_id']],Founders:[['founder_id']],Topics:[['topic_id']],PulseEntries:[['entry_id']],ConsentLog:[['consent_event_id']],
  OutreachHistory:[['history_id']],Conversations:[['conversation_id']],InterestResponses:[['response_id']],TimeSlots:[['slot_id']],Availability:[['availability_id']],
  Feedback:[['feedback_id']],Stories:[['story_id']],StoryApprovals:[['approval_id']],Settings:[['setting_key']],Accounts:[['account_id']],AuthSessions:[['session_ref']],
  MatchRuns:[['run_id']],Opportunities:[['opportunity_id']],WeeklyEmails:[['email_id']],WeeklyEmailItems:[['email_item_id']],ConversationMembers:[['conversation_id','founder_id']],
  SnapshotBatches:[['snapshot_id']],SnapshotCells:[['snapshot_cell_id']],ActivityLog:[['activity_id'],['event_id']],Exceptions:[['exception_id']],AuthAttempts:[['attempt_id']],RequestResults:[['account_id','method','request_id']]
};

export function recordId(table:TableName,row:Row):string {
  const fields=PRIMARY_KEYS[table].find(key=>key.every(field=>typeof row[field]==='string'&&(row[field] as string).trim().length>0));
  if(!fields)throw new PulseError('RECORD_ID_REQUIRED');
  // JSON encoding avoids ambiguous composite keys when IDs contain a separator.
  return fields.length===1?row[fields[0]] as string:JSON.stringify(fields.map(field=>row[field]));
}
