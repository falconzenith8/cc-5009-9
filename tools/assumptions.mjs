// Regenerates the model-assumption gallery referenced by
// docs/model-assumptions.md: thin-edge vs thick-block contrast, a numeric
// cross-section (SVG), and the approximation failure cases — not cherry-picked
// beauty angles. Requires the UI at http://localhost:4173/ (npm run dev).
import fs from 'node:fs';
import { ensureServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';

const OUT = '/workspace/shots/assumptions';
fs.mkdirSync( OUT, { recursive: true } );

const URL = await ensureServer();

const browser = await launchBrowser();
const page = await browser.newPage( { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } );
await page.goto( URL, { waitUntil: 'networkidle' } );
await page.waitForTimeout( 2500 );

const CLIP = { x: 0, y: 0, width: 1100, height: 900 };
const shot = ( name ) => page.screenshot( { path: `${OUT}/${name}.png`, clip: CLIP } );
const setState = ( patch ) => page.evaluate( ( p ) => {
  Object.assign( window.__lab.state, p );
  window.__lab.render();
}, patch );

const initialOrbit = await page.evaluate( () => ( { ...window.__lab.lab.orbit } ) );
const report = { generatedAt: new Date().toISOString(), artifacts: [] };
const artifact = ( file, caption ) => {
  report.artifacts.push( { file, caption } );
  console.log( `  · ${file} — ${caption}` );
};

// -------------------------------------------- 1–3. thin/thick contrast set
await setState( { channel: 'final' } );
await shot( '01-contrast-final' );
artifact( '01-contrast-final.png', '默认视角最终合成：薄边（耳片）与厚块（圆柱）对照' );

await setState( { channel: 'thickness' } );
await shot( '02-contrast-thickness' );
artifact( '02-contrast-thickness.png', '厚度通道（mm）：薄边 ≈1–3 mm，厚块核心 ≈8–10 mm' );

await setState( { channel: 'scatter' } );
await shot( '03-contrast-scatter' );
artifact( '03-contrast-scatter.png', '扩散光照通道：薄边暖亮、厚块乳浊' );
await setState( { channel: 'final' } );

// ------------------------------------------------ 4. numeric cross-section
const section = await page.evaluate( () => {
  const lab = window.__lab.lab;
  const al = lab.readTarget( lab.gbufferRT, 3 ).data;
  const em = lab.readTarget( lab.separateRT, 0 ).data;
  const gd = lab.readTarget( lab.separateRT, 1 ).data;
  const w = lab.width, h = lab.height;

  // Pick the scanline that best crosses both the thin ear (id 1) and the
  // thick cylinder (id 2) — the contrast the contract is about.
  let bestRow = 0, bestScore = -1;
  for ( let y = 0; y < h; y += 2 ) {
    let c1 = 0, c2 = 0;
    for ( let x = 0; x < w; x += 4 ) {
      const id = Math.floor( al[ ( y * w + x ) * 4 + 3 ] + 0.0008 );
      if ( id === 1 ) c1 ++; else if ( id === 2 ) c2 ++;
    }
    const score = Math.min( c1, c2 );
    if ( score > bestScore ) { bestScore = score; bestRow = y; }
  }

  const px = [];
  for ( let x = 0; x < w; x ++ ) {
    const i = ( bestRow * w + x ) * 4;
    const id = Math.floor( al[ i + 3 ] + 0.0008 );
    px.push( {
      x, id,
      thicknessMm: gd[ i + 2 ] > 0.5 ? gd[ i + 3 ] : null,
      emission: ( em[ i ] + em[ i + 1 ] + em[ i + 2 ] ) / 3
    } );
  }
  return {
    row: bestRow, width: w, height: h,
    distanceMm: window.__lab.state.distanceMm,
    maxThicknessMm: window.__lab.state.maxThicknessMm,
    px
  };
} );

{
  const W = 1100, H = 360, padL = 56, padB = 34, padT = 30;
  const plotW = W - padL - 16, plotH = H - padT - padB;
  const xTo = ( x ) => padL + ( x / section.width ) * plotW;
  const maxMm = section.maxThicknessMm;
  const yMm = ( mm ) => padT + plotH - ( Math.min( mm, maxMm ) / maxMm ) * plotH;
  const maxEm = Math.max( 0.6, ...section.px.map( ( p ) => p.emission ) );
  const yEm = ( e ) => padT + plotH - ( e / maxEm ) * plotH;

  const thinLo = 0.25 * section.distanceMm;
  const thinHi = 2.5 * section.distanceMm;
  const thickPts = section.px.filter( ( p ) => p.thicknessMm !== null )
    .map( ( p ) => `${xTo( p.x ).toFixed( 1 ) },${yMm( p.thicknessMm ).toFixed( 1 ) }` ).join( ' ' );
  const emPts = section.px.map( ( p ) => `${xTo( p.x ).toFixed( 1 ) },${yEm( p.emission ).toFixed( 1 ) }` ).join( ' ' );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="monospace" font-size="11">
  <rect width="${W}" height="${H}" fill="#141210"/>
  <rect x="${padL}" y="${yMm( thinHi ).toFixed( 1 ) }" width="${plotW}" height="${( yMm( thinLo ) - yMm( thinHi ) ).toFixed( 1 ) }" fill="#2a3a2a" opacity="0.55"/>
  <line x1="${padL}" y1="${yMm( maxMm )}" x2="${padL + plotW}" y2="${yMm( maxMm )}" stroke="#e2694f" stroke-dasharray="5 4" stroke-width="1"/>
  <text x="${padL + 6}" y="${yMm( maxMm ) + 13}" fill="#e2694f">钳制 ${maxMm} mm</text>
  <text x="${padL + 6}" y="${yMm( thinHi ) - 5}" fill="#9fb295">薄壳过渡带 ${thinLo.toFixed( 2 ) }–${thinHi.toFixed( 1 ) } mm（光学厚度 0.25–2.5 × ${section.distanceMm} mm）</text>
  <polyline points="${emPts}" fill="none" stroke="#e8a75a" stroke-width="1.2" opacity="0.9"/>
  <polyline points="${thickPts}" fill="none" stroke="#7fb2e8" stroke-width="1.6"/>
  <text x="${W - 250}" y="${padT + 4}" fill="#7fb2e8">— 厚度 mm（左轴 0–${maxMm}）</text>
  <text x="${W - 250}" y="${padT + 18}" fill="#e8a75a">— 发射亮度（归一）</text>
  <text x="${padL}" y="${H - 10}" fill="#a99d8a">扫描线 y=${section.row}（同时穿过薄边 id=1 与厚块 id=2）；左端薄片厚度低、发射强，右端厚块厚度高、发射乳浊。</text>
  <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#3a342c"/>
  <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#3a342c"/>
</svg>`;
  fs.writeFileSync( `${OUT}/04-section.svg`, svg );
  fs.writeFileSync( `${OUT}/04-section.json`, JSON.stringify( section ) );
  artifact( '04-section.svg', `截面：扫描线 y=${section.row} 的厚度(mm)与发射亮度，标注过渡带与钳制线` );
  report.section = { row: section.row, width: section.width };
}

// ------------------------------------ 5. failure: back-lit transmission absent
await page.evaluate( () => {
  const lab = window.__lab.lab;
  lab.orbit.theta += Math.PI; // camera opposite the key light: wax between light and camera
  lab.applyOrbit();
  window.__lab.render();
} );
await shot( '05-backlit-failure' );
artifact( '05-backlit-failure.png', '失效·背光视角：可见表面近似不含透射，薄片背光不发光' );
report.backlit = { note: 'theta += π，相机与主光源异侧' };

// ------------------------------------ 6. failure: thickness clamp plateau
await page.evaluate( () => {
  const lab = window.__lab.lab;
  lab.orbit.theta -= Math.PI;
  lab.applyOrbit();
} );
await setState( { maxThicknessMm: 8, channel: 'thickness' } );
await shot( '06-clamp-failure' );
artifact( '06-clamp-failure.png', '失效·厚度钳制：maxThicknessMm=8 时厚核厚度被截为平台' );
await setState( { maxThicknessMm: 30, channel: 'final' } );

// ------------------------------------ 7. failure: silhouette energy fade
await page.evaluate( () => {
  const lab = window.__lab.lab;
  lab.orbit.radius = 5.2;
  lab.applyOrbit();
  window.__lab.state.channel = 'scatter';
  window.__lab.render();
} );
await shot( '07-silhouette-fade' );
artifact( '07-silhouette-fade.png', '失效·轮廓衰减：剪影边缘扩散能量自然变暗（不归一到满强度）' );

// ------------------------------------------------------------- restore & go
await page.evaluate( ( orbit ) => {
  const lab = window.__lab.lab;
  Object.assign( lab.orbit, orbit );
  lab.applyOrbit();
  window.__lab.state.channel = 'final';
  window.__lab.render();
}, initialOrbit );
await page.evaluate( () => document.getElementById( 'resetBtn' ).click() );
await page.waitForTimeout( 250 );

fs.writeFileSync( `${OUT}/report.json`, JSON.stringify( report, null, 2 ) );
console.log( `\n样例与截面已再生成于 ${OUT}/（共 ${report.artifacts.length} 项），状态已复原。` );
await browser.close();
