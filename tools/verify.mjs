import fs from 'node:fs';
import { launchBrowser } from './lib/browser.mjs';

const URL = 'http://localhost:4173/';
const OUT = '/workspace/shots/verify';
fs.mkdirSync( OUT, { recursive: true } );

const browser = await launchBrowser();
const page = await browser.newPage( { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } );
const errors = [];
page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( m.text() ); } );
page.on( 'pageerror', ( e ) => errors.push( `${e.message}` ) );

await page.goto( URL, { waitUntil: 'networkidle' } );
await page.waitForTimeout( 2500 );

const report = {};

async function shot( name ) {
  await page.screenshot( { path: `${OUT}/${name}.png` } );
}
async function render() {
  await page.evaluate( () => window.__lab.render() );
  await page.waitForTimeout( 100 );
}

report.info = await page.evaluate( () => {
  const l = window.__lab.lab;
  return {
    capabilities: l.capabilities,
    resolution: [ l.width, l.height ],
    refResolution: [ l.refW, l.refH ]
  };
} );

// -------------------------------------------------- reference vs approximate
await page.evaluate( () => window.__lab.requestReference() );
await render();
report.reference = await page.evaluate( () => window.__lab.stats() );
await shot( '01-reference-metrics' );

await page.evaluate( () => document.getElementById( 'compareBtn' ).click() );
await page.waitForTimeout( 250 );
await shot( '02-split-compare' );
report.split = await page.evaluate( () => ( {
  legendShown: ! document.getElementById( 'splitLegend' ).hidden,
  labCompare: window.__lab.lab.showCompare,
  metricsHidden: document.getElementById( 'metrics' ).hidden,
  metricsText: {
    mae: document.getElementById( 'metricMae' ).textContent,
    psnr: document.getElementById( 'metricPsnr' ).textContent,
    pixels: document.getElementById( 'metricPixels' ).textContent
  }
} ) );
await page.evaluate( () => document.getElementById( 'compareBtn' ).click() );

// ------------------------------------------------------------- image reads
const read = ( name, attachment ) => page.evaluate( ( { name, attachment } ) => {
  const res = window.__lab.readTarget( name, attachment );
  return { data: Array.from( res.data ), width: res.width, height: res.height };
}, { name, attachment } );

// -------------------------------------------------- gating across objects
{
  const albedo = await read( 'gbuffer', 3 );
  const guide = await read( 'separate', 1 );
  const emission = await read( 'separate', 0 );
  const { data: al, width: w, height: h } = albedo;
  const gd = guide.data, em = emission.data;
  let metalPixels = 0, metalMasked = 0, metalMaxEmission = 0;
  let waxPixels = 0, waxMasked = 0, validThickness = 0;
  for ( let i = 0; i < w * h; i ++ ) {
    const id = Math.floor( al[ i * 4 + 3 ] + 0.0008 );
    if ( id === 9 ) {
      metalPixels ++;
      if ( em[ i * 4 + 3 ] > 0.5 ) metalMasked ++;
      metalMaxEmission = Math.max( metalMaxEmission, em[ i * 4 ], em[ i * 4 + 1 ], em[ i * 4 + 2 ] );
    } else if ( id >= 1 && id <= 3 ) {
      waxPixels ++;
      if ( em[ i * 4 + 3 ] > 0.5 ) waxMasked ++;
      if ( gd[ i * 4 + 2 ] > 0.5 ) validThickness ++;
    }
  }
  report.gating = { metalPixels, metalMasked, metalMaxEmission, waxPixels, waxMasked, validThickness };
}

// -------------------------------------------------- silhouette bleed check
{
  const al = ( await read( 'gbuffer', 3 ) ).data;
  const diffused = await read( 'blurB', 0 );
  const df = diffused.data;
  const { width: w, height: h } = diffused;
  let on = 0, off = 0, worstOff = 0, offPixels = 0;
  for ( let i = 0; i < w * h; i ++ ) {
    const packed = al[ i * 4 + 3 ];
    const id = Math.floor( packed + 0.0008 );
    const flags = Math.floor( ( packed - id ) * 64 + 0.5 );
    const participant = id >= 1 && id <= 3 && ( flags % 2 ) >= 1 && ( Math.floor( flags / 2 ) % 2 ) >= 1 && ( Math.floor( flags / 4 ) % 2 ) < 1;
    const rgb = df[ i * 4 ] + df[ i * 4 + 1 ] + df[ i * 4 + 2 ];
    if ( participant ) on += rgb;
    else { off += rgb; worstOff = Math.max( worstOff, rgb ); if ( rgb > 1e-4 ) offPixels ++; }
  }
  report.bleed = {
    energyOnParticipant: on, energyOffParticipant: off,
    offOverOn: off / Math.max( on, 1e-9 ), worstOff, offPixels
  };
}

