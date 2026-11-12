import {createServer} from 'node:http';
import {readFileSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {createLark} from './lark.mjs';
import {snapshot, demo, today} from './finance.mjs';

const env = process.env;
const mode = env.MODE || 'demo';
if (!['demo','lark'].includes(mode)) throw Error('MODE 必须为 demo 或 lark');
if (mode === 'lark' && (!env.DAFU_USER || (env.DAFU_PASSWORD || '').length < 16)) {
  throw Error('Lark 模式需要 DAFU_USER 和至少 16 字符的 DAFU_PASSWORD');
}
const config = JSON.parse(readFileSync('config.json','utf8'));
const currency = env.CURRENCY || 'BRL';
const timezone = env.BUSINESS_TIME_ZONE || 'America/Sao_Paulo';
today(timezone);
new Intl.NumberFormat('zh-CN',{style:'currency',currency});
const lark = mode === 'lark' ? createLark(env) : null;
const statePath = 'data/' + mode + '-workflow.json';
let state;
try { state = JSON.parse(readFileSync(statePath,'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  state = {customers:config.customers,notes:[]};
}

const files = new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']]]);
const json = (res, status, data) => {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(data));
};
const password = env.DAFU_PASSWORD;
const expected = Buffer.from('Basic '+Buffer.from(env.DAFU_USER+':'+password).toString('base64'));

const server = createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (password) {
    const actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) {
      res.setHeader('WWW-Authenticate','Basic realm="DAFU", charset="UTF-8"');
      return json(res,401,{error:'请登录 DAFU'});
    }
  }
  try {
    const path = new URL(req.url,'http://localhost').pathname;
    if (req.method === 'GET' && files.has(path)) {
      const [name,type] = files.get(path);
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});
      return res.end(readFileSync('public/'+name));
    }
    if (req.method === 'GET' && path === '/api/snapshot') {
      const date = today(timezone);
      const records = lark ? await lark.records(Object.values(config.fields)) : demo(date);
      return json(res,200,{...snapshot(records,config,state,date,mode),mode,currency,date,timezone});
    }
    if (req.method === 'POST' && path === '/api/workflow') {
      if (req.headers['sec-fetch-site'] === 'cross-site' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res,403,{error:'请求来源或格式无效'});
      req.setEncoding('utf8');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) return json(res,413,{error:'内容过长'});
      }
      let input;
      try { input = JSON.parse(body); } catch { return json(res,400,{error:'JSON 格式无效'}); }
      if (!input || typeof input !== 'object') return json(res,400,{error:'数据格式无效'});
      let next;
      if (input.type === 'customers') {
        const ids = new Set(), aliases = new Set();
        if (!Array.isArray(input.customers) || input.customers.length > 1000) return json(res,400,{error:'客户列表格式无效'});
        const customers = [];
        for (const c of input.customers) {
          if (!c || typeof c.id !== 'string' || !c.id.trim() || typeof c.name !== 'string' || !c.name.trim() || !['A','B','C','D'].includes(c.grade) || !Number.isFinite(c.limit) || c.limit <= 0 || (c.warning != null && (!Number.isFinite(c.warning) || c.warning <= 0 || c.warning > c.limit)) || !Array.isArray(c.aliases) || !c.aliases.length || c.aliases.some(a=>typeof a !== 'string' || !a.trim())) return json(res,400,{error:'请填写客户编号、名称、等级、正数额度和至少一个门店别名'});
          if (ids.has(c.id.trim()) || c.aliases.some(a=>aliases.has(a.trim())) || new Set(c.aliases.map(a=>a.trim())).size !== c.aliases.length) return json(res,400,{error:'客户编号和门店别名必须唯一'});
          ids.add(c.id.trim());
          c.aliases.forEach(a=>aliases.add(a.trim()));
          customers.push({id:c.id.trim(),name:c.name.trim(),grade:c.grade,limit:c.limit,warning:c.warning ?? null,aliases:c.aliases.map(a=>a.trim())});
        }
        next = {...state,customers,configured:true};
      } else if (input.type === 'note') {
        const {customer,owner,feedback,promise} = input;
        if (typeof customer !== 'string' || !customer || typeof owner !== 'string' || !owner.trim() || owner.length > 80 || typeof feedback !== 'string' || !feedback.trim() || feedback.length > 1000 || typeof promise !== 'string' || (promise && !/^\d{4}-\d{2}-\d{2}$/.test(promise))) return json(res,400,{error:'请填写负责人和催款反馈'});
        next = {...state,notes:[{customer,owner:owner.trim(),feedback:feedback.trim(),promise,at:new Date().toISOString()},...state.notes]};
      } else return json(res,400,{error:'未知操作'});
      mkdirSync('data',{recursive:true});
      writeFileSync(statePath+'.tmp',JSON.stringify(next,null,2),{mode:0o600});
      renameSync(statePath+'.tmp',statePath);
      state = next;
      return json(res,200,{ok:true});
    }
    return json(res,404,{error:'页面不存在'});
  } catch (error) {
    console.error(error.safe || '处理请求失败', error.code || '');
    return json(res,error.safe ? 502 : 500,{error:error.safe || '服务处理失败，请检查本地运行日志和配置'});
  }
});
const port = Number(env.PORT || 3000);
server.listen(port,'127.0.0.1',()=>console.log('DAFU '+mode+' http://127.0.0.1:'+server.address().port));


