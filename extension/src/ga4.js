const itemKeys = {id:'item_id',nm:'item_name',br:'item_brand',ca:'item_category',
  va:'item_variant',pr:'price',qt:'quantity',ds:'discount',li:'item_list_id',ln:'item_list_name'};

function parseItem(value) {
  return Object.fromEntries(value.split('~').filter(part => part.length > 2).map(part => {
    const key = itemKeys[part.slice(0, 2)] ?? part.slice(0, 2);
    const raw = part.slice(2);
    return [key, ['price','quantity','discount'].includes(key) && Number.isFinite(Number(raw)) ? Number(raw) : raw];
  }));
}

export const ga4 = {
  id:'ga4', label:'Google Analytics 4',kind:'analytics',piiPolicy:'never',
  match({url}) {
    const {pathname,searchParams} = new URL(url);
    return pathname.endsWith('/g/collect') && searchParams.get('v') === '2' &&
      /^G-[A-Z0-9]+$/i.test(searchParams.get('tid') ?? '');
  },
  parse(request, session) {
    const query = new URL(request.url).searchParams;
    const chunks = (request.requestBody?.raw ?? []).map(({bytes}) => bytes && new Uint8Array(bytes)).filter(Boolean);
    const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const body = new TextDecoder().decode(bytes);
    return (body.trim() ? body.trim().split(/\r?\n/) : ['']).flatMap((line, index) => {
      const fields = new Map([...query, ...new URLSearchParams(line)]);
      if (!fields.get('en')) return [];
      const params = {};
      const items = [];
      for (const [key,value] of fields) {
        if (key.startsWith('ep.')) Object.defineProperty(params,key.slice(3),{value,enumerable:true,configurable:true});
        if (key.startsWith('epn.')) Object.defineProperty(params,key.slice(4),{
          value: value.trim() && Number.isFinite(Number(value)) ? Number(value) : value,enumerable:true,configurable:true
        });
        if (/^pr\d+$/.test(key)) items.push(parseItem(value));
      }
      return [{
        id:`evt_${request.requestId}_${index}`, sessionId:session.id,
        t:(request.timeStamp - session.startedAt)/1000,
        vendor:'ga4', property:fields.get('tid'), event:fields.get('en'),
        page:{url:fields.get('dl'),title:fields.get('dt'),step:session.step},
        params, items, user:{client_id:fields.get('cid'),user_id:fields.get('uid')},
        consent:{gcs:fields.get('gcs'),gcd:fields.get('gcd')},
        transport:{type:request.type,method:request.method},raw_ref:request.requestId
      }];
    });
  }
};
