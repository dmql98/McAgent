import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const T = process.argv[2];
const c = new Client({ name: 'x', version: '1.0.0' }, { capabilities: {} });
await c.connect(new StreamableHTTPClientTransport(new URL('https://mcp.mcd.cn'), {
  requestInit: { headers: { Authorization: `Bearer ${T}` } },
}));
async function probe(city, keyword) {
  const r = await c.callTool({ name: 'query-nearby-stores', arguments: { beType:1, searchType:2, city, keyword }});
  const txt = (r.content||[]).map(x=>x.text??'').join('');
  const i = txt.indexOf('{"success"');
  if (i < 0) { console.log(`[${city}/${keyword}] 无 JSON：${txt.slice(0,150)}`); return; }
  let o;
  try { o = JSON.parse(txt.slice(i, txt.lastIndexOf('}')+1)); }
  catch(e) {
    // 尾巴有说明文字，用括号配对
    let depth=0, end=-1, inStr=false, esc=false;
    for (let k=i;k<txt.length;k++){const ch=txt[k];
      if(inStr){ if(esc)esc=false; else if(ch==='\\')esc=true; else if(ch==='"')inStr=false; continue;}
      if(ch==='"')inStr=true; else if(ch==='{')depth++; else if(ch==='}'){depth--; if(depth===0){end=k;break;}}
    }
    o = JSON.parse(txt.slice(i, end+1));
  }
  const d = o.data || [];
  console.log(`\n[${city} / ${keyword}] → ${d.length} 家`);
  for (const s of d.slice(0,3)) console.log(`   ${s.storeName} | dist=${s.distance}m`);
}
await probe('深圳市', '留仙洞');
await probe('广州市', '天河');
await probe('北京市', '国贸');
process.exit(0);
