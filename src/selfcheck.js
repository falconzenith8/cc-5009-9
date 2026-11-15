// In-page kernel self-check. Runs at startup and on demand from the panel.
//
// Two layers:
//   1. wiring — after a render, the kernel uniforms must mirror the control
//      state (a renamed or disconnected uniform shows up here immediately);
//   2. functional probes — non-default values of thicknessResponse and
//      distanceMm must measurably move the emission and the kernel radius, so
//      a pipeline that silently renders defaults cannot pass.
import { WORLD_PER_MM, RADIUS_SCALE, TAPS } from './renderer.js';

const near = ( a, b, eps = 1e-6 ) => Math.abs( a - b ) <= eps;
const f3 = ( v ) => Number( v ).toFixed( 3 );

export function runSelfcheck( lab ) {
  const checks = [];
  const record = ( name, pass, detail ) => checks.push( { name, pass: !! pass, detail } );

  const s = lab.state;
  const saved = {
    thicknessResponse: s.thicknessResponse,
    distanceMm: s.distanceMm
  };
  const savedRefValid = lab.referenceValid;
  const savedRefRequested = lab.referenceRequested;

  try {
    // ---------------------------------------------------------- 1. wiring
    lab.renderFrame();
    const sep = lab.separateQuad.material.uniforms;
    const blur = lab.blurQuad.material.uniforms;
    const comp = lab.compositeQuad.material.uniforms;
    const worldPerMm = WORLD_PER_MM * s.modelScale;

    record(
      '散射距离接线 (distanceMm → uDistanceMm/uSigmaWorld)',
      near( sep.uDistanceMm.value, s.distanceMm ) &&
        near( blur.uSigmaWorld.value, s.distanceMm * worldPerMm ),
      `uDistanceMm=${f3( sep.uDistanceMm.value )} · uSigmaWorld=${f3( blur.uSigmaWorld.value )} 世界单位`
    );
    record(
      '厚度响应接线 (thicknessResponse → uThicknessResponse)',
      near( sep.uThicknessResponse.value, s.thicknessResponse ),
      `uThicknessResponse=${f3( sep.uThicknessResponse.value )}`
    );
    record(
      '厚度上限接线 (maxThicknessMm → uMaxThicknessMm)',
      near( sep.uMaxThicknessMm.value, s.maxThicknessMm ),
      `uMaxThicknessMm=${f3( sep.uMaxThicknessMm.value )} mm`
    );
    record(
      '强度/增益/门控接线',
      near( comp.uStrength.value, s.strength ) &&
        near( blur.uThinBoost.value, s.thinBoost ) &&
        near( blur.uNormalTol.value, s.normalTol ) &&
        near( blur.uObjectGate.value, s.objectGate ? 1 : 0 ) &&
        blur.uTaps.value === TAPS[ s.quality ],
      `uStrength=${f3( comp.uStrength.value )} · uThinBoost=${f3( blur.uThinBoost.value )} · uTaps=${blur.uTaps.value}`
    );

    // --------------------------------------- 2. thickness-response probe
    // Probe with NON-default values on purpose: if the kernel ignored the
    // parameter and kept rendering defaults, both measurements would match
    // and the probe would fail. Compare like with like: only optically thin
    // ear pixels (band < 1) and optically thick cylinder pixels (band > 2.5)
    // are measured — the transition band in between is allowed to do either.
    const bandEmission = () => {
      const al = lab.readTarget( lab.gbufferRT, 3 ).data;
      const em = lab.readTarget( lab.separateRT, 0 ).data;
      const gd = lab.readTarget( lab.separateRT, 1 ).data;
      const dist = Math.max( s.distanceMm, 1e-3 );
      const thin = { sum: 0, n: 0 };
      const thick = { sum: 0, n: 0 };
      for ( let i = 0; i < al.length; i += 4 ) {
        const id = Math.floor( al[ i + 3 ] + 0.0008 );
        if ( gd[ i + 2 ] < 0.5 ) continue;
        const optical = gd[ i + 3 ] / dist;
        const e = em[ i ] + em[ i + 1 ] + em[ i + 2 ];
        if ( id === 1 && optical < 1 ) { thin.sum += e; thin.n ++; }
        else if ( id === 2 && optical > 2.5 ) { thick.sum += e; thick.n ++; }
      }
      return {
        thin: thin.sum / Math.max( thin.n, 1 ), thinN: thin.n,
        thick: thick.sum / Math.max( thick.n, 1 ), thickN: thick.n
      };
    };

    s.thicknessResponse = 0;
    lab.renderFrame();
    const e0 = bandEmission();
    s.thicknessResponse = 1;
    lab.renderFrame();
    const e1 = bandEmission();

    record(
      '厚度响应实测：薄边增亮',
      e1.thin > e0.thin * 1.03 && e0.thinN > 200,
      `薄边（光学厚度<1，${e0.thinN}px）平均发射 ${f3( e0.thin )} → ${f3( e1.thin )}（响应 0→1）`
    );
    record(
      '厚度响应实测：厚块转乳浊',
      e1.thick < e0.thick * 0.97 && e0.thickN > 200,
      `厚块（光学厚度>2.5，${e0.thickN}px）平均发射 ${f3( e0.thick )} → ${f3( e1.thick )}（响应 0→1）`
    );

    // ------------------------------------------ 3. distance unit probe
    // The on-screen kernel radius must scale linearly with the millimetre
    // value — this is what ties the UI's mm to the rendered blur width.
    s.distanceMm = 2;
    lab.renderFrame();
    const r2 = lab.lastPixelRadius;
    s.distanceMm = 8;
    lab.renderFrame();
    const r8 = lab.lastPixelRadius;
    const ratio = r8 / Math.max( r2, 1e-9 );
    record(
      '散射距离单位实测 (mm → 像素半径线性)',
      near( ratio, 4, 0.12 ),
      `半径 ${f3( r2 )}px @2mm → ${f3( r8 )}px @8mm，比值 ${f3( ratio )}（期望 4）`
    );
    record(
      '核半径公式 (σ × 1.8 × (1+增益))',
      near(
        lab.lastPixelRadius,
        8 * worldPerMm * RADIUS_SCALE * ( 1 + s.thinBoost ) *
          ( lab.height / ( 2 * Math.tan( lab.camera.fov * Math.PI / 360 ) * lab.orbit.radius ) ),
        0.02 * lab.lastPixelRadius
      ),
      `lastPixelRadius=${f3( lab.lastPixelRadius )}px`
    );
  } finally {
    s.thicknessResponse = saved.thicknessResponse;
    s.distanceMm = saved.distanceMm;
    lab.referenceValid = savedRefValid;
    lab.referenceRequested = savedRefRequested;
    lab.renderFrame();
  }

  return checks;
}
