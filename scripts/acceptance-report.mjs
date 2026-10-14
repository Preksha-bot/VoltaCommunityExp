import fs from 'node:fs/promises';
const scenarios=JSON.parse(await fs.readFile('reports/spec-scenarios.json','utf8'));
const browser=JSON.parse(await fs.readFile('reports/browser-results.json','utf8'));
const definitions=JSON.parse(await fs.readFile('fixtures/test-cases.json','utf8'));
scenarios.tests=scenarios.tests.map(result=>{const definition=definitions.find(t=>t.test_id===result.test_id);return{test_name:definition?.test_name,fixture_profile:definition?.fixture_profile,expected_result:definition?.expected_result,...result,evidence:result.test_id==='UI01'?'tests/e2e/pulse.spec.ts':'tests/acceptance/spec.test.ts'};});
const specs=[];function collect(suite){for(const spec of suite.specs||[])specs.push(spec);for(const child of suite.suites||[])collect(child);}for(const suite of browser.suites||[])collect(suite);
const layout=specs.find(s=>s.title.includes('all founder views and staff controls contain'));
const passed=s=>s.ok===true&&s.tests.every(t=>t.results.length&&t.results[t.results.length-1].status==='passed');
const ui=scenarios.tests.find(t=>t.test_id==='UI01');
if(ui){ui.result=layout&&passed(layout)?'PASS':'FAIL';ui.observed='Playwright measured all tested views at 320, 360, 390, 768, 1024 and 1440px plus 200% zoom; asserted document and control containment and keyboard focus. Screenshots retained in test-results.';}
const result={...scenarios,browser_tests:specs.length,browser_passed:specs.filter(passed).length,passed:scenarios.tests.filter(t=>t.result==='PASS').length,failed:scenarios.tests.filter(t=>t.result!=='PASS').length,live_integrations:'NOT_VERIFIED'};
await fs.writeFile('reports/acceptance-results.json',JSON.stringify(result,null,2));
process.stdout.write(`${result.passed}/${result.tests.length} specification scenarios and ${result.browser_passed}/${result.browser_tests} browser tests passed. Live integrations remain unverified.\n`);
if(result.failed||result.browser_passed!==result.browser_tests)process.exit(1);
