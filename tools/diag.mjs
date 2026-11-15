import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const out = await page.evaluate(() => {
  const L = window.__lab;
  L.render();
  const W = L.lab.width, H = L.lab.height;
  const albedo = L.readTarget('gbuffer', 3);
  const nd = L.readTarget('gbuffer', 2);
  const back = L.readTarget('back', 0);
  const guide = L.readTarget('separate', 1);
  const A = albedo.data, N = nd.data, B = back.data, G = guide.data;
  let objPx=0, validPx=0, backGtFront=0, idMismatch=0, clamped=0;
  const thickHist = {};
  let backMin=1e9, backMax=-1e9, backMean=0;
  for (let i=0;i<A.length;i+=4) {
    const packed=A[i+3];
    const id=Math.floor(packed+0.0008);
    const bk=B[i];
    if (bk<backMin) backMin=bk; if(bk>backMax)backMax=bk; backMean+=bk;
    if (id>=0.5) {
      objPx++;
      const frontDepth=N[i+3];
      if (bk>frontDepth+1e-4) { backGtFront++; const bid=Math.floor(B[i+1]+0.0008); if(Math.abs(bid-id)>=0.5) idMismatch++; }
      const valid=G[i+2];
      if (valid>0.5) {
        validPx++;
        const mm=G[i+3];
        if (mm>=29.9) clamped++;
        const b=Math.min(30,Math.round(mm/3)*3); thickHist[b]=(thickHist[b]||0)+1;
      }
    }
  }
  const total=A.length/4;
  // ascii map of validity on a coarse grid (top row = y=H in FB space)
  const cols=72, rows=24; let map='';
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const x=Math.floor((c+0.5)*W/cols), y=Math.floor((rows-1-r+0.5)*H/rows);
      const i=(y*W+x)*4; const id=Math.floor(A[i+3]+0.0008);
      const ok=G[i+2]>0.5;
      map += id<0.5 ? '.' : (ok?'#':'x');
    }
    map+='\n';
  }
  return { total, objPx, validPx, backGtFront, idMismatch, clamped,
    backMin, backMax, backMean: backMean/total, thickHist, map };
});
console.log(JSON.stringify({...out, map: undefined}, null, 2));
console.log(out.map);
await browser.close();
