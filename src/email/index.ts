export type EmailKind = 'DIGEST' | 'SCHEDULING' | 'REMINDER' | 'POLL_REMINDER' | 'POLL_CLOSED' | 'POLL_OUTCOME' | 'FEEDBACK' | 'STORY_APPROVAL' | 'STAFF_SUMMARY';
export interface RenderedEmail { subject: string; html: string; text: string }
type Card = { topic_label?: unknown; participation_role?: unknown; opportunity_id?: unknown; other_founder_count?:unknown; working_count?:unknown; experience_count?:unknown; subtopics?:unknown };
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const link = (appUrl: string, view: string, id?: unknown) => {
  if (!/^https?:\/\//.test(appUrl)) throw new Error('An absolute HTTP(S) app URL is required for email links.');
  const base = appUrl.split('?')[0].split('#')[0];
  return `${base}?view=${encodeURIComponent(view)}${id ? `&id=${encodeURIComponent(String(id))}` : ''}`;
};
const paragraph = (text: string) => `<p style="margin:0 0 18px;font:16px/1.6 Arial,sans-serif;color:#20262b">${escapeHtml(text)}</p>`;
const action = (label: string, url: string, secondary = false) => `<a href="${escapeHtml(url)}" style="display:inline-block;max-width:100%;margin:0 8px 12px 0;padding:12px 18px;border:1px solid ${secondary ? '#53636d' : '#000000'};border-radius:24px;background:${secondary ? '#ffffff' : '#000000'};color:${secondary ? '#18242b' : '#ffffff'};font:600 15px/1.4 Arial,sans-serif;text-decoration:none;overflow-wrap:anywhere">${escapeHtml(label)}</a>`;

/** Only call with recipient-safe DTOs; private notes and match graphs are never rendered. */
export function renderEmail(kind: EmailKind, data: Record<string, unknown>, appUrl: string): RenderedEmail {
  const name = String(data.first_name || 'there');
  const topic = String(data.topic_label || 'this topic');
  const preferenceUrl = link(appUrl, 'preferences');
  let subject: string;
  let body = paragraph(`Hi ${name},`);
  const plain: string[] = [`Hi ${name},`, ''];
  const add = (text: string) => { body += paragraph(text); plain.push(text, ''); };
  const addAction = (label: string, view: string, id?: unknown) => { const url = link(appUrl, view, id); body += action(label, url); plain.push(`${label}: ${url}`, ''); };
  if (kind === 'DIGEST') {
    const cards = (Array.isArray(data.cards) ? data.cards : []) as Card[];
    const selected = cards.slice(0, 3);
    subject = selected.length === 1 ? `Volta Pulse | A founder conversation is forming around ${String(selected[0].topic_label||'your topic')}` : 'Volta Pulse | Specific founder conversations are forming';
    add(`Pulse found ${selected.length} specific new ${selected.length === 1 ? 'opportunity' : 'opportunities'} based on the topics you chose to share.`);
    // Story approval and synthetic-environment gating are checked by the caller.
    const story = data.story && typeof data.story === 'object' ? data.story as Record<string, unknown> : null;
    if (story?.approved_text && story.permitted_for_recipient === true && String(story.approved_text).trim().split(/\s+/).length <= 45) {
      const text = String(story.approved_text);
      body += `<blockquote style="margin:0 0 22px;border-left:3px solid #087984;padding:10px 16px;background:#f2f8f9;font:15px/1.6 Arial,sans-serif;color:#24333b;white-space:pre-wrap">${escapeHtml(text)}</blockquote>`;
      plain.push(text, '');
    }
    const sections = [
      { roles: ['WORKING_THROUGH', 'BOTH'], heading: "SOMETHING YOU'RE WORKING THROUGH" },
      { roles: ['EXPERIENCE', 'LIVED_THROUGH'], heading: "SOMETHING YOU'VE EXPERIENCED" },
    ];
    for (const section of sections) {
      const sectionCards = selected.filter(card => section.roles.includes(String(card.participation_role)));
      if (!sectionCards.length) continue;
      body += `<h2 style="margin:24px 0 12px;font:600 12px/1.5 Arial,sans-serif;letter-spacing:1px;color:#46545c">${escapeHtml(section.heading)}</h2>`;
      plain.push(section.heading, '');
      for (const card of sectionCards) {
        const both = card.participation_role === 'BOTH';
        const experienced = card.participation_role === 'EXPERIENCE' || card.participation_role === 'LIVED_THROUGH';
        const label = String(card.topic_label || 'Founder conversation');
        const otherCount=Number(card.other_founder_count||0),workingCount=Number(card.working_count||0),experienceCount=Number(card.experience_count||0),activeCount=workingCount||otherCount,subtopics=Array.isArray(card.subtopics)?card.subtopics.map(String).slice(0,3):[];
        const description = experienced ? `You told Pulse you would be open to sharing your experience with this topic. ${activeCount} ${activeCount===1?'founder is':'founders are'} now actively working through it.` : both ? `You told Pulse this is both current for you and something you have experienced. A small founder group may now be forming.` : `You told Pulse you are actively figuring this out. ${otherCount} other ${otherCount===1?'founder has':'founders have'} closely related questions${experienceCount?`, and ${experienceCount} ${experienceCount===1?'founder has':'founders have'} relevant experience`:''}.`;
        const url = link(appUrl, 'opportunity', card.opportunity_id);
        const detail=subtopics.length?`Strongest overlap: ${subtopics.join(', ')}.`:'Pulse has found enough new overlap to make a small group useful.';
        const cta=experienced?'Include me if this group goes ahead':'Join if this group goes ahead';
        body += `<div style="border:1px solid #d0d9de;border-radius:10px;padding:20px;margin:0 0 16px;overflow-wrap:anywhere"><h3 style="margin:0 0 12px;font:600 20px/1.3 Arial,sans-serif;color:#111820">${escapeHtml(label)}</h3>${paragraph(description)}${paragraph(detail)}${paragraph('Proposed conversation · 30 minutes · Online · Small founder group')}${action(cta, url)}${action('Not this time', url, true)}</div>`;
        plain.push(label, description, detail,'Proposed conversation · 30 minutes · Online · Small founder group', `${cta}: ${url}`, `Not this time (authenticated confirmation): ${url}`, '');
      }
    }
    add('Your name and contact details are only shared with the confirmed group if you later agree to a meeting time and its disclosure terms.');
  } else if (kind === 'SCHEDULING') {
    subject = 'Volta Pulse | Choose a time for your founder conversation';
    add(`At least three founders from different companies are interested in comparing notes on ${topic}.`);
    add('Choose every time you could attend a 30-minute online conversation.');
    addAction('Choose times', 'schedule', data.conversation_id);
    add('There are no slides or preparation. Bring one real question and share your experience rather than instructions.');
  } else if (kind === 'REMINDER' || kind === 'POLL_REMINDER') {
    subject = 'Volta Pulse | A reminder to choose a time';
    add(`If you still want to join the founder conversation on ${topic}, choose every offered time you could attend before the poll closes.`);
    addAction('Choose times', 'schedule', data.conversation_id);
    add('Neither works and Withdraw interest are available on the page. No meeting is booked from opening this link.');
  } else if (kind === 'POLL_CLOSED' || kind === 'POLL_OUTCOME') {
    subject = 'Volta Pulse | Your conversation scheduling update';
    add(`There wasn't a time that worked for at least three companies for the founder conversation on ${topic}. This scheduling poll is now closed.`);
    add('Your topic remains until its normal expiry. You do not need to do anything, and no meeting has been booked.');
  } else if (kind === 'FEEDBACK') {
    subject = 'Did this founder conversation help?';
    add(`Did the conversation about ${topic} help you make progress?`);
    const feedbackUrl=link(appUrl,'feedback',data.conversation_id);
    body += action('Yes',`${feedbackUrl}&answer=yes`)+action('No',`${feedbackUrl}&answer=no`,true)+`<br><a href="${escapeHtml(`${feedbackUrl}&answer=did_not_attend`)}" style="color:#075e70;font:14px/1.5 Arial,sans-serif">I didn’t attend</a>`;
    plain.push(`Yes: ${feedbackUrl}&answer=yes`,`No: ${feedbackUrl}&answer=no`,`I didn’t attend: ${feedbackUrl}&answer=did_not_attend`, '');
  } else if (kind === 'STORY_APPROVAL') {
    subject = 'Volta Pulse | Review this exact story wording';
    add(`A founder from your conversation about ${topic} would like to share one sentence about what came from the conversation.`);
    if (typeof data.story_text === 'string' && data.story_text.trim()) {
      const text = data.story_text.trim();
      body += `<blockquote style="margin:0 0 22px;border-left:3px solid #087984;padding:10px 16px;background:#f2f8f9;font:15px/1.6 Arial,sans-serif;color:#24333b;white-space:pre-wrap">${escapeHtml(text)}</blockquote>`;
      plain.push(`Proposed wording: “${text}”`, '');
    }
    add('Review this exact text and its sharing terms before deciding. Any later edit requires a new approval.');
    addAction('Review wording', 'story', data.story_id);
    add('No response means no approval. Keeping feedback private is always an option.');
  } else {
    subject = 'Volta Pulse | Weekly operations summary';
    add('The latest Pulse run is available in the restricted staff operations view.');
    const summary = typeof data.summary === 'string' ? data.summary : 'Review job health, unresolved technical exceptions, queued outreach and founder-reported outcomes.';
    add(summary);
    addAction('Open staff operations', 'admin');
    add('Scheduled and completed meetings do not prove attendance or impact. Technical failures belong to the assigned technical owner.');
  }
  const footer = `<div style="border-top:1px solid #cbd5db;padding-top:20px;margin-top:24px;font:13px/1.6 Arial,sans-serif;color:#4e5b64"><strong>Volta Pulse</strong><br><a href="${escapeHtml(preferenceUrl)}" style="color:#075e70">Update topics or pause emails</a>${kind === 'DIGEST' ? ` · <a href="${escapeHtml(preferenceUrl)}" style="color:#075e70">Unsubscribe from match emails</a>` : ''}<br>Links open authenticated pages. Your private monthly review is never copied into Pulse.</div>`;
  plain.push('Volta Pulse', `Update topics or pause emails: ${preferenceUrl}`);
  if (kind === 'DIGEST') plain.push(`Unsubscribe from match emails (confirm on the page): ${preferenceUrl}`);
  plain.push('Links open authenticated pages. Your private monthly review is never copied into Pulse.');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:0;background:#edf1f3"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#edf1f3"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff"><tr><td style="padding:24px 28px;background:#000000;color:#ffffff;font:600 24px/1.3 Arial,sans-serif">volta <span style="font-size:15px;font-weight:400;color:#d2d9dd">| Pulse</span></td></tr><tr><td style="padding:28px;word-break:break-word">${body}${footer}</td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text: plain.join('\n') };
}
