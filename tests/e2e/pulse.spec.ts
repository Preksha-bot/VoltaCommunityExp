import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderEmail } from '../../src/email';

type PublicAccount = { username: string; password: string; role: string; identifier: string };
async function call<T>(request: APIRequestContext, method: string, payload: Record<string, unknown> = {}, session?: string): Promise<T> {
  const response = await request.post('/api/rpc', { data: { method, payload, session, requestId: crypto.randomUUID() } });
  const result = await response.json();
  expect(result.ok, `${method}: ${result.errorCode || ''}`).toBe(true);
  return result.data as T;
}
async function account(request: APIRequestContext, username = 'maya.chen'): Promise<PublicAccount> {
  const info = await call<{ accounts: PublicAccount[] }>(request, 'getDemoInfo');
  const found = username === 'ADMIN' ? info.accounts.find(a => a.role === 'ADMIN') : info.accounts.find(a => a.username === username);
  expect(found, `Fictional account ${username} exists`).toBeTruthy(); return found!;
}
async function credentials(request: APIRequestContext, username = 'maya.chen') { const a = await account(request, username); return call<{ credential: string }>(request, 'signIn', { identifier: a.username, password: a.password }); }
async function reset(request: APIRequestContext, profile = 'BASE') { const admin = await credentials(request, 'ADMIN'); await call(request, 'adminAction', { action: 'RESET_DEMO', payload: { profile } }, admin.credential); }
async function signIn(page: Page, request: APIRequestContext, username = 'maya.chen', path = '?view=pulse') {
  const a = await account(request, username); await page.goto(`/${path}`);
  await page.getByLabel('Company ID or username', { exact: true }).fill(a.username);
  await page.getByLabel('Password', { exact: true }).fill(a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.locator('.loading')).toHaveCount(0);
}
async function contained(page: Page) {
  const overflow = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, outside: Array.from(document.querySelectorAll('button, input, select, textarea, .pulse-card, .check-label')).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1); }).map(e => e.tagName + ':' + e.textContent?.trim().slice(0, 60)) }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.width + 1); expect(overflow.outside).toEqual([]);
}
async function basicContrast(page: Page) {
  const result = await page.evaluate(() => {
    type Color = { rgb: number[]; alpha: number };
    const color = (value: string): Color | null => {
      const match = value.match(/rgba?\(([^)]+)\)/); if (!match) return null;
      const parts = match[1].replace('/', ' ').split(/[\s,]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.some(Number.isNaN)) return null;
      return { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 };
    };
    const blend = (foreground: Color, background: number[]) => foreground.rgb.map((channel, i) => channel * foreground.alpha + background[i] * (1 - foreground.alpha));
    const luminance = (rgb: number[]) => rgb.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, i) => sum + channel * [.2126, .7152, .0722][i], 0);
    const background = (element: Element) => {
      const layers: Color[] = [];
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const stops = style.backgroundImage.match(/rgba?\([^)]+\)/g) || [];
        // Primary buttons use a flat inner gradient over the decorative border gradient.
        const flatInner = ancestor.matches('.primary') && stops.length >= 2 && stops[0] === stops[1] ? color(stops[0]) : null;
        const layer = flatInner || color(style.backgroundColor);
        if (layer && layer.alpha > 0) { layers.push(layer); if (layer.alpha >= 1) break; }
      }
      let rgb = [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i--) rgb = blend(layers[i], rgb);
      return rgb;
    };
    const measurements: { element: string; text: string; ratio: number; foreground: string; background: number[] }[] = [];
    const unsupported: string[] = [];
    let skippedDisabled = 0;
    for (const element of Array.from(document.querySelectorAll('body *'))) {
      if (element.closest(':disabled, [aria-disabled="true"]')) { skippedDisabled++; continue; }
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
      const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
      const inputText = input && !['checkbox', 'radio', 'hidden'].includes((element as HTMLInputElement).type) ? (element as HTMLInputElement).value || (element as HTMLInputElement).placeholder : '';
      const ownText = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent || '').join('').trim();
      if (!ownText && !inputText && !(element instanceof HTMLSelectElement)) continue;
      const foregroundStyle = input && !(element as HTMLInputElement).value && (element as HTMLInputElement).placeholder ? getComputedStyle(element, '::placeholder') : style;
      const fg = color(foregroundStyle.color); if (!fg) { unsupported.push(`${element.tagName}: ${foregroundStyle.color}`); continue; }
      const bg = background(element), fgLuminance = luminance(blend(fg, bg)), bgLuminance = luminance(bg);
      const ratio = (Math.max(fgLuminance, bgLuminance) + .05) / (Math.min(fgLuminance, bgLuminance) + .05);
      measurements.push({ element: element.tagName.toLowerCase(), text: (ownText || inputText || (element as HTMLSelectElement).selectedOptions[0]?.textContent || '').slice(0, 70), ratio, foreground: foregroundStyle.color, background: bg });
    }
    const sorted = measurements.sort((a, b) => a.ratio - b.ratio);
    return { checked_text_nodes: measurements.length, skipped_disabled_elements: skippedDisabled, skipped_iframe_elements: document.querySelectorAll('iframe').length, minimum_ratio: sorted[0]?.ratio ?? 0, minimum: sorted[0] || null, failures: sorted.filter(item => item.ratio < 4.5), unsupported };
  });
  expect(result.checked_text_nodes).toBeGreaterThan(0);
  expect(result.unsupported, 'Computed foreground colors must be measurable').toEqual([]);
  expect(result.failures, 'Visible enabled text must have at least 4.5:1 contrast against its opaque ancestor background').toEqual([]);
  return result;
}
test.beforeEach(async ({ request }) => { await reset(request); });

