import {validate} from './schemas.js';

export const defaults = {
  openai:{base_url:'https://api.openai.com/v1',model:'gpt-4.1-mini'},
  anthropic:{base_url:'https://api.anthropic.com/v1',model:'claude-sonnet-4-6'},
  gemini:{base_url:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-2.5-flash'},
  openai_compatible:{base_url:'http://localhost:11434/v1',model:'qwen2.5-coder'}
};
export function settings(config) {
  if (!Object.hasOwn(defaults,config.provider)) throw new Error('Select a supported provider.');
  const url = new URL(config.base_url);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
    throw new Error('Use an HTTPS endpoint or a local HTTP endpoint, without credentials, query, or fragment.');
  }
  if (!config.model?.trim()) throw new Error('Enter a model.');
  for (const [name,min,max] of [['max_output_tokens',64,32000],['timeout_s',1,120],
    ['max_per_session',1,50],['min_interval_s',0,3600],['input_budget',1000,200000]]) {
    if (!Number.isInteger(config[name]) || config[name] < min || config[name] > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    }
  }
  return {...config,base_url:url.href.replace(/\/+$/,'')};
}

function request(config,system,user,schema) {
  const {provider,model,api_key:key,max_output_tokens:max} = config;
  if (provider === 'anthropic') return ['/messages',{
    'x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'
  },{model,max_tokens:max,system,messages:[{role:'user',content:user}]},
  data => data.content?.filter(part => part.type === 'text').map(part => part.text).join('')];
  if (provider === 'gemini') return [`/models/${encodeURIComponent(model.replace(/^models\//,''))}:generateContent`,
    {'x-goog-api-key':key},{systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:user}]}],
      generationConfig:{maxOutputTokens:max,responseMimeType:'application/json',responseJsonSchema:schema}},
    data => data.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text).join('')];
  const openai = provider === 'openai';
  return ['/chat/completions',key ? {Authorization:`Bearer ${key}`} : {},{
    model,[openai ? 'max_completion_tokens' : 'max_tokens']:max,
    messages:[{role:'system',content:system},{role:'user',content:user}],
    ...(openai ? {response_format:{type:'json_schema',json_schema:{name:'intellitrack',strict:true,schema}}} : {})
  },data => data.choices?.[0]?.message?.content];
}

export async function complete(config,{system,input,schema,check},fetcher = fetch) {
  const validated = settings(config);
  const user = JSON.stringify(input,null,2);
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const [path,headers,body,extract] = request(validated,
      `${system}\nReturn only JSON conforming to this schema: ${JSON.stringify(schema)}`,
      `${user}${feedback}`,schema);
    const response = await fetcher(validated.base_url+path,{
      method:'POST',headers:{'Content-Type':'application/json',...headers},
      body:JSON.stringify(body),redirect:'error',credentials:'omit',
      signal:AbortSignal.timeout(validated.timeout_s*1000)
    });
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
    const data = await response.json();
    try {
      const output = JSON.parse(extract(data));
      validate(output,schema);
      check?.(output);
      return output;
    } catch (error) {
      const reason = error instanceof SyntaxError ? 'The response was not valid JSON.' : error.message;
      if (attempt) throw new Error(`Provider response failed validation after one retry. ${reason}`);
      feedback = `\nCorrect this response validation error: ${reason}`;
    }
  }
}
