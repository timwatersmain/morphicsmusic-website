// The email masthead. Run after changing the logo, the glyph font, or the design.
// Output: public/images/email/masthead-glyph.jpg (1200x360, committed).
//
// Original note: The site's best card ideas — the wordmark as a window, the
// catalogue mosaic, the glyph field — all rely on CSS masks, blend modes or
// webfonts, none of which survive an email client. So they are baked to JPEG
// here and the email just places an <img>.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
const ROOT='/Users/morphics/Desktop/MorphicsBrain/website';
const PUB=join(ROOT,'public');
const SHELL='/Users/morphics/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-x64/chrome-headless-shell';
const art=JSON.parse(readFileSync(join(ROOT,'src/data/music-catalog.json'),'utf8')).releases.filter(r=>r.artwork).map(r=>r.artwork);
const W=1200,H=360;
const FONTS=`@font-face{font-family:'Rubik';src:url('/fonts/Rubik-Variable.woff2') format('woff2-variations');font-weight:300 900;font-display:block}
@font-face{font-family:'GeistMono';src:url('/fonts/GeistMono-Variable.woff2') format('woff2-variations');font-weight:100 900;font-display:block}
@font-face{font-family:'Morphian';src:url('/fonts/MorphianTrial-Regular.woff2') format('woff2');font-display:block}`;
const GRAIN=`background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")`;
const shell=inner=>`<!doctype html><html><head><meta charset=utf-8><style>${FONTS}
*{box-sizing:border-box;margin:0;padding:0}html,body{width:${W}px;height:${H}px;overflow:hidden}
body{background:#06090a;position:relative;font-family:'Rubik',sans-serif;color:#dbfcff}
.grain{position:absolute;inset:0;opacity:.055;mix-blend-mode:overlay;${GRAIN}}
</style></head><body>${inner}<div class="grain"></div></body></html>`;

const CARDS={
 // The chosen design (O — "transmission"). The glyph field uses CSS grid and
 // per-cell opacity, and the wordmark sits over it — none of which survives an
 // email client, so it is baked to a JPEG here and the email places an <img>.
 // Everything BELOW the masthead in the email is live text, so an issue still
 // reads with images blocked.
 'masthead-glyph': shell(`<div style="position:absolute;inset:0;display:grid;grid-template-columns:repeat(12,1fr);grid-template-rows:repeat(4,1fr)">
   ${Array.from({length:48},(_,i)=>`<span style="display:flex;align-items:center;justify-content:center;font-family:Morphian;font-size:62px;color:#7dffb3;opacity:${i%11===0?.34:.15}">${String.fromCharCode(65+(i*5)%26)}</span>`).join('')}</div>
   <div style="position:absolute;inset:0;background:radial-gradient(46% 62% at 50% 50%,rgba(6,9,10,.96) 34%,rgba(6,9,10,.6) 78%,transparent)"></div>
   <img src="/images/logos/morphics-text-white.png" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px">`),
};


const MIME={'.woff2':'font/woff2','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
let pending=new Map();
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://x');
 if(pending.has(u.pathname)){res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});return res.end(pending.get(u.pathname));}
 const p=join(PUB,decodeURIComponent(u.pathname));
 if(!existsSync(p)||statSync(p).isDirectory()){res.writeHead(404);return res.end('nf');}
 res.writeHead(200,{'Content-Type':MIME[extname(p)]||'application/octet-stream'});res.end(readFileSync(p));});
const PORT=4380+(process.pid%150);
await new Promise(r=>server.listen(PORT,r));
const chrome=spawn(SHELL,[`--remote-debugging-port=${PORT+900}`,'--headless=new','--disable-gpu',`--window-size=${W},${H}`,'--hide-scrollbars','--no-first-run','--force-device-scale-factor=2',`--user-data-dir=/tmp/mh-${PORT}`,'about:blank'],{stdio:'ignore'});
const bye=()=>{try{chrome.kill('SIGTERM')}catch{};try{server.close()}catch{}};
process.on('uncaughtException',e=>{bye();console.error(e.message);process.exit(1)});
let list;for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,250));
 try{list=await (await fetch(`http://127.0.0.1:${PORT+900}/json/list`)).json();if(list.some(t=>t.type==='page'))break}catch{}}
const sock=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
let id=0;const w=new Map();sock.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}};
await new Promise(r=>sock.onopen=r);
const send=(m,p={})=>new Promise(r=>{const i=++id;w.set(i,r);sock.send(JSON.stringify({id:i,method:m,params:p}))});
await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:2,mobile:false});
for(const [name,html] of Object.entries(CARDS)){
  const path=`/__${name}.html`;pending.set(path,html);
  await send('Page.navigate',{url:`http://127.0.0.1:${PORT}${path}`});
  for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,150));
    const r=await send('Runtime.evaluate',{returnByValue:true,expression:`document.fonts.status==='loaded' && [...document.images].every(i=>i.complete&&i.naturalWidth>0)`});
    if(r.result?.result?.value===true)break;}
  await new Promise(r=>setTimeout(r,150));
  const shot=await send('Page.captureScreenshot',{format:'jpeg',quality:88,clip:{x:0,y:0,width:W,height:H,scale:0.5}});
  writeFileSync(join(PUB,'images','email',`${name}.jpg`),Buffer.from(shot.result.data,'base64'));
  console.log(' ',name+'.jpg');
}
sock.close();bye();process.exit(0);