test('company alias sign-in, generic failures, cofounder isolation and memory-only sessions', async ({ page, request }) => {
  const primary = await account(request); await page.goto('/?view=pulse');
  await page.getByLabel('Company ID or username', { exact: true }).fill('unknown-account');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText("We couldn't sign you in. Check your details and try again.");
  await page.getByLabel('Company ID or username', { exact: true }).fill(primary.identifier);
  await page.getByLabel('Password', { exact: true }).fill(primary.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Help Volta find relevant founder conversations for you' })).toBeVisible();
  const own = await credentials(request); const before = await call<{ entries: { entry_id: string; private_context: string }[] }>(request, 'getMyPulse', {}, own.credential);
  await expect(page.locator('body')).not.toContainText(before.entries[0].private_context);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, request, 'jules.hart');
  const cofounder = await credentials(request, 'jules.hart'); const theirs = await call<{ entries: { entry_id: string; private_context: string }[] }>(request, 'getMyPulse', {}, cofounder.credential);
  expect(theirs.entries.some(e => before.entries.some(p => p.entry_id === e.entry_id))).toBe(false);
  const visiblePage = await page.locator('body').innerText();
  for (const entry of before.entries.filter(p => p.private_context && !theirs.entries.some(e => e.private_context === p.private_context))) expect(visiblePage).not.toContain(entry.private_context);
  await page.reload(); await expect(page.getByRole('heading', { name: 'Sign in to Volta Pulse' })).toBeVisible();
});

test('skip does not mutate topics, confirmation expiry or email preference', async ({ page, request }) => {
  const session = await credentials(request);
  const before = await call(request, 'getMyPulse', {}, session.credential);
  await signIn(page, request);
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: "What's happening around Volta this month" })).toBeVisible();
  expect(await call(request, 'getMyPulse', {}, session.credential)).toEqual(before);
  await expect(page.getByRole('navigation')).not.toContainText(/Explore|Radar|Snapshot/);
});

