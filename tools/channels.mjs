import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => { if (m.type() !== 'debug') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const channels = ['final','surface','diffuse','specular','scatter','normalShade','albedo','normal','depth','thickness','mask','objectid'];
fs.mkdirSync('/workspace/shots/channels', { recursive: true });
for (const ch of channels) {
  await page.evaluate((c) => { window.__lab.state.channel = c; window.__lab.render(); }, ch);
  await page.waitForTimeout(80);
  await page.screenshot({ path: `/workspace/shots/channels/${ch}.png`, clip: { x: 0, y: 0, width: 1100, height: 900 } });
}

// Numeric probes: sampling the separate + gbuffer targets.
const probe = await page.evaluate(() => {
  const L = window.__lab;
  L.state.channel = 'final';
  L.render();
  const sep = L.readTarget('separate', 0); // emission rgb + mask a
  const guide = L.readTarget('separate', 1); // depth, thickness, valid, thicknessMm
  const back = L.readTarget('back', 0);
  const gb = L.readTarget('gbuffer', 3); // albedo + id/flags
  const W = sep.width, H = sep.height;
  function stats(arr, idx) { let mn=1e9,mx=-1e9,sum=0; for(let i=idx;i<arr.length;i+=4){const v=arr[i]; if(v<mn)mn=v; if(v>mx)mx=v; sum+=v;} return {min:mn,max:mx,mean:sum/(arr.length/4)}; }
  const mask = stats(sep.data, 3);
  const thick = stats(guide.data, 1);
  const thickMm = stats(guide.data, 3);
  const valid = stats(guide.data, 2);
  const emission = stats(sep.data, 0);
  const backDepth = stats(back.data, 0);
  // Sample a few specific pixels (center-ish, ears, cylinder, background)
  function at(x,y,arr){const i=(y*W+x)*4; return [arr[i],arr[i+1],arr[i+2],arr[i+3]];}
  const pts = {
    bgTL: at(80, 80, gb.data),
    ear: at(480, 380, gb.data),
    turned: at(640, 500, gb.data),
    cylinder: at(900, 450, gb.data)
  };
  return { W, H, mask, thick, thickMm, valid, emission, backDepth, pts };
});
console.log(JSON.stringify({ logs, probe }, null, 2));
await browser.close();
