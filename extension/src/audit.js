const email = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/i;
const phone = /(?:\+?\d[\d ().-]{6,}\d)/;
const hash = /^[a-f\d]{64}$/i;
const text = value => String(value ?? '');
export function redact(value, key = '') {
  if (value == null || value === '') return value;
  const s = text(value);
  if (hash.test(s)) return '[sha256:64hex]';
  if (/hash|sha256/i.test(key) && /^[a-f\d]+$/i.test(s)) return `[hash:invalid len=${s.length}]`;
  if (email.test(s)) return '[email:plaintext]';
  if (/https?:\/\//i.test(s)) return '[url]';
  if (phone.test(s) && (typeof value === 'string' || /phone|tel/i.test(key))) return '[phone:plaintext]';
  if (/email|phone|password|secret|address|first.?name|last.?name|full.?name|user.?id|client.?id|token/i.test(key)) return '[present]';
  return value;
}
export function pathPattern(value) {
  try {
    return new URL(value).pathname.split('/').map(part => {
      const decoded = decodeURIComponent(part);
      return redact(decoded) !== decoded || /\d|[^a-z_-]/i.test(decoded) ? (decoded ? ':id' : '') : decoded;
    }).join('/');
  } catch { return '/'; }
}
const identity = event => JSON.stringify([event.property,event.event,
  Object.entries(event.params).sort(([a],[b]) => a.localeCompare(b)),event.items]);

export function coverage(journey, events, reachedOnly = false, markers = []) {
  const order = journey?.steps ?? [];
  const reached = order.findLastIndex(step => markers.includes(step.id) ||
    events.some(event => event.page.step === step.id ||
      step.expect.some(expected => expected.event === event.event)));
  let after = -Infinity;
  return order.map((step,index) => {
    const expected = step.expect.map(entry => entry.event);
    const observed = [];
    const issues = [];
    let last = after;
    for (const entry of step.expect) {
      const candidates = events.filter(event => event.event === entry.event &&
        (!event.page.step || event.page.step === step.id));
      const ordered = candidates.filter(event => event.t >= after);
      const complete = ordered.find(event => (entry.params ?? []).every(key => event.params[key] != null && event.params[key] !== ''));
      const match = complete ?? ordered[0] ?? candidates[0];
      if (!match) {
        issues.push({category:'missing_event', name:entry.event, ids:[]});
        continue;
      }
      observed.push(entry.event);
      if (match.t < after) issues.push({category:'wrong_value',name:`${entry.event} fired out of order`,ids:[match.id]});
      else if (!complete) issues.push({category:'missing_param',name:`${entry.event} requires ${entry.params.join(', ')}`,ids:[match.id]});
      last = Math.max(last,match.t);
    }
    after = last;
    return {step:step.id,name:step.name,expected,observed,
      status:reachedOnly && index > reached ? 'pending' : issues.length ? observed.length ? 'partial' : 'missing' : 'matched',issues};
  });
}

export function makePayload(session, input) {
  const events = [...input].sort((a,b) => a.t - b.t);
  const findings = [];
  const add = (category,title,severity,evidence = []) => findings.push({
    id:`R${findings.length+1}`,severity,vendor:'ga4',category,title,
    detail:title,evidence,recommendation:'Review the GA4 tag and verify the corrected hit.',source:'rule'
  });
  const conversions = new Map();
  const clients = new Set();
  const properties = new Set();
  const consent = new Set();
  const recent = new Map();
  const pages = [];
  const minimized = [];
  let heartbeats = 0;
  let duplicates = 0;
  let cartItems = [];
  for (const event of events) {
    const ids = [event.id];
    const params = Object.fromEntries(Object.entries(event.params).filter(([key]) => !['_z','_p','_s'].includes(key)));
    const clean = record => Object.fromEntries(Object.entries(record).map(([key,value]) => {
      const safeKey = /^[a-z_][a-z_0-9]{0,39}$/i.test(key) && redact(key) === key ? key : '[redacted_key]';
      const scrubbed = redact(value,key);
      const standardCurrency = key === 'currency' && /^[A-Z]{3}$/.test(value);
      const safeValue = scrubbed !== value || typeof value !== 'string' || standardCurrency || !value ? scrubbed : '[text:present]';
      return [safeKey,safeValue];
    }));
    const sensitive = [...Object.entries(params),...event.items.flatMap(Object.entries),
      ...Object.entries(event.user).filter(([key]) => key !== 'client_id'),['title',event.page.title],['location',safeDecode(event.page.url)]];
    if (sensitive.some(([key,value]) => value != null && (
      /^\[(email|phone|sha256|hash):/.test(redact(value,key)) ||
      /email|phone|password|address|first.?name|last.?name|full.?name/i.test(key)
    ))) add('pii','GA4 hit contains a sensitive value','critical',ids);
    if (!event.consent.gcs || !event.consent.gcd) add('consent','GA4 consent signals are missing','medium',ids);
    const signal = JSON.stringify(event.consent);
    if (consent.size && !consent.has(signal)) add('consent','GA4 consent signals changed','medium',ids);
    consent.add(signal);
    if (event.user.client_id && !clients.has(event.user.client_id)) {
      if (clients.size) add('wrong_value','GA4 client ID changed during the journey','medium',ids);
      clients.add(event.user.client_id);
    }
    if (properties.size && !properties.has(event.property)) add('wrong_value','An additional GA4 property appeared','medium',ids);
    properties.add(event.property);
    if (event.transport.error || event.transport.status >= 400) add('wrong_value','A GA4 hit failed or was blocked','high',ids);
    const conversionId = params.transaction_id ?? params.lead_id ?? params.event_id;
    if (conversionId && ['purchase','generate_lead','sign_up'].includes(event.event)) {
      const key = JSON.stringify([event.property,event.event,conversionId]);
      if (conversions.has(key)) add('duplicate','Duplicate GA4 conversion ID','high',[conversions.get(key),event.id]);
      else conversions.set(key,event.id);
    }
    if (event.event === 'add_to_cart') cartItems.push(...event.items.map(item => item.item_id ?? item.item_name).filter(Boolean));
    if (event.event === 'purchase') {
      if (!params.transaction_id) add('missing_param','Purchase is missing transaction_id','high',ids);
      const total = event.items.reduce((sum,item) => sum + Number(item.price) * Number(item.quantity ?? 1),0);
      if (event.items.length && Number.isFinite(total) &&
          (!Number.isFinite(Number(params.value)) || Math.abs(Number(params.value)-total) > 0.01)) {
        add('wrong_value','Purchase value differs from the item total','high',ids);
      }
      if (cartItems.length && event.items.some(item => !cartItems.includes(item.item_id ?? item.item_name))) {
        add('wrong_value','Purchase contains an item missing from captured cart events','medium',ids);
      }
      cartItems = [];
    }
    if (event.event === 'user_engagement') { heartbeats++; continue; }
    const key = identity({...event,params});
    const previous = recent.get(key);
    if (previous && event.t - previous.t <= 0.5 && !previous.transport.error &&
        !(previous.transport.status >= 400) && !event.transport.error && !(event.transport.status >= 400)) {
      duplicates++;
      continue;
    }
    recent.set(key,event);
    const path = pathPattern(event.page.url);
    if (!pages.includes(path)) pages.push(path);
    minimized.push({
      id:event.id,t:Math.round(event.t*100)/100,vendor:event.vendor,property:event.property,
      event:/^[a-z][a-z_0-9]{0,39}$/i.test(event.event) && redact(event.event) === event.event ? event.event : '[redacted_event]',
      page:pages.indexOf(path),step:event.page.step,params:clean(params),items:event.items.map(clean),
      user:Object.fromEntries(Object.entries(event.user).map(([name,value]) => [name,value ? '[present]' : '[absent]'])),
      consent:{gcs:/^G1[01-]{2}$/.test(event.consent.gcs) ? event.consent.gcs : null,
        gcd:/^1[a-z0-9]{9,20}$/i.test(event.consent.gcd) ? event.consent.gcd : null},
      transport:{status:event.transport.status,failed:Boolean(event.transport.error)}
    });
  }
  const journeyCoverage = coverage(session.journey,events,true,session.markers);
  for (const step of journeyCoverage.filter(step => step.status !== 'pending')) {
    for (const issue of step.issues) add(issue.category,`${step.name}: ${issue.name}`,'high',issue.ids);
  }
  const groups = new Map();
  const evidence = new Set(findings.flatMap(finding => finding.evidence));
  for (const event of minimized) {
    if (evidence.has(event.id)) continue;
    const {id,t,...rest} = event;
    const key = JSON.stringify(rest);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key,group);
  }
  const limit = session.inputBudget ?? 12000;
  const payload = {version:1,plan:session.journey ?? null,pages,events:minimized,
    counts:{captured:events.length,heartbeats,duplicates},client_id_stable:clients.size <= 1,
    journey_coverage:journeyCoverage,findings};
  if (JSON.stringify(payload).length > limit * 3) {
    const collapsed = new Map();
    const omit = new Set();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      collapsed.set(group[0].id,{event:group[0].event,count:group.length,sample:group[0]});
      for (const event of group.slice(1)) omit.add(event.id);
    }
    payload.events = minimized.filter(event => !omit.has(event.id)).map(event => collapsed.get(event.id) ?? event);
  }
  const included = new Set(payload.events.map(event => (event.sample ?? event).id));
  for (const finding of findings) finding.evidence = finding.evidence.filter(id => included.has(id));
  for (const step of journeyCoverage) for (const issue of step.issues) issue.ids = issue.ids.filter(id => included.has(id));
  return payload;
}

function safeDecode(value) {
  try { return decodeURIComponent(value ?? ''); } catch { return value; }
}

export function localReport(payload, status = 'Rules only') {
  const penalty = {critical:25,high:15,medium:8,low:3,info:0};
  return {summary:{score:Math.max(0,100-payload.findings.reduce((sum,finding) => sum + penalty[finding.severity],0)),
    headline:status},journey_coverage:payload.journey_coverage,findings:payload.findings,
    plan:payload.plan,model:null};
}
