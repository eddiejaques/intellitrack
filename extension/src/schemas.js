const string = {type:'string',maxLength:2000};
const id = {type:'string',pattern:'^[A-Za-z][A-Za-z0-9_-]{0,39}$'};
const names = {type:'string',pattern:'^[a-z][a-z0-9_]{0,39}$'};
const array = (items,maxItems = 30) => ({type:'array',items,maxItems});
const choice = (...values) => ({type:'string',enum:values});
const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const siteTypes = ['ecommerce','lead_generation','content','other'];
const expectation = object({vendor:choice('ga4'),event:names,params:array(names,12)});
const step = object({id,name:string,page_hint:string,expect:{...array(expectation,10),minItems:1}});
const journey = object({id,name:string,steps:{...array(step,15),minItems:1}});
export const planSchema = object({
  site_type:choice(...siteTypes),confidence:{type:'number',minimum:0,maximum:1},rationale:string,
  journeys:{...array(journey,5),minItems:1},global_expectations:array(string)
});
export const auditSchema = object({
  summary:object({score:{type:'integer',minimum:0,maximum:100},headline:string}),
  findings:array(object({id,severity:choice('critical','high','medium','low','info'),
    vendor:choice('ga4'),category:choice('missing_event','missing_param','wrong_value','duplicate','consent','pii','naming'),
    title:string,detail:string,evidence:{...array(string,20),minItems:1},recommendation:string}),50)
});
export const connectionSchema = object({status:choice('ok')});

export function validate(value,schema,path = '$') {
  const validType = {
    object:() => value !== null && typeof value === 'object' && !Array.isArray(value),
    array:() => Array.isArray(value),
    string:() => typeof value === 'string',
    number:() => Number.isFinite(value),
    integer:() => Number.isInteger(value)
  };
  if (!validType[schema.type]?.()) throw new Error(`${path} must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} has an invalid enum value`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} has an invalid format`);
  if (value < schema.minimum || value > schema.maximum || value.length > schema.maxLength) {
    throw new Error(`${path} is outside its allowed bounds`);
  }
  if (schema.type === 'array') {
    if (value.length > schema.maxItems || value.length < schema.minItems) throw new Error(`${path} has an invalid item count`);
    for (const [index,item] of value.entries()) validate(item,schema.items,`${path}[${index}]`);
  }
  if (schema.type === 'object') {
    for (const key of schema.required) {
      if (!Object.hasOwn(value,key)) throw new Error(`${path}.${key} is required`);
      validate(value[key],schema.properties[key],`${path}.${key}`);
    }
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties,key))) throw new Error(`${path} contains unexpected fields`);
  }
}
