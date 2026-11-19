import {app,element,button,send,status} from './ui.js';

app.dataset.popup = '';
const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
let planning = false;
const call = (type,fields) => send(type,fields).then(refresh);
function render(state) {
  const {session,destination,site,preference} = state;
  const settings = button('Settings',() => chrome.runtime.openOptionsPage());
  app.replaceChildren(element('h1','IntelliTrack'),settings);
  if (!session) {
    app.append(button('Start',() => call('start',{tabId:tab.id})));
    if (state.latest) app.append(button('Latest report',() => chrome.tabs.create({url:state.latest})));
    return;
  }
  app.append(button('Stop',async () => {
    const url = await send('stop');
    await chrome.tabs.create({url});
    window.close();
  }));
  const counters = element('p');
  counters.id = 'count';
  app.append(counters);
  if (session.tabId !== tab.id) {
    app.append(element('p','Recording another tab. Switch to that tab to manage the journey.'));
    return;
  }
  const planner = element('fieldset');
  planner.append(element('legend',session.proposed ? 'Re-plan journey' : 'Plan journey'));
  if (destination && site) {
    const {endpoint,provider,model} = destination;
    planner.append(element('p',`Page context from ${site} will go to ${provider} (${model}) at ${endpoint}.`));
    const plan = consent => async () => {
      if (planning) return;
      planning = true;
      status('Planning journey…');
      try { await send('plan',{consent,site,destination}); status(''); await refresh(true); }
      finally { planning = false; }
    };
    if (preference === 'always') planner.append(button(session.proposed ? 'Re-plan' : 'Generate plan',plan(undefined)));
    else if (preference !== 'never') {
      planner.append(button('Always for this site',plan('always')),button('Ask each time · send now',plan('ask')));
    } else planner.append(button('Ask each time · send now',plan('ask')));
  }
  const select = element('select');
  select.setAttribute('aria-label','Manual site type');
  for (const [value,label] of Object.entries({ecommerce:'E-commerce',lead_generation:'Lead generation',content:'Content',other:'Other'})) {
    const option = element('option',label);
    option.value = value;
    select.append(option);
  }
  planner.append(select,button('Use manual plan',() => call('manual',{siteType:select.value})),
    button('Never send page context',() => call('manual',{siteType:select.value,never:true})));
  app.append(planner);
  for (const journey of session.proposed?.journeys ?? []) {
    const panel = element('fieldset');
    panel.append(element('legend',journey.name));
    const choices = journey.steps.map(step => {
      const label = element('label');
      const input = element('input');
      input.type = 'checkbox';
      input.value = step.id;
      input.checked = session.journey?.id !== journey.id || session.journey.steps.some(selected => selected.id === step.id);
      label.append(input,document.createTextNode(` ${step.name}`));
      panel.append(label);
      return input;
    });
    panel.append(button('Use this journey',() => call('select',{
      journeyId:journey.id,steps:choices.filter(input => input.checked).map(input => input.value)
    })));
    app.append(panel);
  }
  if (session.journey) {
    app.append(element('h2','Live checklist'));
    for (const step of session.journey.steps) {
      const row = element('p');
      const output = element('span');
      output.id = `check-${step.id}`;
      row.append(output,document.createTextNode(' '),button('Mark step',() => call('mark',{step:step.id})));
      app.append(row);
    }
  }
}

let lastLayout = '';
async function refresh(force = false) {
  const state = await send('state',{url:tab?.url});
  const key = JSON.stringify([state.session?.id,state.session?.journey,state.session?.proposed,state.session?.step,
    state.latest,state.preference,state.destination]);
  if (force === true || key !== lastLayout) {
    render(state);
    lastLayout = key;
  }
  const count = document.querySelector('#count');
  if (count) count.textContent = `${state.count} GA4 events captured`;
  for (const step of state.coverage ?? []) {
    const output = document.getElementById(`check-${step.step}`);
    if (output) output.textContent = `${step.name} · ${step.status === 'missing' ? 'waiting' : step.status}${state.session.step === step.step ? ' · current' : ''}`;
  }
}
await refresh().catch(error => status(error.message));
setInterval(() => refresh().catch(error => status(error.message)),1000);
