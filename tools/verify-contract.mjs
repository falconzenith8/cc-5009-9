// Dynamic contract evidence: drives the live lab with NON-DEFAULT parameter
// values and measures the kernel's response, so a pipeline that silently
// renders defaults cannot pass ("不接受默认值伪装成功").
//
//   A. in-page kernel self-check must be all-pass and visible in the panel
//   B. thickness response: thin edge brightens / thick block turns milky
//   C. distanceMm unit: on-screen kernel radius scales linearly with mm
//   D. thickness channel carries millimetres (geometry-derived expectations)
//   E. thinBoost is local to thin shells
//   F. preview window: real slider + orbit drag change the rendered wax
//   G. round-trip: defaults restored, baseline reproduced
//
// Requires the UI running at http://localhost:4173/ (npm run dev).
import fs from 'node:fs';
import { ensureServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';

const OUT = '/workspace/shots/contract';
fs.mkdirSync( OUT, { recursive: true } );

const URL = await ensureServer();

const browser = await launchBrowser();
const page = await browser.newPage( { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } );
const pageErrors = [];
page.on( 'pageerror', ( e ) => pageErrors.push( e.message ) );
await page.goto( URL, { waitUntil: 'networkidle' } );
await page.waitForTimeout( 2500 );

const evidence = {};
const problems = [];
const check = ( name, pass, detail ) => {
  evidence[ name.replaceAll( ' ', '_' ) ] = { pass: !! pass, detail };
  console.log( `  ${pass ? '✓' : '✗'} ${name} — ${detail}` );
  if ( ! pass ) problems.push( `${name}: ${detail}` );
};

const setState = ( patch ) => page.evaluate( ( p ) => {
  Object.assign( window.__lab.state, p );
  window.__lab.render();
}, patch );

// Per-object kernel probe, computed fully in-page (only summaries cross the bridge).
const probe = () => page.evaluate( () => {
  const lab = window.__lab.lab;
  const al = lab.readTarget( lab.gbufferRT, 3 ).data;
  const em = lab.readTarget( lab.separateRT, 0 ).data;
  const gd = lab.readTarget( lab.separateRT, 1 ).data;
  const sc = lab.readTarget( lab.blurB, 0 ).data;
  const dist = Math.max( window.__lab.state.distanceMm, 1e-3 );
  const per = {};
  for ( const id of [ 1, 2 ] ) {
    per[ id ] = { n: 0, em: 0, emR: 0, emB: 0, sc: 0, th: [], thinEm: 0, thinN: 0, thickEm: 0, thickN: 0 };
  }
  for ( let i = 0; i < al.length; i += 4 ) {
    const id = Math.floor( al[ i + 3 ] + 0.0008 );
    const p = per[ id ];
    if ( ! p ) continue;
    p.n ++;
    const e = em[ i ] + em[ i + 1 ] + em[ i + 2 ];
    p.em += e;
    p.emR += em[ i ];
    p.emB += em[ i + 2 ];
    p.sc += sc[ i ] + sc[ i + 1 ] + sc[ i + 2 ];
    if ( gd[ i + 2 ] > 0.5 ) {
      const mm = gd[ i + 3 ];
      p.th.push( mm );
      const optical = mm / dist;
      if ( optical < 1 ) { p.thinEm += e; p.thinN ++; }
      else if ( optical > 2.5 ) { p.thickEm += e; p.thickN ++; }
    }
  }
  const out = {};
  for ( const [ id, p ] of Object.entries( per ) ) {
    p.th.sort( ( a, b ) => a - b );
    const q = ( f ) => p.th.length ? p.th[ Math.min( p.th.length - 1, Math.floor( f * p.th.length ) ) ] : 0;
    out[ id ] = {
      pixels: p.n,
      meanEmission: p.em / Math.max( p.n, 1 ),
      emissionRB: p.emR / Math.max( p.emB, 1e-9 ),
      meanScatter: p.sc / Math.max( p.n, 1 ),
      thinEmission: p.thinEm / Math.max( p.thinN, 1 ), thinN: p.thinN,
      thickEmission: p.thickEm / Math.max( p.thickN, 1 ), thickN: p.thickN,
      th: { p10: q( 0.1 ), p50: q( 0.5 ), p90: q( 0.9 ), max: p.th[ p.th.length - 1 ] ?? 0, valid: p.th.length }
    };
  }
  return out;
} );

console.log( '契约动态实测（非默认值驱动）' );

// -------------------------------------------------- A. in-page self-check
{
  const results = await page.evaluate( () => window.__lab.selfcheckResults );
  const failed = results.filter( ( c ) => ! c.pass );
  const ui = await page.evaluate( () => ( {
    tag: document.getElementById( 'selfcheckTag' ).textContent,
    items: document.querySelectorAll( '#selfcheckList li' ).length,
    fails: document.querySelectorAll( '#selfcheckList li.fail' ).length
  } ) );
  check( 'A 内核自检全部通过并上屏',
    failed.length === 0 && ui.items === results.length && ui.fails === failed.length,
    `${results.length - failed.length}/${results.length} 通过；面板标记「${ui.tag}」` );
}

// --------------------------------- B. thickness response: thin vs thick (0 → 1)
await setState( { thicknessResponse: 0 } );
const b0 = await probe();
await setState( { thicknessResponse: 1 } );
const b1 = await probe();
await setState( { thicknessResponse: 0.72 } );
{
  const earRise = b1[ 1 ].thinEmission / b0[ 1 ].thinEmission;
  const cylDrop = b1[ 2 ].thickEmission / b0[ 2 ].thickEmission;
  check( 'B1 厚度响应·薄边增亮', earRise > 1.03 && b0[ 1 ].thinN > 200,
    `薄边（光学厚度<1，${b0[ 1 ].thinN}px）发射 ×${earRise.toFixed( 3 )}（响应 0→1，非默认值对）` );
  check( 'B2 厚度响应·厚块乳浊', cylDrop < 0.97 && b0[ 2 ].thickN > 200,
    `厚块（光学厚度>2.5，${b0[ 2 ].thickN}px）发射 ×${cylDrop.toFixed( 3 )}（响应 0→1）` );
  check( 'B3 厚度响应·薄边转暖', b1[ 1 ].emissionRB > b0[ 1 ].emissionRB + 0.005,
    `薄片发射 R/B ${b0[ 1 ].emissionRB.toFixed( 3 )} → ${b1[ 1 ].emissionRB.toFixed( 3 )}` );
}

// -------------------- C. distanceMm unit: pixel radius linear in millimetres
{
  await setState( { distanceMm: 2 } );
  const c2 = await page.evaluate( () => ( {
    radius: window.__lab.lab.lastPixelRadius,
    sigma: window.__lab.lab.blurQuad.material.uniforms.uSigmaWorld.value
  } ) );
  await setState( { distanceMm: 8 } );
  const c8 = await page.evaluate( () => ( {
    radius: window.__lab.lab.lastPixelRadius,
    sigma: window.__lab.lab.blurQuad.material.uniforms.uSigmaWorld.value
  } ) );
  await setState( { distanceMm: 3.4 } );
  const ratio = c8.radius / c2.radius;
  check( 'C1 散射距离单位 mm→像素半径线性', Math.abs( ratio - 4 ) < 0.12,
    `半径 ${c2.radius.toFixed( 2 )}px @2mm → ${c8.radius.toFixed( 2 )}px @8mm，比值 ${ratio.toFixed( 3 )}` );
  check( 'C2 σ(世界单位) = mm × 0.1 × 缩放',
    Math.abs( c8.sigma / c2.sigma - 4 ) < 1e-6 && Math.abs( c2.sigma - 0.2 ) < 1e-6,
    `uSigmaWorld ${c2.sigma} → ${c8.sigma}（modelScale=1）` );
}

// --------------------- D. thickness channel carries real millimetres
{
  await setState( { thicknessResponse: 0.72, distanceMm: 3.4, maxThicknessMm: 30 } );
  const d0 = await probe();
  check( 'D1 厚块中位厚度≈几何毫米', d0[ 2 ].th.p50 > 6.5 && d0[ 2 ].th.p50 < 10.5,
    `圆柱 p50 = ${d0[ 2 ].th.p50.toFixed( 2 )} mm（几何直径 ≈ 8.8–10 mm）` );
  check( 'D2 薄边显著薄于厚块', d0[ 1 ].th.p50 < d0[ 2 ].th.p50 * 0.5,
    `薄片 p50 = ${d0[ 1 ].th.p50.toFixed( 2 )} mm vs 厚块 p50 = ${d0[ 2 ].th.p50.toFixed( 2 )} mm` );

  await setState( { maxThicknessMm: 8 } );
  const d1 = await probe();
  await setState( { maxThicknessMm: 30 } );
  check( 'D3 厚度钳制于 maxThicknessMm', Math.abs( d1[ 2 ].th.p90 - 8 ) < 0.35 && d1[ 2 ].th.p90 < d0[ 2 ].th.p90,
    `上限 8mm 时厚块 p90 = ${d1[ 2 ].th.p90.toFixed( 2 )} mm（原 ${d0[ 2 ].th.p90.toFixed( 2 )} mm）` );
}

// ------------------------------ E. thinBoost stays local to thin shells
{
  await setState( { thinBoost: 0 } );
  const e0 = await probe();
  await setState( { thinBoost: 1.2 } );
  const e1 = await probe();
  await setState( { thinBoost: 0.55 } );
  const earDelta = Math.abs( e1[ 1 ].meanScatter - e0[ 1 ].meanScatter ) / e0[ 1 ].meanScatter;
  const cylDelta = Math.abs( e1[ 2 ].meanScatter - e0[ 2 ].meanScatter ) / e0[ 2 ].meanScatter;
  check( 'E1 薄片增益作用于薄边', earDelta > 0.01,
    `薄边扩散能量变化 ${( earDelta * 100 ).toFixed( 2 ) }%（增益 0→1.2）` );
  check( 'E2 薄片增益不波及厚块核心', cylDelta < earDelta * 0.6,
    `厚块扩散能量变化 ${( cylDelta * 100 ).toFixed( 2 ) }%（应远小于薄边）` );
}

// ----------------- F. preview window: real slider + orbit, visible difference
{
  await page.evaluate( () => document.getElementById( 'resetBtn' ).click() );
  await page.waitForTimeout( 300 );

  // Snapshot the final frame in-page; diffs are measured on wax pixels only
  // (background and metal must not dilute the material response).
  const snap = () => page.evaluate( () => {
    window.__snap = Array.from( window.__lab.readFinal().data );
  } );
  const diffSinceSnap = () => page.evaluate( () => {
    const lab = window.__lab.lab;
    const al = lab.readTarget( lab.gbufferRT, 3 ).data;
    const f1 = window.__lab.readFinal().data;
    const f0 = window.__snap;
    let n = 0, diff = 0, r0 = 0, r1 = 0, b0 = 0, b1 = 0;
    for ( let i = 0; i < al.length; i += 4 ) {
      const id = Math.floor( al[ i + 3 ] + 0.0008 );
      if ( id < 1 || id > 3 ) continue;
      n ++;
      diff += Math.abs( f1[ i ] - f0[ i ] ) + Math.abs( f1[ i + 1 ] - f0[ i + 1 ] ) + Math.abs( f1[ i + 2 ] - f0[ i + 2 ] );
      if ( id === 1 ) { r0 += f0[ i ]; r1 += f1[ i ]; b0 += f0[ i + 2 ]; b1 += f1[ i + 2 ]; }
    }
    return { waxDiff: diff / Math.max( n * 3, 1 ), rb0: r0 / Math.max( b0, 1e-9 ), rb1: r1 / Math.max( b1, 1e-9 ), waxPixels: n };
  } );

  await snap();
  // Real DOM path: drive the thickness slider like a user.
  await page.evaluate( () => {
    const el = document.getElementById( 'thicknessRange' );
    el.value = '1';
    el.dispatchEvent( new Event( 'input', { bubbles: true } ) );
  } );
  await page.waitForTimeout( 250 );
  const outLabel = await page.evaluate( () => document.getElementById( 'thicknessOut' ).textContent );
  const afterThick = await diffSinceSnap();
  await page.screenshot( { path: `${OUT}/preview-thickness-response.png` } );
  check( 'F1 预览窗口·厚度滑杆生效', outLabel === '1.00' && afterThick.waxDiff > 0.004,
    `厚度响应→1（界面读数 ${outLabel}），蜡面平均差 ${afterThick.waxDiff.toFixed( 4 ) }（${afterThick.waxPixels}px）` );
  check( 'F2 预览窗口·薄边透光转暖可见', afterThick.rb1 > afterThick.rb0 + 0.005,
    `薄片 R/B ${afterThick.rb0.toFixed( 3 )} → ${afterThick.rb1.toFixed( 3 )}` );

  // Orbit the wax piece with a real pointer drag on the canvas.
  const theta0 = await page.evaluate( () => window.__lab.lab.orbit.theta );
  await snap();
  await page.mouse.move( 620, 430 );
  await page.mouse.down();
  await page.mouse.move( 920, 360, { steps: 14 } );
  await page.mouse.up();
  await page.waitForTimeout( 300 );
  const theta1 = await page.evaluate( () => window.__lab.lab.orbit.theta );
  const afterOrbit = await diffSinceSnap();
  await page.screenshot( { path: `${OUT}/preview-orbited.png` } );
  check( 'F3 预览窗口·拖动旋转蜡件', Math.abs( theta1 - theta0 ) > 0.3 && afterOrbit.waxDiff > 0.002,
    `theta ${theta0.toFixed( 2 ) }→${theta1.toFixed( 2 ) }，旋转后蜡面平均差 ${afterOrbit.waxDiff.toFixed( 4 ) }` );

  await page.evaluate( () => document.getElementById( 'resetBtn' ).click() );
  await page.waitForTimeout( 300 );
}

// --------------------------------------- G. round-trip: defaults reproduce
{
  const stats = await page.evaluate( () => {
    window.__lab.render();
    const s = window.__lab.state;
    const f = window.__lab.readFinal().data;
    let sum = 0;
    for ( let i = 0; i < f.length; i += 4 ) sum += f[ i ] + f[ i + 1 ] + f[ i + 2 ];
    return {
      mean: sum / ( f.length / 4 ) / 3,
      distanceMm: s.distanceMm, thicknessResponse: s.thicknessResponse,
      maxThicknessMm: s.maxThicknessMm, thinBoost: s.thinBoost
    };
  } );
  const defaultsBack = stats.distanceMm === 3.4 && stats.thicknessResponse === 0.72 &&
    stats.maxThicknessMm === 30 && stats.thinBoost === 0.55;
  check( 'G 探针后默认值完整复原', defaultsBack,
    `distanceMm=${stats.distanceMm} thicknessResponse=${stats.thicknessResponse} maxThicknessMm=${stats.maxThicknessMm} thinBoost=${stats.thinBoost}` );
}

check( 'H 页面无脚本错误', pageErrors.length === 0, pageErrors.join( ' | ' ) || '无' );

fs.writeFileSync( `${OUT}/evidence.json`, JSON.stringify( {
  generatedAt: new Date().toISOString(),
  probesUseNonDefaultValues: true,
  evidence
}, null, 2 ) );

await browser.close();
if ( problems.length > 0 ) {
  console.error( `\n${problems.length} 项契约实测失败：` );
  for ( const p of problems ) console.error( `  ✗ ${p}` );
  process.exit( 1 );
}
console.log( `\n全部实测通过，证据写入 ${OUT}/evidence.json` );
