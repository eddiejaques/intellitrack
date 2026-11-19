import {ga4} from './ga4.js';
import {putSession,getSession,listEvents,addEvents,updateTransport,purge} from './store.js';
import {coverage,makePayload,localReport,pathPattern,redact} from './audit.js';
import {complete} from './llm.js';
import {connectionSchema,siteTypes} from './schemas.js';
import {manualPlan,planJourney,reviewAudit} from './workflow.js';
import {extractPage} from './context.js';

let pending = Promise.resolve();
function serial(run) {
  const next = pending.then(run);
  pending = next.catch(() => {});
  return next;
}
const active = async () => (await chrome.storage.session.get('recording')).recording;
const config = async () => (await chrome.storage.local.get('llm')).llm;
const origin = value => {
  try { return new URL(value).origin; } catch { return ''; }
};
const destination = llm => llm && {provider:llm.provider,endpoint:llm.base_url,model:llm.model};
function reportUrl(id) {
  return chrome.runtime.getURL(`report.html?id=${encodeURIComponent(id)}`);
}

const requests = {urls:['*://*/*g/collect*']};
chrome.webRequest.onBeforeRequest.addListener(request => {
  if (!ga4.match(request)) return;
  serial(async () => {
    const session = await active();
    if (!session || request.timeStamp < session.startedAt) return;
    if (request.tabId !== session.tabId &&
        !(request.tabId === -1 && request.initiator === session.origin)) return;
    await addEvents(ga4.parse(request,session));
  }).catch(console.error);
},requests,['requestBody']);

function finish(request,transport) {
  serial(async () => {
    const session = await active();
    const sessionId = session?.id ?? (await chrome.storage.session.get('latest')).latest;
    if (sessionId) await updateTransport(sessionId,request.requestId,transport);
  }).catch(console.error);
}
chrome.webRequest.onCompleted.addListener(request => finish(request,{status:request.statusCode}),requests);
chrome.webRequest.onErrorOccurred.addListener(request => finish(request,{error:request.error}),requests);
chrome.tabs.onUpdated.addListener((tabId,change) => {
  if (!change.url) return;
  serial(async () => {
    const session = await active();
    if (session?.tabId !== tabId) return;
    await chrome.storage.session.set({recording:{...session,origin:origin(change.url)}});
  }).catch(console.error);
});
chrome.tabs.onRemoved.addListener(tabId => {
  serial(async () => {
    const session = await active();
    if (session?.tabId === tabId) await stop(session);
  }).catch(console.error);
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'retention') serial(() => purge(Date.now()-30*86400000)).catch(console.error);
});
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('retention',{periodInMinutes:1440}));

async function currentSession() {
  const recording = await active();
  if (!recording) throw new Error('Start a recording first.');
  const session = await getSession(recording.id);
  if (!session) throw new Error('Recording expired.');
  return {...session,...recording};
}

async function stop(session) {
  const record = await getSession(session.id);
  await putSession({...record,...session,stoppedAt:Date.now()});
  await chrome.storage.session.set({latest:session.id});
  await chrome.storage.session.remove('recording');
  return reportUrl(session.id);
}

async function plan(message) {
  const job = await serial(async () => {
    const session = await currentSession();
    const tab = await chrome.tabs.get(session.tabId);
    const site = origin(tab.url);
    if (message.site !== site) throw new Error('The page changed. Reopen the popup to approve the current site.');
    const preferences = (await chrome.storage.local.get('consent')).consent ?? {};
    const preference = message.consent ?? preferences[site];
    if (!['always','ask'].includes(preference) || (preference === 'ask' && message.consent !== 'ask')) {
      throw new Error('Approve this planning call or choose a manual site type.');
    }
    const llm = await config();
    if (!llm) throw new Error('Configure a provider in Settings first.');
    if (JSON.stringify(message.destination) !== JSON.stringify(destination(llm))) {
      throw new Error('The provider changed. Reopen the popup to approve the new destination.');
    }
    if (session.planCalls >= llm.max_per_session) throw new Error('Planning call budget reached.');
    if (Date.now() - (session.lastPlanAt ?? 0) < llm.min_interval_s*1000) {
      throw new Error('Wait for the configured interval before re-planning.');
    }
    const [{result:page}] = await chrome.scripting.executeScript({
      target:{tabId:session.tabId},func:extractPage
    });
    if (origin(page.url) !== site) throw new Error('The page changed before context was collected.');
    const {url,...context} = page;
    const properties = [...new Set((await listEvents(session.id)).map(event => event.property))];
    await chrome.storage.local.set({consent:{...preferences,[site]:preference}});
    const started = Date.now();
    await putSession({...session,planCalls:session.planCalls+1,lastPlanAt:started});
    return {id:session.id,started,llm,context:{...context,domain:new URL(url).hostname,
      path:pathPattern(url),vendors:properties.length ? [{id:'ga4',properties}] : []}};
  });
  const proposed = await planJourney(job.llm,job.context);
  for (const journey of proposed.journeys) {
    journey.name = redact(journey.name);
    for (const step of journey.steps) {
      step.name = redact(step.name);
      step.page_hint = pathPattern(new URL(step.page_hint.startsWith('/') ? step.page_hint : '/', 'https://example.invalid').href);
    }
  }
  await serial(async () => {
    const session = await getSession(job.id);
    if (!session || session.stoppedAt) throw new Error('The recording has ended.');
    if (session.lastPlanAt !== job.started) throw new Error('A newer planning action replaced this request.');
    await putSession({...session,proposed});
  });
  return proposed;
}

