export function createLark(env, request = fetch) {
  for (const key of ['LARK_APP_ID','LARK_APP_SECRET','LARK_BASE_TOKEN','LARK_TABLE_ID']) {
    if (!env[key]) throw Error('缺少 '+key);
  }
  const region = env.LARK_REGION || 'lark';
  if (!['lark','feishu'].includes(region)) throw Error('LARK_REGION 必须为 lark 或 feishu');
  const host = region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const table = '/open-apis/bitable/v1/apps/'+encodeURIComponent(env.LARK_BASE_TOKEN)+'/tables/'+encodeURIComponent(env.LARK_TABLE_ID);
  let cached, pending;
  const fail = (message,code) => Object.assign(new Error(message),{safe:message,code});

  async function api(path, options = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response, result;
      try {
        response = await request(host+path,{...options,signal:AbortSignal.timeout(12000),redirect:'error'});
        result = await response.json().catch(()=>null);
      } catch {
        if (attempt === 2) throw fail('无法连接 Lark，请检查服务器网络后重试');
      }
      if (response?.ok && result?.code === 0) return result;
      const code = Number(result?.code) || response?.status;
      if ([401,99991663,99991664,99991668].includes(code)) throw fail('Lark 凭证失效，请检查应用配置',401);
      if (response && response.status !== 429 && response.status < 500 && ![99991400,1254290].includes(code)) {
        throw fail('Lark 请求失败（'+(code || '响应格式错误')+'）。请检查应用只读权限、Base 协作权限和表格配置',code);
      }
      if (attempt < 2) await new Promise(resolve=>setTimeout(resolve,350*2**attempt));
    }
    throw fail('Lark 暂时无法读取，请稍后重试');
  }

  async function token() {
    if (cached?.until > Date.now()) return cached.value;
    pending ||= api('/open-apis/auth/v3/tenant_access_token/internal',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({app_id:env.LARK_APP_ID,app_secret:env.LARK_APP_SECRET})
    }).then(result=>{
      if (!result.tenant_access_token || !result.expire) throw fail('Lark 未返回有效凭证');
      cached = {value:result.tenant_access_token,until:Date.now()+Math.max(0,result.expire-60)*1000};
      return cached.value;
    }).finally(()=>{pending = undefined;});
    return pending;
  }

  async function read(path) {
    const first = await token();
    const call = value=>api(path,{headers:{Authorization:'Bearer '+value}});
    try { return await call(first); }
    catch (error) {
      if (error.code !== 401) throw error;
      if (cached?.value === first) cached = undefined;
      return call(await token());
    }
  }

  async function pages(path, options) {
    const query = new URLSearchParams({page_size:'100',...options});
    const items = [], seen = new Set();
    while (true) {
      const {data} = await read(path+'?'+query);
      if (!data || !Array.isArray(data.items ?? []) || typeof data.has_more !== 'boolean') throw fail('Lark 分页响应格式异常');
      items.push(...(data.items ?? []));
      if (!data.has_more) return items;
      if (!data.page_token || seen.has(data.page_token)) throw fail('Lark 分页游标异常');
      seen.add(data.page_token);
      query.set('page_token',data.page_token);
    }
  }

  let schema;
  return {async records(fields) {
    const requested = [...new Set(fields.filter(Boolean))];
    if (!schema || schema.until < Date.now()) {
      const names = (await pages(table+'/fields')).map(field=>field.field_name);
      const stripSpaces = name=>name.replace(/\s+/g,'');
      const mapping = requested.map(name=>{
        if (names.includes(name)) return [name,name];
        const matches = names.filter(actual=>stripSpaces(actual)===stripSpaces(name));
        return [name,matches.length===1 ? matches[0] : null];
      });
      const missing = mapping.filter(([,actual])=>!actual).map(([name])=>name);
      if (missing.length) throw fail('Lark 缺少映射字段：'+missing.join('、')+'。请核对 config.json');
      schema = {mapping,until:Date.now()+300000};
    }
    const {mapping} = schema;
    const items = await pages(table+'/records',{
      field_names:JSON.stringify([...new Set(mapping.map(([,actual])=>actual))]),
      ...(env.LARK_VIEW_ID ? {view_id:env.LARK_VIEW_ID} : {})
    });
    return items.map(item=>({
      record_id:item.record_id,
      fields:Object.fromEntries(mapping.map(([name,actual])=>[name,item.fields?.[actual]]))
    }));
  }};
}


