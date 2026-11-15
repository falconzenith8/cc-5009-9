import { chromium } from 'playwright';

const browser = await chromium.launch( {
  args: [ '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox' ]
} );
const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
await page.goto( 'http://localhost:4173/', { waitUntil: 'networkidle' } );
await page.waitForTimeout( 2200 );

const results = {};

// Helper: set a slider through the real DOM event path, then let the rAF render.
async function slider( id, value ) {
  await page.evaluate( ( { id, value } ) => {
    const el = document.getElementById( id );
    el.value = value;
    el.dispatchEvent( new Event( 'input', { bubbles: true } ) );
  }, { id, value } );
  await page.waitForTimeout( 220 );
}

async function finalMean() {
  return page.evaluate( () => {
    const d = window.__lab.readFinal().data;
    const lab = window.__lab.lab;
    let sum = 0;
    for ( let i = 0; i < d.length; i += 4 ) sum += d[ i ] + d[ i + 1 ] + d[ i + 2 ];
    return sum / ( d.length / 4 );
  } );
}

results.baseline = await finalMean();

// Scattering distance slider must change the result.
await slider( 'distRange', '14.5' );
results.afterDistance = await finalMean();
results.distState = await page.evaluate( () => window.__lab.state.distanceMm );

// Strength slider must change the result.
await slider( 'strengthRange', '0.2' );
results.afterStrength = await finalMean();

// Exposure slider must change the result.
await slider( 'exposureRange', '0.6' );
results.afterExposure = await finalMean();

// Exposure must be restored via the UI, not hidden state.
await slider( 'exposureRange', '1' );
await slider( 'strengthRange', '0.85' );
await slider( 'distRange', '3.4' );
results.restored = await finalMean();

// Preset must change albedo.
await page.evaluate( () => {
  const sel = document.getElementById( 'presetSelect' );
  sel.value = 'amber';
  sel.dispatchEvent( new Event( 'change', { bubbles: true } ) );
} );
await page.waitForTimeout( 220 );
results.amberAlbedo = await page.evaluate( () => {
  const lab = window.__lab.lab;
  const mesh = lab.meshes().find( m => m.userData.kind === 'wax' );
  return mesh.material.uniforms.uAlbedo.value.getHexString();
} );
results.amberMean = await finalMean();

await page.evaluate( () => {
  const sel = document.getElementById( 'presetSelect' );
  sel.value = 'pale';
  sel.dispatchEvent( new Event( 'change', { bubbles: true } ) );
} );
await page.waitForTimeout( 220 );

// Scatter toggle via its real switch.
await page.evaluate( () => {
  const t = document.getElementById( 'scatterToggle' );
  t.checked = false;
  t.dispatchEvent( new Event( 'change', { bubbles: true } ) );
} );
await page.waitForTimeout( 220 );
results.scatterOffMean = await finalMean();
results.tagOff = await page.evaluate( () => document.getElementById( 'scatterStateTag' ).textContent );
await page.evaluate( () => {
  const t = document.getElementById( 'scatterToggle' );
  t.checked = true;
  t.dispatchEvent( new Event( 'change', { bubbles: true } ) );
} );
await page.waitForTimeout( 220 );
results.scatterOnMean = await finalMean();
results.tagOn = await page.evaluate( () => document.getElementById( 'scatterStateTag' ).textContent );

// Channel dropdown must switch the displayed channel.
await page.evaluate( () => {
  const sel = document.getElementById( 'channelSelect' );
  sel.value = 'thickness';
  sel.dispatchEvent( new Event( 'change', { bubbles: true } ) );
} );
await page.waitForTimeout( 220 );
results.channelState = await page.evaluate( () => window.__lab.state.channel );
await page.screenshot( { path: '/workspace/shots/ui-thickness-channel.png' } );
await page.evaluate( () => {
  const sel = document.getElementById( 'channelSelect' );
  sel.value = 'final';
  sel.dispatchEvent( new Event( 'change', { bubbles: true } ) );
} );
await page.waitForTimeout( 220 );

// Collapse button must collapse the panel.
await page.evaluate( () => document.getElementById( 'collapseBtn' ).click() );
await page.waitForTimeout( 450 );
results.collapsed = await page.evaluate( () => document.getElementById( 'panel' ).classList.contains( 'collapsed' ) );
await page.screenshot( { path: '/workspace/shots/ui-collapsed.png' } );
await page.evaluate( () => document.getElementById( 'collapseBtn' ).click() );
await page.waitForTimeout( 450 );

// Model scale slider must move the model and update the note.
await slider( 'scaleRange', '1.8' );
results.scaleNote = await page.evaluate( () => document.getElementById( 'scaleNote' ).textContent );
results.scaleApplied = await page.evaluate( () => window.__lab.lab.modelRoot.scale.x );
await page.screenshot( { path: '/workspace/shots/ui-scaled.png' } );
await slider( 'scaleRange', '1' );

// Reset button via UI.
await page.evaluate( () => document.getElementById( 'resetBtn' ).click() );
await page.waitForTimeout( 300 );
results.afterReset = await page.evaluate( () => ( {
  dist: document.getElementById( 'distOut' ).textContent,
  strength: document.getElementById( 'strengthOut' ).textContent,
  scale: document.getElementById( 'scaleOut' ).textContent,
  toggle: document.getElementById( 'scatterToggle' ).checked,
  collapse: document.getElementById( 'panel' ).classList.contains( 'collapsed' )
} ) );

console.log( JSON.stringify( results, null, 2 ) );
await browser.close();
