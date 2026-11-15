import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[ 2 ] || 'http://localhost:4173/';
const out = process.argv[ 3 ] || '/workspace/shots/shot.png';

const browser = await chromium.launch( {
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox'
  ]
} );
const page = await browser.newPage( { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } );

const logs = [];
page.on( 'console', ( m ) => logs.push( `[${m.type()}] ${m.text()}` ) );
page.on( 'pageerror', ( e ) => logs.push( `[pageerror] ${e.message}\n${e.stack}` ) );

await page.goto( url, { waitUntil: 'networkidle' } );
await page.waitForTimeout( 2500 );

const info = await page.evaluate( () => {
  const lab = window.__lab;
  if ( ! lab ) return { error: 'window.__lab missing' };
  return {
    width: lab.lab.width,
    height: lab.lab.height,
    capabilities: lab.lab.capabilities,
    channel: lab.state.channel,
    scatterOn: lab.state.scatterOn,
    frame: lab.lab.renderFrame ? 'callable' : 'missing'
  };
} );

fs.mkdirSync( '/workspace/shots', { recursive: true } );
await page.screenshot( { path: out } );

console.log( JSON.stringify( { info, logs }, null, 2 ) );
await browser.close();
