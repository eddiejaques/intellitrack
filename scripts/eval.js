import {readFile} from 'node:fs/promises';
import {fixtures} from '../fixtures/sessions.js';
import {makePayload} from '../extension/src/audit.js';
import {defaults} from '../extension/src/llm.js';
import {planJourney,reviewAudit} from '../extension/src/workflow.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run eval -- /path/to/providers.json');
  process.exit(2);
}
const profiles = JSON.parse(await readFile(file,'utf8'));
const results = [];
for (const provider of Object.keys(defaults)) {
  const profile = profiles[provider];
  if (!profile) {
    results.push({provider,result:'missing configuration'});
    process.exitCode = 1;
    continue;
  }
  const config = {provider,...defaults[provider],max_output_tokens:4000,timeout_s:120,
    max_per_session:5,min_interval_s:30,input_budget:12000,...profile};
  for (const fixture of fixtures) {
    const result = {provider,fixture:fixture.type};
    try {
      const plan = await planJourney(config,fixture.context);
      const expected = fixture.session.journey.steps.flatMap(step => step.expect.map(entry => entry.event));
      const proposed = new Set(plan.journeys.flatMap(journey => journey.steps.flatMap(step => step.expect.map(entry => entry.event))));
      result.planner = {siteType:plan.site_type,expectedCoverage:expected.filter(event => proposed.has(event)).length/expected.length};
      const payload = makePayload(fixture.session,fixture.events);
      const report = await reviewAudit(config,payload);
      result.missingFaults = fixture.faults.filter(title => !report.findings.some(finding => finding.title === title));
      result.extraFindings = report.findings.filter(finding => finding.source === 'llm').map(({title,evidence}) => ({title,evidence}));
      if (result.missingFaults.length) process.exitCode = 1;
    } catch (error) {
      result.error = error.message;
      process.exitCode = 1;
    }
    results.push(result);
  }
}
for (const fixture of fixtures) {
  const passing = results.filter(result => result.fixture === fixture.type && result.planner?.siteType === fixture.type &&
    result.planner.expectedCoverage >= 2/3).length;
  if (passing < 3) process.exitCode = 1;
}
console.log(JSON.stringify(results,null,2));
