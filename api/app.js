const crypto=require('crypto');
const U=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_KEY;
async function db(path,o={}){
  const r=await fetch(U+'/rest/v1/'+path,{method:o.method||'GET',headers:Object.assign({apikey:K,'Content-Type':'application/json',Prefer:o.prefer||'return=representation'},String(K).startsWith('eyJ')?{Authorization:'Bearer '+K}:{}),body:o.body?JSON.stringify(o.body):undefined});
  const t=await r.text();let j=null;try{j=t?JSON.parse(t):null}catch(e){j=t}
  if(!r.ok){const e=new Error('db');e.status=r.status;throw e}
  return j;
}
const normPhone=p=>{let d=String(p||'').replace(/\D/g,'');if(d.startsWith('00257'))d=d.slice(5);else if(d.startsWith('257')&&d.length>8)d=d.slice(3);return /^\d{8}$/.test(d)?d:null};
const hash=(c,p)=>crypto.createHash('sha256').update(c+':'+p).digest('hex');
const newCode=()=>{const a='ABCDEFGHJKMNPQRSTUVWXYZ23456789';let c='';for(let i=0;i<8;i++)c+=a[crypto.randomInt(a.length)];return c};
const same=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const audit=(action,detail)=>db('audit',{method:'POST',body:{action,detail},prefer:'return=minimal'}).catch(()=>{});
const config=async()=>(await db('config?id=eq.1'))[0];
const send=(res,s,b)=>{res.setHeader('Cache-Control','no-store');res.status(s).json(b)};
async function results(){const o={};(await db('results?validated=eq.true')).forEach(r=>o[r.key]=r.value);return o}
// Classement : points, puis score exact, champion, pronostic de finale le plus tôt, plus petit n° d'inscription.
function ranking(parts,preds,R,cfg){
  if(cfg.cancelled)return [];
  const by={};preds.forEach(p=>{(by[p.participant_id]=by[p.participant_id]||{})[p.stage]=p});
  const rows=[];
  for(const q of parts){
    const s=by[q.id]||{};if(!s[1]||!s[2])continue;
    const a=s[1],f=s[2];
    const p1=R.sf1&&R.sf1!=='X'&&a.sf1===R.sf1?2:0,p2=R.sf2&&R.sf2!=='X'&&a.sf2===R.sf2?2:0;
    const ex=R.final&&(f.home+'-'+f.away)===R.final?6:0,ch=R.champion&&f.champion===R.champion?3:0;
    const pts=p1+p2+ex+ch;if(pts<1)continue;
    rows.push({id:q.id,name:q.name,phone:q.phone,pub:q.consent_publish,pts,ex:ex>0?1:0,ch:ch>0?1:0,t:f.created_at});
  }
  rows.sort((x,y)=>y.pts-x.pts||y.ex-x.ex||y.ch-x.ch||(new Date(x.t)-new Date(y.t))||x.id-y.id);
  return rows.map((r,i)=>Object.assign({},r,{rank:i+1,prize:['6,5 Go','5 Go','3 Go'][i]||null}));
}
const L={db,normPhone,hash,newCode,same,audit,config,send,results,ranking};

const H={};
H.config=async(req,res)=>{try{const c=await L.config();delete c.id;L.send(res,200,Object.assign(c,{now:new Date().toISOString()}))}catch(e){L.send(res,500,{error:'Erreur serveur.'})}};

H.register=async(req,res)=>{
  if(req.method!=='POST')return L.send(res,405,{error:'POST requis.'});
  try{
    const b=req.body||{},c=await L.config(),ok=v=>['1','N','2'].includes(v);
    if(c.state!=='open'||Date.now()>=new Date(c.s1_close).getTime())return L.send(res,403,{error:'Les inscriptions sont fermées.'});
    const phone=L.normPhone(b.phone),name=String(b.name||'').trim().slice(0,40);
    if(!phone||name.length<2||b.accept!==true||!ok(b.sf1)||!ok(b.sf2))return L.send(res,400,{error:'Données invalides.'});
    const code=L.newCode();let p;
    try{p=(await L.db('participants',{method:'POST',body:{name,phone,code_hash:L.hash(code,phone),consent_publish:b.publish===true,is_test:c.test_mode}}))[0]}
    catch(e){if(e.status===409)return L.send(res,409,{error:'Ce numéro est déjà inscrit.'});throw e}
    await L.db('predictions',{method:'POST',body:{participant_id:p.id,stage:1,sf1:b.sf1,sf2:b.sf2},prefer:'return=minimal'});
    L.audit('register',{id:p.id});
    L.send(res,200,{id:p.id,code});
  }catch(e){L.send(res,500,{error:'Erreur serveur.'})}
};

