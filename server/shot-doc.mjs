import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const CHROME='C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT=9351;
const [out,url,w='1280',h='1400']=process.argv.slice(2);
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars',`--remote-debugging-port=${PORT}`,`--window-size=${w},${h}`,'--user-data-dir='+process.env.TEMP+'\\cdp-doc-'+Date.now(),'about:blank'],{stdio:'ignore'});
async function ws(){for(let i=0;i<60;i++){try{const j=await(await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();if(j.webSocketDebuggerUrl)return j.webSocketDebuggerUrl;}catch{}await sleep(200);}throw new Error('no chrome');}
function conn(u){return new Promise((res,rej)=>{const s=new WebSocket(u);let id=0;const p=new Map();s.onopen=()=>res({send:(m,pa={},sid)=>new Promise((a,b)=>{const i=++id;p.set(i,{a,b});s.send(JSON.stringify({id:i,method:m,params:pa,...(sid?{sessionId:sid}:{})}));}),close:()=>s.close()});s.onerror=e=>rej(new Error(e.message));s.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){const{a,b}=p.get(m.id);p.delete(m.id);m.error?b(new Error(JSON.stringify(m.error))):a(m.result);}};});}
try{
const cdp=await conn(await ws());
const{taretInfos}= {taretInfos:null};
const {targetInfos}=await cdp.send('Target.getTargets');
const page=targetInfos.find(t=>t.type==='page');
const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:page.targetId,flatten:true});
await cdp.send('Page.enable',{},sessionId);
await cdp.send('Page.navigate',{url},sessionId);
await sleep(1800);
const {data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);
writeFileSync(out,Buffer.from(data,'base64'));
console.log('saved',out);
cdp.close();
}finally{chrome.kill();}
