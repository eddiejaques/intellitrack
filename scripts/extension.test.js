import assert from 'node:assert/strict';
import test from 'node:test';
import {ga4} from '../extension/src/ga4.js';
import {makePayload,pathPattern} from '../extension/src/audit.js';
import {complete,defaults} from '../extension/src/llm.js';
import {connectionSchema} from '../extension/src/schemas.js';
import {reviewAudit} from '../extension/src/workflow.js';
import {fixtures} from '../fixtures/sessions.js';

test('parses split, batched first-party GA4 beacons',() => {
  const bytes = new TextEncoder().encode('en=view_item&ep.item_name=café\nen=purchase&epn.value=20&pr1=idSKU~pr10~qt2');
  const request = {url:'https://tags.example.test/first-party/g/collect?v=2&tid=G-TEST&cid=123&gcs=G111',
    requestId:'r1',timeStamp:2500,type:'ping',method:'POST',
    requestBody:{raw:[{bytes:bytes.slice(0,29).buffer},{bytes:bytes.slice(29).buffer}]}};
  assert.equal(ga4.match(request),true);
  const events = ga4.parse(request,{id:'s1',startedAt:1000,step:'S1'});
  assert.equal(events.length,2);
  assert.equal(events[0].params.item_name,'café');
  assert.equal(events[1].params.value,20);
  assert.deepEqual(events[1].items,[{item_id:'SKU',price:10,quantity:2}]);
  assert.equal(events[1].t,1.5);
  assert.equal(ga4.match({url:'https://tags.example.test/g/collect?v=2&tid=UA-X'}),false);
  assert.equal(ga4.parse({...request,url:request.url+'&en=page_view',requestBody:null},{id:'s2',startedAt:1000})[0].event,'page_view');
});

test('seeded faults are found and preview redacts sensitive values',() => {
  for (const fixture of fixtures) {
    const payload = makePayload(fixture.session,fixture.events);
    for (const fault of fixture.faults) assert.ok(payload.findings.some(finding => finding.title === fault),fault);
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized,/example\.test|123\.456/);
    const ids = new Set(payload.events.map(event => (event.sample ?? event).id));
    assert.ok(payload.findings.every(finding => finding.evidence.every(id => ids.has(id))));
  }
  assert.equal(pathPattern('https://example.test/user/alice%40example.test/42?secret=a'),'/user/:id/:id');
});

const config = provider => ({provider,...defaults[provider],api_key:'test',max_output_tokens:4000,
  timeout_s:10,max_per_session:5,min_interval_s:0,input_budget:12000});
const responses = {
  openai:content => ({choices:[{message:{content}}]}),
  openai_compatible:content => ({choices:[{message:{content}}]}),
  anthropic:text => ({content:[{type:'text',text}]}),
  gemini:text => ({candidates:[{content:{parts:[{text}]}}]})
};
for (const [provider,response] of Object.entries(responses)) {
  test(`${provider} adapter validates and retries once`,async () => {
    let calls = 0;
    const request = {system:'Test connection',input:{},schema:connectionSchema};
    const result = await complete(config(provider),request,async (url,options) => {
      assert.ok(url.startsWith(defaults[provider].base_url));
      assert.equal(options.redirect,'error');
      if (calls) assert.match(options.body,/validation error/);
      return Response.json(response(calls++ ? '{"status":"ok"}' : '{"status":"wrong"}'));
    });
    assert.deepEqual(result,{status:'ok'});
    assert.equal(calls,2);
    calls = 0;
    await assert.rejects(complete(config(provider),request,async () => {
      calls++;
      return Response.json(response('invalid'));
    }),/after one retry/);
    assert.equal(calls,2);
  });
}
test('LLM findings cannot cite events outside the preview',async () => {
  const fixture = fixtures[0];
  const payload = makePayload(fixture.session,fixture.events);
  const finding = {id:'F1',severity:'high',vendor:'ga4',category:'wrong_value',title:'Review',
    detail:'Sample finding',recommendation:'Check the tag'};
  const response = {summary:{score:72,headline:'Review complete'},findings:[
    {...finding,evidence:['evt_1']},{...finding,id:'F2',evidence:['invented']}
  ]};
  const report = await reviewAudit(config('openai'),payload,async () => Response.json(responses.openai(JSON.stringify(response))));
  assert.equal(report.findings.length,payload.findings.length+1);
  assert.equal(report.findings.at(-1).source,'llm');
  assert.deepEqual(report.findings.at(-1).evidence,['evt_1']);
});
