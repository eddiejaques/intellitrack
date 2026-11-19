import {manualPlan} from '../extension/src/workflow.js';

function event(index,name,params = {},items = []) {
  return {id:`evt_${index}`,t:index,vendor:'ga4',property:'G-TEST',
    event:name,page:{url:'https://example.test/journey',step:null},params,items,
    user:{client_id:'123.456',user_id:null},consent:{gcs:'G111',gcd:'13l3l3l3l5'},
    transport:{type:'ping',method:'POST',status:204}};
}
const item = {item_id:'SKU',price:12,quantity:2};
function fixture(type,events,faults = []) {
  return {type,context:{domain:'example.test',title:{
    ecommerce:'Shop furniture | cart and checkout',lead_generation:'Request a quote | contact form',
    content:'Daily science news | articles and newsletter'
  }[type],has_forms:type !== 'ecommerce'},session:{journey:manualPlan(type).journeys[0],markers:[]},events,faults};
}

export const fixtures = [
  fixture('ecommerce',[event(1,'view_item'),event(2,'begin_checkout'),
    event(3,'purchase',{transaction_id:'ORDER',value:3,currency:'EUR',email:'pilot@example.test'},[item]),
    event(4,'purchase',{transaction_id:'ORDER',value:3,currency:'EUR'},[item])],
  ['Cart: add_to_cart','GA4 hit contains a sensitive value','Duplicate GA4 conversion ID','Purchase value differs from the item total']),
  fixture('lead_generation',[event(1,'page_view'),event(2,'generate_lead',{email:'sample@example.test'})],
  ['Form start: form_start','GA4 hit contains a sensitive value']),
  fixture('content',[event(1,'page_view'),event(2,'scroll'),event(3,'sign_up')],
  [])
];