async function confirmAudit(message) {
  const job = await serial(async () => {
    const session = await getSession(message.id);
    const llm = await config();
    if (!session?.preview || session.preview.token !== message.token) throw new Error('Refresh the preview before sending.');
    if (!llm || JSON.stringify(destination(llm)) !== JSON.stringify(session.preview.destination)) {
      throw new Error('Provider settings changed. Refresh the preview before sending.');
    }
    const payload = session.preview.payload;
    if (JSON.stringify(payload,null,2).length > llm.input_budget*3) {
      throw new Error('The preview exceeds the input budget. Raise it in Settings or use the local report.');
    }
    await putSession({...session,preview:null});
    return {llm,payload};
  });
  let report;
  try {
    report = await reviewAudit(job.llm,job.payload);
  } catch (error) {
    report = {...localReport(job.payload,'LLM review failed'),error:error.message};
  }
  await serial(async () => {
    const session = await getSession(message.id);
    await putSession({...session,report});
  });
  return report;
}

async function handle(message) {
  switch (message.type) {
    case 'start': {
      if (await active()) throw new Error('A tab is already recording.');
      const tab = await chrome.tabs.get(message.tabId);
      if (!/^https?:/.test(tab.url ?? '')) throw new Error('Open an HTTP or HTTPS website first.');
      const session = {id:crypto.randomUUID(),tabId:tab.id,origin:origin(tab.url),
        startedAt:Date.now(),step:null,markers:[],planCalls:0};
      await putSession(session);
      await chrome.storage.session.set({recording:{
        id:session.id,tabId:session.tabId,origin:session.origin,startedAt:session.startedAt,step:null
      }});
      return session;
    }
    case 'state': {
      const recording = await active();
      const llm = await config();
      const site = recording?.origin;
      const preference = (await chrome.storage.local.get('consent')).consent?.[site];
      if (!recording) {
        const id = (await chrome.storage.session.get('latest')).latest;
        return {latest:id && reportUrl(id)};
      }
      const session = await currentSession();
      const events = await listEvents(session.id);
      return {session,count:events.length,coverage:coverage(session.journey,events.sort((a,b) => a.t-b.t)),
        preference,site,destination:destination(llm)};
    }
    case 'stop': return stop(await currentSession());
    case 'manual': {
      if (!siteTypes.includes(message.siteType)) throw new Error('Unknown site type.');
      const session = await currentSession();
      const proposed = manualPlan(message.siteType);
      if (message.never) {
        const tab = await chrome.tabs.get(session.tabId);
        const {consent = {}} = await chrome.storage.local.get('consent');
        await chrome.storage.local.set({consent:{...consent,[origin(tab.url)]:'never'}});
      }
      await putSession({...session,proposed});
      return proposed;
    }
    case 'select': {
      const session = await currentSession();
      const selected = session.proposed?.journeys.find(journey => journey.id === message.journeyId);
      const steps = selected?.steps.filter(step => message.steps.includes(step.id));
      if (!steps?.length) throw new Error('Select at least one step.');
      await putSession({...session,journey:{...selected,steps},markers:[],step:null,
        siteType:session.proposed.site_type});
      await chrome.storage.session.set({recording:{...(await active()),step:null}});
      return true;
    }
    case 'mark': {
      const session = await currentSession();
      if (!session.journey?.steps.some(step => step.id === message.step)) throw new Error('Choose a valid step.');
      await putSession({...session,markers:[...new Set([...session.markers,message.step])]});
      await chrome.storage.session.set({recording:{...(await active()),step:message.step}});
      return true;
    }
    case 'preview': {
      const session = await getSession(message.id);
      if (!session?.stoppedAt) throw new Error('Stop this recording before opening its report.');
      const llm = await config();
      const raw = await listEvents(session.id);
      const payload = makePayload({...session,inputBudget:llm?.input_budget},raw);
      const preview = {token:crypto.randomUUID(),destination:destination(llm),payload};
      if (payload.plan) payload.site_type = session.siteType;
      await putSession({...session,preview});
      return {...preview,raw,report:session.report ?? localReport(payload)};
    }
    default: throw new Error('Unknown request.');
  }
}

chrome.runtime.onMessage.addListener((message,sender,reply) => {
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  const task = message.type === 'plan' ? plan(message) :
    message.type === 'audit' ? confirmAudit(message) :
    message.type === 'test' ? config().then(llm => {
      if (!llm) throw new Error('Save your settings first.');
      return complete(llm,{system:'Return a connection acknowledgement.',input:{},schema:connectionSchema});
    }) : serial(() => handle(message));
  task.then(value => reply({value}),error => reply({error:error.message}));
  return true;
});