// -------------------------------------------------- object gate disabled
await page.evaluate( () => { window.__lab.state.objectGate = false; window.__lab.render(); } );
await page.waitForTimeout( 120 );
{
  const al = ( await read( 'gbuffer', 3 ) ).data;
  const diffused = await read( 'blurB', 0 );
  const df = diffused.data;
  const { width: w, height: h } = diffused;
  let maxMetalEnergy = 0, maxWaxEnergy = 0, metalPixels = 0;
  for ( let i = 0; i < w * h; i ++ ) {
    const id = Math.floor( al[ i * 4 + 3 ] + 0.0008 );
    const rgb = df[ i * 4 ] + df[ i * 4 + 1 ] + df[ i * 4 + 2 ];
    if ( id === 9 ) { maxMetalEnergy = Math.max( maxMetalEnergy, rgb ); metalPixels ++; }
    if ( id >= 1 && id <= 3 ) maxWaxEnergy = Math.max( maxWaxEnergy, rgb );
  }
  report.objectGateOff = { maxMetalEnergy, maxWaxEnergy, metalPixels };
}
await page.evaluate( () => { window.__lab.state.objectGate = true; window.__lab.render(); } );
await page.waitForTimeout( 120 );

// -------------------------------------------------- depth discontinuity
{
  const al = ( await read( 'gbuffer', 3 ) ).data;
  const nd = ( await read( 'gbuffer', 2 ) ).data;
  const { width: w, height: h } = await read( 'gbuffer', 3 );
  let silhouette = 0;
  const norms = [];
  for ( let y = 1; y < h - 1; y ++ ) {
    for ( let x = 1; x < w - 1; x ++ ) {
      const i = ( y * w + x ) * 4;
      const id = Math.floor( al[ i + 3 ] + 0.0008 );
      if ( id < 1 || id > 3 ) continue;
      for ( const [ dx, dy ] of [ [ 1, 0 ], [ -1, 0 ], [ 0, 1 ], [ 0, -1 ] ] ) {
        const j = ( ( y + dy ) * w + ( x + dx ) ) * 4;
        const nid = Math.floor( al[ j + 3 ] + 0.0008 );
        if ( nid === 0 || nid === 9 ) { silhouette ++; break; }
      }
    }
  }
  report.depthDiscontinuity = {
    silhouette,
    normalSample: [ nd[ 0 ], nd[ 1 ], nd[ 2 ], nd[ 3 ] ]
  };
}

// -------------------------------------------------- model scale invariance
{
  const results = [];
  for ( const scale of [ 0.7, 1.0, 1.4 ] ) {
    await page.evaluate( ( s ) => { window.__lab.state.modelScale = s; window.__lab.render(); }, scale );
    await page.waitForTimeout( 140 );
    const stats = await page.evaluate( () => {
      const l = window.__lab.lab;
      const final = window.__lab.readFinal().data;
      const df = window.__lab.readTarget( 'blurB', 0 ).data;
      const w = l.width, h = l.height;
      let lum = 0, count = 0, scatterE = 0;
      for ( let i = 0; i < w * h; i ++ ) {
        if ( df[ i * 4 + 3 ] < 0.5 ) continue;
        lum += final[ i * 4 ] + final[ i * 4 + 1 ] + final[ i * 4 + 2 ];
        scatterE += df[ i * 4 ] + df[ i * 4 + 1 ] + df[ i * 4 + 2 ];
        count ++;
      }
      return { meanWaxLuminance: lum / Math.max( count, 1 ), meanScatter: scatterE / Math.max( count, 1 ), count, pixels: w * h };
    } );
    results.push( { scale, ...stats } );
    await shot( `03-scale-${ scale }` );
  }
  report.scale = results;
  await page.evaluate( () => { window.__lab.state.modelScale = 1; window.__lab.render(); } );
}

// -------------------------------------------------- resolution invariance
{
  const results = [];
  for ( const scale of [ 0.5, 1.0, 1.5 ] ) {
    await page.evaluate( ( s ) => {
      window.__lab.state.resolutionScale = s;
      window.__lab.resize();
      window.__lab.render();
    }, scale );
    await page.waitForTimeout( 200 );
    const stats = await page.evaluate( () => {
      const l = window.__lab.lab;
      const final = window.__lab.readFinal().data;
      const df = window.__lab.readTarget( 'blurB', 0 ).data;
      const w = l.width, h = l.height;
      let lum = 0, count = 0, scatterE = 0;
      for ( let i = 0; i < w * h; i ++ ) {
        if ( df[ i * 4 + 3 ] < 0.5 ) continue;
        lum += final[ i * 4 ] + final[ i * 4 + 1 ] + final[ i * 4 + 2 ];
        scatterE += df[ i * 4 ] + df[ i * 4 + 1 ] + df[ i * 4 + 2 ];
        count ++;
      }
      return { meanWaxLuminance: lum / Math.max( count, 1 ), meanScatter: scatterE / Math.max( count, 1 ), count, coverage: count / ( w * h ), pixels: w * h };
    } );
    results.push( { scale, ...stats } );
    await shot( `04-res-${ scale }` );
  }
  report.resolution = results;
  await page.evaluate( () => { window.__lab.state.resolutionScale = 1; window.__lab.resize(); window.__lab.render(); } );
  await page.waitForTimeout( 200 );
}