test('topic capture limits, private notes, explicit reconfirmation and save', async ({ page, request }) => {
  await signIn(page, request, 'jules.hart');
  const working = page.locator('#working-section');
  while (await working.getByRole('button', { name: /^Remove / }).count()) await working.getByRole('button', { name: /^Remove / }).first().click();
  await working.getByLabel('Choose or type a topic').fill('hiring');
  await working.locator('.topic-results button').first().click();
  const firstTopic = working.locator('.selected-topic').first();
  await firstTopic.getByText('Sharing', { exact: true }).click();
  await expect(firstTopic.locator('select')).toHaveValue('PRIVATE_MATCH_ONLY');
  await expect(firstTopic.locator('option[value=NAMED_SNAPSHOT]')).toBeDisabled();
  await expect(firstTopic.getByLabel('Private detail')).toHaveCount(0);
  await working.getByLabel('Choose or type a topic').fill('enterprise');
  await working.locator('.topic-results button').first().click();
  await working.getByLabel('Choose or type a topic').fill('fund');
  await expect(working.locator('.topic-results button')).toHaveCount(0);
  await expect(working).toContainText('2 / 2');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: "What's happening around Volta this month" })).toBeVisible();
  const session = await credentials(request, 'jules.hart'); const state = await call<{ entries: { private_context: string; visibility: string }[] }>(request, 'getMyPulse', {}, session.credential);
  expect(state.entries.some(e => e.visibility === 'PRIVATE_MATCH_ONLY')).toBe(true);
});

test('an opportunity link requires recipient login and an explicit interest submit', async ({ page, request }) => {
  const admin = await credentials(request, 'ADMIN'); await call(request, 'adminAction', { action: 'PREVIEW_RUN', payload: {} }, admin.credential);
  const state = await call<{ opportunities: { opportunity_id: string; founder_id: string }[] }>(request, 'getAdmin', {}, admin.credential);
  const offer = state.opportunities.find(o => o.founder_id === 'F001')!; expect(offer).toBeTruthy();
  await signIn(page, request, 'jules.hart', `?view=opportunity&id=${encodeURIComponent(offer.opportunity_id)}`);
  await expect(page.getByRole('heading', { name: 'This item is unavailable' })).toBeVisible();
  await signIn(page, request, 'maya.chen', `?view=opportunity&id=${encodeURIComponent(offer.opportunity_id)}`);
  await expect(page.getByText(/This records interest only/)).toBeVisible();
  const founder = await credentials(request); const opened = await call<{ status: string }>(request, 'getOpportunity', { opportunityId: offer.opportunity_id }, founder.credential);
  expect(opened.status).not.toBe('INTERESTED');
  await page.getByRole('button', { name: /Join if this group goes ahead|Include me if this group goes ahead/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /Interest saved/ })).toBeVisible();
  expect((await call<{ status: string }>(request, 'getOpportunity', { opportunityId: offer.opportunity_id }, founder.credential)).status).toBe('INTERESTED');
  await expect(page.getByRole('button', { name: 'Not this time', exact: true })).toHaveCount(0);
  await signIn(page, request, 'maya.chen', `?view=opportunity&id=${encodeURIComponent(offer.opportunity_id)}`);
  await expect(page.getByRole('status').filter({ hasText: /interest is already recorded/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Join if this group goes ahead|Include me if this group goes ahead/ })).toHaveCount(0);
});