H.final=async(req,res)=>{
  if(req.method!=='POST')return L.send(res,405,{error:'POST requis.'});
  try{
    const b=req.body||{},c=await L.config();
    if(c.state!=='final_open'||!c.final_close||Date.now()>=new Date(c.final_close).getTime())return L.send(res,403,{error:'Les pronostics de finale sont fermés.'});
    const phone=L.normPhone(b.phone),h=Number(b.home),a=Number(b.away);
    if(!phone||!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0||h>30||a>30||!['A','B'].includes(b.champion))return L.send(res,400,{error:'Données invalides.'});
    const p=(await L.db('participants?phone=eq.'+phone+'&is_test=eq.'+c.test_mode))[0];
    if(!p||!L.same(p.code_hash,L.hash(String(b.code||'').trim().toUpperCase(),phone)))return L.send(res,401,{error:'Numéro ou code incorrect.'});
    if(!(await L.db('predictions?participant_id=eq.'+p.id+'&stage=eq.1')).length)return L.send(res,403,{error:'Étape 1 non effectuée.'});
    try{await L.db('predictions',{method:'POST',body:{participant_id:p.id,stage:2,home:h,away:a,champion:b.champion},prefer:'return=minimal'})}
    catch(e){if(e.status===409)return L.send(res,409,{error:'Pronostic de finale déjà envoyé.'});throw e}
    L.audit('final',{id:p.id});L.send(res,200,{ok:true});
  }catch(e){L.send(res,500,{error:'Erreur serveur.'})}
};

H.ranking=async(req,res)=>{
  try{
    const c=await L.config();if(c.ranking==='none')return L.send(res,200,{status:'none',rows:[]});
    const t='is_test=eq.'+c.test_mode;
    const [parts,preds,R]=await Promise.all([L.db('participants?'+t+'&select=id,name,phone,consent_publish'),L.db('predictions?select=*'),L.results()]);
    const rows=L.ranking(parts,preds,R,c).map(r=>({rank:r.rank,label:r.pub?r.name:'Participant n°'+r.id,pts:r.pts,prize:r.prize}));
    L.send(res,200,{status:c.ranking,cancelled:c.cancelled,rows});
  }catch(e){L.send(res,500,{error:'Erreur serveur.'})}
};

const KEYS=['state','s1_close','final_kickoff','final_close','finalist_a','finalist_b','ranking','cancelled','test_mode'];
const STATES=['preparation','open','s1_closed','waiting_finalists','final_open','final_closed'];
H.admin=async(req,res)=>{
  const S=process.env.ADMIN_SECRET||'';
  if(S.length<16||!L.same((req.headers.authorization||'').replace('Bearer ',''),S))return L.send(res,401,{error:'Non autorisé.'});
  try{
    const b=req.body||{},c=await L.config();
    if(b.action==='stats'){
      const p=await L.db('participants?select=id,is_test'),s2=await L.db('predictions?stage=eq.2&select=participant_id');
      return L.send(res,200,{participants:p.length,tests:p.filter(x=>x.is_test).length,final_predictions:s2.length,config:c});
    }
    if(b.action==='config'){
      const set={};for(const k of KEYS)if(k in(b.set||{}))set[k]=b.set[k];
      if(set.state&&!STATES.includes(set.state))return L.send(res,400,{error:'État inconnu.'});
      if(set.ranking&&!['none','provisional','final'].includes(set.ranking))return L.send(res,400,{error:'Valeur inconnue.'});
      await L.db('config?id=eq.1',{method:'PATCH',body:set,prefer:'return=minimal'});L.audit('config',set);return L.send(res,200,{ok:true});
    }
    if(b.action==='result'){
      await L.db('results?on_conflict=key',{method:'POST',body:{key:b.key,value:String(b.value),validated:b.validated===true,updated_at:new Date().toISOString()},prefer:'resolution=merge-duplicates,return=minimal'});
      L.audit('result',{key:b.key,value:b.value,validated:b.validated===true});return L.send(res,200,{ok:true});
    }
    if(b.action==='ranking'){
      const [parts,preds,R]=await Promise.all([L.db('participants?is_test=eq.'+c.test_mode+'&select=id,name,phone,consent_publish'),L.db('predictions?select=*'),L.results()]);
      return L.send(res,200,{results:R,rows:L.ranking(parts,preds,R,c)});
    }
    if(b.action==='export'){
      L.audit('export',{});
      return L.send(res,200,{participants:await L.db('participants?select=id,name,phone,consent_publish,is_test,created_at'),predictions:await L.db('predictions?select=*'),results:await L.db('results'),audit:await L.db('audit?order=id')});
    }
    if(b.action==='purge_tests'){await L.db('participants?is_test=eq.true',{method:'DELETE',prefer:'return=minimal'});L.audit('purge_tests',{});return L.send(res,200,{ok:true});}
    L.send(res,400,{error:'Action inconnue.'});
  }catch(e){L.send(res,500,{error:'Erreur serveur.'})}
};

module.exports=(req,res)=>{const h=H[(req.query||{}).r];if(!h)return L.send(res,404,{error:'Introuvable.'});return h(req,res)};