// -------------------------------------------------- channels
report.channels = [];
for ( const ch of [ 'final', 'surface', 'diffuse', 'specular', 'scatter', 'normalShade', 'albedo', 'normal', 'depth', 'thickness', 'mask', 'objectid' ] ) {
  await page.evaluate( ( ch ) => {
    window.__lab.state.channel = ch;
    document.getElementById( 'channelSelect' ).value = ch;
    window.__lab.render();
  }, ch );
  await page.waitForTimeout( 60 );
  await shot( `05-channel-${ ch }` );
  report.channels.push( ch );
}
await page.evaluate( () => { window.__lab.state.channel = 'final'; document.getElementById( 'channelSelect' ).value = 'final'; window.__lab.render(); } );

// -------------------------------------------------- scatter off / on
{
  await page.evaluate( () => { window.__lab.state.scatterOn = false; document.getElementById( 'scatterToggle' ).checked = false; window.__lab.render(); } );
  await page.waitForTimeout( 100 );
  await shot( '06-scatter-off' );
  const off = await page.evaluate( () => Array.from( window.__lab.readFinal().data ) );
  await page.evaluate( () => { window.__lab.state.scatterOn = true; document.getElementById( 'scatterToggle' ).checked = true; window.__lab.render(); } );
  await page.waitForTimeout( 100 );
  await shot( '07-scatter-on' );
  const on = await page.evaluate( () => Array.from( window.__lab.readFinal().data ) );
  let sum = 0, max = 0, n = 0;
  for ( let i = 0; i < on.length; i += 4 ) {
    const d = ( Math.abs( on[ i ] - off[ i ] ) + Math.abs( on[ i + 1 ] - off[ i + 1 ] ) + Math.abs( on[ i + 2 ] - off[ i + 2 ] ) ) / 3;
    sum += d; max = Math.max( max, d ); n ++;
  }
  report.scatterAB = { meanAbs: sum / n, maxAbs: max };
}

// -------------------------------------------------- save / reset / import
report.persistence = await page.evaluate( async () => {
  window.__lab.state.distanceMm = 11.4;
  window.__lab.state.strength = 0.31;
  localStorage.removeItem( 'wax-scatter-lab:v1' );
  document.getElementById( 'saveBtn' ).click();
  const saved = JSON.parse( localStorage.getItem( 'wax-scatter-lab:v1' ) );

  document.getElementById( 'resetBtn' ).click();
  await new Promise( ( r ) => setTimeout( r, 80 ) );
  const afterReset = JSON.parse( JSON.stringify( window.__lab.state ) );

  const file = new File( [ JSON.stringify( saved ) ], 'archive.json', { type: 'application/json' } );
  const input = document.getElementById( 'importInput' );
  const dt = new DataTransfer();
  dt.items.add( file );
  input.files = dt.files;
  input.dispatchEvent( new Event( 'change' ) );
  await new Promise( ( r ) => setTimeout( r, 350 ) );
  const afterImport = JSON.parse( JSON.stringify( window.__lab.state ) );

  return {
    savedOk: saved.params.distanceMm === 11.4 && saved.params.strength === 0.31,
    resetOk: afterReset.distanceMm === 3.4 && afterReset.strength === 0.85 &&
             afterReset.scatterOn === true && afterReset.modelScale === 1,
    importOk: afterImport.distanceMm === 11.4 && afterImport.strength === 0.31,
    uiAfterImport: {
      distanceOut: document.getElementById( 'distOut' ).textContent,
      strengthOut: document.getElementById( 'strengthOut' ).textContent,
      status: document.getElementById( 'saveStatus' ).textContent
    }
  };
} );
await page.waitForTimeout( 400 );
await shot( '08-after-import' );

await page.evaluate( () => document.getElementById( 'resetBtn' ).click() );
await page.waitForTimeout( 300 );
await render();
await shot( '09-final-default' );

report.errors = errors;
fs.writeFileSync( `${OUT}/report.json`, JSON.stringify( report, null, 2 ) );
console.log( JSON.stringify( report, null, 2 ) );
await browser.close();