test('scheduling displays local instants and requires separate unchecked permissions', async ({ page, request }) => {
  await reset(request, 'GROUP_READY'); await signIn(page, request, 'maya.chen', '?view=schedule&id=G001');
  await expect(page.getByRole('heading', { name: 'Choose a time for your founder conversation' })).toBeVisible();
  const checkboxes = page.locator('input[type=checkbox]'); expect(await checkboxes.count()).toBe(4);
  for (const checkbox of await checkboxes.all()) await expect(checkbox).not.toBeChecked();
  await expect(page.getByText(/Oct 20, 2026.*12:00/)).toBeVisible();
  await checkboxes.first().check(); await page.getByRole('button', { name: 'Submit availability', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Confirm booking and identity disclosure before submitting available times.');
  await page.getByLabel(/You may book one 30-minute meeting/).check(); await page.getByLabel(/My name, company and email/).check();
  await page.getByRole('button', { name: 'Submit availability', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /Availability saved/ })).toBeVisible();
});

test('feedback records one story permission and creates a Laura review draft without second founder approval', async ({ page, request }) => {
  await reset(request, 'STORY_CASES'); await signIn(page, request, 'maya.chen', '?view=feedback&id=G004');
  await page.getByLabel('Yes', { exact: true }).check();
  await page.getByLabel('What was useful?').fill('We revised our interview questions.');
  await page.getByLabel(/Share as an anonymous success story/).check();
  await page.getByRole('button', { name: 'Submit feedback' }).click();
  await expect(page.getByRole('heading', { name: 'Thanks — your feedback was saved.' })).toBeVisible();
  const admin = await credentials(request, 'ADMIN');
  const state = await call<{ feedback: { conversation_id: string; sharing_permission: string }[]; stories: { source_feedback: { conversation_id: string }; status: string; story_id: string }[] }>(request, 'getAdmin', {}, admin.credential);
  expect(state.feedback.find(item => item.conversation_id === 'G004')?.sharing_permission).toBe('anonymous_story');
  const story = state.stories.find(item => item.source_feedback?.conversation_id === 'G004')!;
  expect(story.status).toBe('DRAFT');
  await call(request, 'adminAction', { action: 'APPROVE_STORY', payload: { storyId: story.story_id } }, admin.credential);
});

test('staff drafts, pause controls and operational outcomes are accessible', async ({ page, request }) => {
  await signIn(page, request, 'ADMIN', '?view=admin');
  await page.getByRole('button', { name: 'Prepare this week’s email drafts' }).click();
  await expect(page.getByRole('heading', { name: 'Email drafts' })).toBeVisible();
  await expect(page.getByText('Volta Pulse | New conversations to consider').first()).toBeVisible();
  const admin = await credentials(request, 'ADMIN');
  const beforeReview = await call<{ queue: { email_id: string; status: string; reviewed_at_utc?: string }[] }>(request, 'getAdmin', {}, admin.credential);
  const draft = beforeReview.queue.find(row => row.status === 'DRAFT')!;
  await page.getByRole('button', { name: 'Confirm draft checked', exact: true }).first().click();
  await expect(page.locator('.notice').filter({ hasText: /Draft review recorded/ })).toBeVisible();
  const afterReview = await call<{ queue: { email_id: string; status: string; reviewed_at_utc?: string }[] }>(request, 'getAdmin', {}, admin.credential);
  expect(afterReview.queue.find(row => row.email_id === draft.email_id)).toMatchObject({ status: 'DRAFT', reviewed_at_utc: expect.any(String) });
  await page.getByText('Edit existing controlled topics', { exact: true }).click();
  const topicForm = page.locator('.edit-topic-form').first();
  await topicForm.locator('..').locator('summary').click();
  await topicForm.getByLabel('Topic label', { exact: true }).fill('Hiring the first salesperson — reviewed');
  await topicForm.getByLabel('Search synonyms, one per line', { exact: true }).fill('first sales hire\nfirst salesperson');
  await topicForm.getByRole('button', { name: 'Save reviewed topic change' }).click();
  await expect(page.locator('.notice').filter({ hasText: /Staff action completed/ })).toBeVisible();
  const updated = await call<{ topics: { topic_id: string; topic_label: string; synonyms: string[]; revision: number }[] }>(request, 'getAdmin', {}, admin.credential);
  expect(updated.topics.find(topic => topic.topic_id === 'T01')).toMatchObject({ topic_label: 'Hiring the first salesperson — reviewed', synonyms: ['first sales hire', 'first salesperson'], revision: 2 });
  await page.getByRole('button', { name: 'Pause new outreach', exact: true }).click();
  await expect(page.locator('.notice').filter({ hasText: /DEMO \/ PAUSED/ })).toBeVisible();
  await page.getByRole('button', { name: 'Resume draft processing', exact: true }).click();
  await expect(page.locator('.notice').filter({ hasText: /DEMO \/ DRAFT_ONLY/ })).toBeVisible();
  // Read-only response variants exercise the TEST/LIVE surface using the local demo backend.
  let displayedEnvironment = 'TEST';
  await page.route('**/api/rpc', async route => {
    const method = route.request().postDataJSON().method;
    if (!['getDemoInfo', 'getAdmin'].includes(method)) { await route.continue(); return; }
    const response = await route.fetch(); const result = await response.json();
    result.data.environment = displayedEnvironment;
    await route.fulfill({ response, json: result });
  });
  for (const environment of ['TEST', 'LIVE']) {
    displayedEnvironment = environment;
    await signIn(page, request, 'ADMIN', '?view=admin');
    await expect(page.getByRole('button', { name: 'Simulate queued delivery' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Simulate booking worker' })).toHaveCount(0);
    await expect(page.getByText(/Current time:/)).toBeVisible();
  }
});

test('all founder views and staff controls contain long content at required widths and 200% zoom', async ({ page, request }, testInfo) => {
  test.setTimeout(120000);
  const admin = await credentials(request, 'ADMIN');
  const base = await call<{ opportunities: { opportunity_id: string; founder_id: string }[] }>(request, 'getAdmin', {}, admin.credential);
  const opportunity = base.opportunities.find(row => row.founder_id === 'F001')!;
  const contrastReports: Record<string, unknown>[] = [];
  const screens = [
    { view: 'signin', profile: 'BASE', username: '', title: 'Sign in to Volta Pulse' },
    { view: 'pulse', profile: 'BASE', username: 'maya.chen', title: 'Help Volta find relevant founder conversations for you' },
    { view: 'snapshot', profile: 'BASE', username: 'maya.chen', title: "What's happening around Volta this month" },
    { view: 'preferences', profile: 'BASE', username: 'maya.chen', title: 'Your topics & preferences' },
    { view: `opportunity&id=${opportunity.opportunity_id}`, profile: 'BASE', username: 'maya.chen', title: 'Join a conversation about this topic' },
    { view: 'schedule&id=G001', profile: 'GROUP_READY', username: 'maya.chen', title: 'Choose a time for your founder conversation' },
    { view: 'feedback&id=G004', profile: 'STORY_CASES', username: 'maya.chen', title: 'Did this founder conversation help?' },
    { view: 'story&id=ST002', profile: 'STORY_CASES', username: 'maya.chen', title: 'Your feedback sharing choice' },
    { view: 'admin', profile: 'BASE', username: 'ADMIN', title: 'Pulse operations' },
  ];
  for (const screen of screens) {
    await reset(request, screen.profile);
    if (screen.username) await signIn(page, request, screen.username, `?view=${screen.view}`); else await page.goto('/?view=signin');
    await expect(page.getByRole('heading', { name: screen.title, exact: true })).toBeVisible();
    if (screen.view === 'admin') { await page.getByText('Edit existing controlled topics', { exact: true }).click(); await page.locator('.edit-topic-form').first().locator('..').locator('summary').click(); }
    for (const width of [320, 360, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await contained(page); contrastReports.push({ view: screen.view, width, variant: 'normal', ...(await basicContrast(page)) }); if ([390, 1440].includes(width)) await page.screenshot({ path: testInfo.outputPath(`${screen.view.replace(/[^a-z0-9]/gi, '-')}-${width}.png`), fullPage: true }); }
    // UI-only stress data. This does not change any server state or permissions.
    await page.evaluate(() => {
      const title = document.querySelector('.pulse-card h2, .pulse-card h3'); if (title) title.textContent = 'A very long fictional company or topic name for responsive verification '.repeat(8);
      const label = document.querySelector('.check-label span'); if (label) label.textContent += ' Clear permission wording stays readable even when labels become much longer. '.repeat(6);
      const error = document.createElement('div'); error.className = 'notice error'; error.setAttribute('role', 'alert'); error.textContent = 'A long recoverable error message with a resource reference abcdefghijklmnopqrstuvwxyz0123456789'.repeat(5); document.querySelector('#main')!.append(error);
    });
    for (const width of [320, 360, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await contained(page); contrastReports.push({ view: screen.view, width, variant: 'long-text-and-error', ...(await basicContrast(page)) }); }
    await page.setViewportSize({ width: 640, height: 900 });
    await page.addStyleTag({ content: 'html { zoom: 2; }' }); await contained(page); contrastReports.push({ view: screen.view, width: 640, variant: 'zoom-200-percent', ...(await basicContrast(page)) });
    await page.keyboard.press('Tab'); const focus = await page.evaluate(() => document.activeElement?.tagName); expect(focus).not.toBe('BODY');
    await page.goto('/?view=signin');
  }
  const reportPath = testInfo.outputPath('contrast-minima.json');
  const report = { scope: 'Basic computed text contrast in the top-level document; disabled controls exempt; native menus, images, decorative borders and third-party Gmail/Calendar rendering excluded', threshold: 4.5, minimum_ratio: Math.min(...contrastReports.map(item => Number(item.minimum_ratio))), views: screens.map(screen => { const items = contrastReports.filter(item => item.view === screen.view); return { view: screen.view, minimum_ratio: Math.min(...items.map(item => Number(item.minimum_ratio))), checked_text_observations: items.reduce((total, item) => total + Number(item.checked_text_nodes), 0), skipped_disabled_observations: items.reduce((total, item) => total + Number(item.skipped_disabled_elements), 0), skipped_iframe_observations: items.reduce((total, item) => total + Number(item.skipped_iframe_elements), 0) }; }), measurements: contrastReports };
  const reportJson = JSON.stringify(report, null, 2);
  writeFileSync(reportPath, reportJson);
  mkdirSync('reports', { recursive: true }); writeFileSync('reports/accessibility-results.json', reportJson);
  await testInfo.attach('Basic text contrast minima', { path: reportPath, contentType: 'application/json' });
});

test('emails include one merged BOTH card, experience wording, escaped text and authenticated links', async ({ page }, testInfo) => {
  const cases = [
    { name: 'single', cards: [{ topic_label: 'Hiring our first salesperson', participation_role: 'WORKING_THROUGH', opportunity_id: 'o1' }] },
    { name: 'experience', cards: [{ topic_label: 'Selling to enterprise customers', participation_role: 'LIVED_THROUGH', opportunity_id: 'o2' }] },
    { name: 'combined', cards: [{ topic_label: 'A very long topic label '.repeat(10), participation_role: 'BOTH', opportunity_id: 'o1' }, { topic_label: '<script>private</script>', participation_role: 'LIVED_THROUGH', opportunity_id: 'o2' }, { topic_label: 'Fundraising', participation_role: 'WORKING_THROUGH', opportunity_id: 'o3' }] },
  ];
  for (const fixture of cases) {
    const email = renderEmail('DIGEST', { first_name: 'Maya', cards: fixture.cards }, 'http://127.0.0.1:5173');
    expect(email.subject).not.toContain('Hiring'); expect(email.html).not.toContain('<script>'); expect(email.text).toContain('?view=opportunity&id=');
    if (fixture.name === 'experience') { expect(email.text).toContain("SOMETHING YOU'VE EXPERIENCED"); expect(email.text).toContain('Include me if this group goes ahead'); }
    if (fixture.name === 'combined') expect(email.text.match(/A very long topic label/g)?.length).toBe(10);
    await page.setContent(email.html);
    for (const width of [320, 390, 768]) { await page.setViewportSize({ width, height: 900 }); await contained(page); if (width === 390) await page.screenshot({ path: testInfo.outputPath(`email-${fixture.name}-390.png`), fullPage: true }); }
  }
  const privateStory = renderEmail('DIGEST', { cards: cases[0].cards, story: { approved_text: 'Not approved for this recipient' } }, 'http://127.0.0.1:5173'); expect(privateStory.html).not.toContain('Not approved for this recipient');
  const exact = 'Approved wording  with preserved spaces\nand a line break.';
  const permitted = renderEmail('DIGEST', { cards: cases[0].cards, story: { approved_text: exact, permitted_for_recipient: true } }, 'http://127.0.0.1:5173'); expect(permitted.text).toContain(exact); expect(permitted.html).toContain(exact);
  const overlong = 'unique-approved-word '.repeat(46);
  const omitted = renderEmail('DIGEST', { cards: cases[0].cards, story: { approved_text: overlong, permitted_for_recipient: true } }, 'http://127.0.0.1:5173'); expect(omitted.html).not.toContain('unique-approved-word'); expect(omitted.text).not.toContain('unique-approved-word');
  const fortyFiveWords = Array.from({ length: 45 }, (_, i) => `word${i + 1}`).join(' ');
  const boundary = renderEmail('DIGEST', { cards: cases[0].cards, story: { approved_text: fortyFiveWords, permitted_for_recipient: true } }, 'http://127.0.0.1:5173'); expect(boundary.html).toContain(fortyFiveWords); expect(boundary.text).toContain(fortyFiveWords);
});
