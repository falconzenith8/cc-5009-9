import { launchBrowser } from './lib/browser.mjs';

const browser = await launchBrowser();
const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
await page.goto( 'http://localhost:4173/', { waitUntil: 'networkidle' } );
await page.waitForTimeout( 2200 );

const out = await page.evaluate( () => {
  const l = window.__lab.lab;
  const w = l.width, h = l.height;
  const albedo = l.readTarget( l.gbufferRT, 3 ).data;
  const guide = l.readTarget( l.separateRT, 1 ).data;
  const names = { 1: 'ear', 2: 'cylinder', 3: 'turn', 9: 'metal' };
  const per = {};
  for ( let i = 0; i < w * h; i ++ ) {
    const id = Math.floor( albedo[ i * 4 + 3 ] + 0.0008 );
    if ( id < 1 ) continue;
    const n = names[ id ] || id;
    const p = per[ n ] || ( per[ n ] = { count: 0, sum: 0, vals: [], valid: 0 } );
    p.count ++;
    const t = guide[ i * 4 + 3 ];
    p.sum += t;
    p.vals.push( t );
    if ( guide[ i * 4 + 2 ] > 0.5 ) p.valid ++;
  }
  const res = {};
  for ( const [ n, p ] of Object.entries( per ) ) {
    p.vals.sort( ( a, b ) => a - b );
    const q = ( f ) => p.vals[ Math.min( p.vals.length - 1, Math.floor( f * p.vals.length ) ) ];
    res[ n ] = {
      count: p.count, valid: p.valid,
      meanMm: p.sum / p.count,
      p10: q( 0.1 ), p50: q( 0.5 ), p90: q( 0.9 ),
      min: p.vals[ 0 ], max: p.vals[ p.vals.length - 1 ]
    };
  }
  return res;
} );
console.log( JSON.stringify( out, null, 2 ) );
await browser.close();
