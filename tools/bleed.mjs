import { chromium } from 'playwright';

const browser = await chromium.launch( {
  args: [ '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox' ]
} );
const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
await page.goto( 'http://localhost:4173/', { waitUntil: 'networkidle' } );
await page.waitForTimeout( 2200 );

const out = {};

// Paint exactly one wax object pure red; the others stay neutral gray. Red
// energy appearing on a *different* object's pixels is real cross-object
// bleed, independent of the thickness tint.
for ( const gate of [ true, false ] ) {
  for ( const sourceId of [ 1, 2, 3 ] ) {
    const key = `${ gate ? 'gateOn' : 'gateOff' }-src${ sourceId }`;
    out[ key ] = await page.evaluate( ( { gate, sourceId } ) => {
      const lab = window.__lab.lab;
      const w = lab.width, h = lab.height;

      // renderFrame() re-applies the preset albedo; stub it for this probe so
      // the per-object chroma keys survive.
      lab.applyMaterials = () => {};
      lab.modelRoot.traverse( ( m ) => {
        if ( ! m.isMesh || m.userData.kind !== 'wax' ) return;
        const u = m.userData.material.uniforms;
        const isSource = m.userData.objectId === sourceId;
        u.uAlbedo.value.setRGB( ...( isSource ? [ 1, 0, 0 ] : [ 0, 0, 0 ] ) );
        u.uTextured.value = 0;
        u.uSssEnabled.value = 1;
      } );
      lab.state.objectGate = gate;
      lab.state.scatterOn = true;
      lab.renderFrame();

      const scatter = lab.readTarget( lab.blurB, 0 ).data;
      const albedo = lab.readTarget( lab.gbufferRT, 3 ).data;

      // Mean red energy on the source vs. on every other object and metal.
      let srcRed = 0, srcN = 0;
      const other = { 2: [ 0, 0 ], 3: [ 0, 0 ], 9: [ 0, 0 ] };
      for ( let i = 0; i < w * h; i ++ ) {
        const id = Math.floor( albedo[ i * 4 + 3 ] + 0.0008 );
        const red = scatter[ i * 4 ];
        const green = scatter[ i * 4 + 1 ];
        if ( id === sourceId ) { srcRed += red; srcN ++; }
        else if ( other[ id ] ) { other[ id ][ 0 ] += red; other[ id ][ 1 ] += green; }
      }
      const res = { sourceMeanRed: +( srcRed / Math.max( srcN, 1 ) ).toFixed( 5 ), sourcePixels: srcN };
      // Targets are pure black, so any red on them can only be bleed.
      const nonSourceRed = Object.values( other ).reduce( ( a, v ) => a + v[ 0 ], 0 );
      res.redOnTargets = +nonSourceRed.toFixed( 3 );
      res.redOnSource = +srcRed.toFixed( 3 );
      res.contaminationRatio = +( nonSourceRed / Math.max( srcRed, 1e-9 ) ).toFixed( 6 );
      return res;
    }, { gate, sourceId } );
  }
}

// Restore real material state.
await page.evaluate( () => {
  const lab = window.__lab.lab;
  lab.state.objectGate = true;
  lab.state.channel = 'final';
  lab.modelRoot.traverse( ( m ) => {
    if ( ! m.isMesh ) return;
    const u = m.userData.material.uniforms;
    if ( m.userData.kind === 'wax' ) {
      u.uTextured.value = m.userData.textured ? 1 : 0;
      u.uSssEnabled.value = 1;
    }
  } );
  window.__lab.render();
} );

console.log( JSON.stringify( out, null, 2 ) );
await browser.close();
