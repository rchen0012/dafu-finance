import {createServer} from 'node:http';
import {readFileSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {createLark} from './lark.mjs';
import {customerFields,customerService,problem,validateCustomer} from './customers.mjs';
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
const lark = mode === 'lark' ? createLark({...env,LARK_ALLOW_CUSTOMER_WRITE:'0'}) : null;
const customerTable = env.LARK_CUSTOMER_TABLE_ID?.trim();
const customerBase = env.LARK_CUSTOMER_BASE_TOKEN?.trim() || env.LARK_BASE_TOKEN;
if (lark && customerTable && customerBase===env.LARK_BASE_TOKEN && customerTable===env.LARK_TABLE_ID) {
  throw Error('顾客表与账单表必须使用不同的数据表');
}
if (lark && customerTable && Boolean(env.LARK_CUSTOMER_APP_ID)!==Boolean(env.LARK_CUSTOMER_APP_SECRET)) {
  throw Error('顾客应用 ID 和 Secret 必须成对填写');
}
const liveCustomers = lark && customerTable ? customerService(createLark({
  ...env,LARK_BASE_TOKEN:customerBase,LARK_TABLE_ID:customerTable,LARK_VIEW_ID:'',
  LARK_APP_ID:env.LARK_CUSTOMER_APP_ID || env.LARK_APP_ID,
  LARK_APP_SECRET:env.LARK_CUSTOMER_APP_SECRET || env.LARK_APP_SECRET,
  LARK_ALLOW_CUSTOMER_WRITE:'1'
}),{...customerFields,...config.customerFields}) : null;
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
function saveState(next) {
  mkdirSync('data',{recursive:true});
  writeFileSync(statePath+'.tmp',JSON.stringify(next,null,2),{mode:0o600});
  renameSync(statePath+'.tmp',statePath);
  state = next;
}

async function bodyJson(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem(403,'请求来源或格式无效');
  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 65536) throw problem(413,'内容过长');
  }
  let input;
  try { input = JSON.parse(body); } catch { throw problem(400,'JSON 格式无效'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem(400,'数据格式无效');
  return input;
}

function localCustomers() {
  return snapshot([],config,state,today(timezone),mode).rules;
}

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
    if (path === '/api/customers' && req.method === 'GET') {
      const rows = liveCustomers ? await liveCustomers.list() : localCustomers();
      return json(res,200,{rows,currency,source:liveCustomers?'lark':mode==='demo'?'demo':'local'});
    }
    if (path === '/api/customers' && ['POST','PUT'].includes(req.method)) {
      const input = await bodyJson(req);
      const update = req.method === 'PUT';
      if (liveCustomers) await liveCustomers.save(input,update);
      else {
        const rows = localCustomers();
        const existing = update ? rows.find(row=>row.id===input.id) : null;
        if (update && !existing) throw problem(404,'顾客不存在，请刷新列表');
        const customer = validateCustomer(input,rows.filter(row=>row!==existing));
        saveState({...state,configured:true,customers:update ? rows.map(row=>row===existing?customer:row) : [...rows,customer]});
      }
      return json(res,update?200:201,{ok:true});
    }
    if (req.method === 'GET' && path === '/api/snapshot') {
      const date = today(timezone);
      const records = lark ? await lark.records(Object.values(config.fields)) : demo(date);
      const customers = liveCustomers ? await liveCustomers.list() : state.customers;
      return json(res,200,{...snapshot(records,config,{...state,customers},date,mode),mode,currency,date,timezone,liveCustomerWrite:!!liveCustomers});
    }
    if (req.method === 'POST' && path === '/api/workflow') {
      const input = await bodyJson(req);
      let next;
      if (input.type === 'customers') {
        if (liveCustomers) throw problem(409,'请在顾客管理中编辑 Lark 顾客');
        if (!Array.isArray(input.customers) || input.customers.length > 1000) return json(res,400,{error:'客户列表格式无效'});
        const customers = [];
        for (const row of input.customers) customers.push(validateCustomer(row,customers));
        next = {...state,customers,configured:true};
      } else if (input.type === 'note') {
        const {customer,owner,feedback,promise} = input;
        if (typeof customer !== 'string' || !customer || typeof owner !== 'string' || !owner.trim() || owner.length > 80 || typeof feedback !== 'string' || !feedback.trim() || feedback.length > 1000 || typeof promise !== 'string' || (promise && !/^\d{4}-\d{2}-\d{2}$/.test(promise))) return json(res,400,{error:'请填写负责人和催款反馈'});
        next = {...state,notes:[{customer,owner:owner.trim(),feedback:feedback.trim(),promise,at:new Date().toISOString()},...state.notes]};
      } else return json(res,400,{error:'未知操作'});
      saveState(next);
      return json(res,200,{ok:true});
    }
    return json(res,404,{error:'页面不存在'});
  } catch (error) {
    if (error.status) return json(res,error.status,{error:error.safe});
    console.error(error.safe || '处理请求失败', error.code || '');
    return json(res,error.safe ? 502 : 500,{error:error.safe || '服务处理失败，请检查本地运行日志和配置'});
  }
});
const port = Number(env.PORT || 3000);
server.listen(port,'127.0.0.1',()=>console.log('DAFU '+mode+' http://127.0.0.1:'+server.address().port));




