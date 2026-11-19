import {settings,defaults} from './llm.js';
import {app,element,button,send,status} from './ui.js';
const {llm} = await chrome.storage.local.get('llm');
const initial = llm ?? {provider:'openai',...defaults.openai,api_key:'',max_output_tokens:4000,
  timeout_s:120,max_per_session:5,min_interval_s:30,input_budget:12000};

app.append(element('h1','Provider settings'),element('p',
  'API keys are stored unencrypted in this browser. Use a dedicated key with a spending cap.'));
const fields = {provider:element('select')};
for (const [value,name] of Object.entries({openai:'OpenAI',anthropic:'Anthropic',gemini:'Gemini',openai_compatible:'OpenAI-compatible'})) {
  const option = element('option',name);
  option.value = value;
  fields.provider.append(option);
}
const labels = {provider:'Provider',base_url:'Base URL',model:'Model',api_key:'API key',
  max_output_tokens:'Maximum output tokens',timeout_s:'Timeout in seconds',max_per_session:'Planning calls per session',
  min_interval_s:'Seconds between planning calls',input_budget:'Approximate input token budget'};
for (const [key,name] of Object.entries(labels)) {
  const label = element('label',name);
  const field = fields[key] ??= element('input');
  if (field.tagName === 'INPUT') field.type = typeof initial[key] === 'number' ? 'number' : key === 'api_key' ? 'password' : 'text';
  field.value = initial[key];
  label.append(field);
  app.append(label);
}
fields.provider.onchange = () => {
  Object.assign(fields.base_url,{value:defaults[fields.provider.value].base_url});
  Object.assign(fields.model,{value:defaults[fields.provider.value].model});
  fields.api_key.value = '';
};

app.append(button('Save',async () => {
  const data = Object.fromEntries(Object.entries(fields).map(([key,field]) => [
    key,field.type === 'number' ? field.valueAsNumber : field.value.trim()
  ]));
  const llm = settings(data);
  const url = new URL(llm.base_url);
  // Chrome host match patterns do not include ports.
  const pattern = `${url.protocol}//${url.hostname}/*`;
  if (!await chrome.permissions.request({origins:[pattern]})) throw new Error('Endpoint permission was declined.');
  await chrome.storage.local.set({llm});
  status('Settings saved.');
}),button('Test saved connection',async () => {
  await send('test');
  status('Connection successful.');
}),element('h2','Site planning consent'));
const list = element('ul');
app.append(list);
async function showConsent() {
  const {consent = {}} = await chrome.storage.local.get('consent');
  list.replaceChildren();
  for (const [site,choice] of Object.entries(consent)) {
    const row = element('li',`${site} · ${choice} `);
    row.append(button('Reset',async () => {
      const {consent = {}} = await chrome.storage.local.get('consent');
      delete consent[site];
      await chrome.storage.local.set({consent});
      await showConsent();
    }));
    list.append(row);
  }
}
await showConsent();
