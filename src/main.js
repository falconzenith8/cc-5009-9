import { ScatterLab, CHANNELS } from './renderer.js';
import { Panel } from './ui.js';
import {
  defaultState, loadState, saveState, exportState, importState, PRESETS
} from './state.js';
import './style.css';

const state = loadState();

const canvas = document.getElementById( 'view' );
const panelEl = document.getElementById( 'panel' );

let lab;
try {
  lab = new ScatterLab( canvas, state, PRESETS[ state.preset ] );
} catch ( err ) {
  document.getElementById( 'loading' ).innerHTML =
    `<div style="max-width:520px;text-align:center;line-height:1.8">${err.message}</div>`;
  throw err;
}

const REFERENCE_KEYS = new Set( [
  'preset', 'scatterOn', 'distanceMm', 'strength', 'thicknessResponse',
  'maxThicknessMm', 'thinBoost', 'objectGate', 'depthTol', 'normalTol',
  'modelScale', 'exposure'
] );

const panel = new Panel( panelEl, state, {
  onChange: ( key, value, rerender ) => {
    panel.updateScatterTag();
    if ( key === 'preset' ) {
      lab.preset = PRESETS[ value ];
    }
    if ( key === 'resolutionScale' ) {
      resize();
    }
    if ( REFERENCE_KEYS.has( key ) ) {
      lab.invalidateReference();
      document.getElementById( 'metrics' ).hidden = true;
    }
    requestRender();
  },
  onReference: () => {
    lab.requestReference();
    requestRender();
    panel.setSaveStatus( '正在生成高质量参考…' );
  },
  onCompare: () => {
    const next = ! lab.showCompare;
    lab.setCompare( next );
    panel.setCompareActive( next );
    document.getElementById( 'splitLegend' ).hidden = ! next;
    requestRender();
  },
  onReset: () => {
    const fresh = defaultState();
    Object.assign( state, fresh );
    lab.preset = PRESETS[ fresh.preset ];
    lab.showCompare = false;
    lab.invalidateReference();
    panel.syncAll();
    panel.setCompareActive( false );
    document.getElementById( 'splitLegend' ).hidden = true;
    panel.setMetrics( null );
    panel.setSaveStatus( '已重置为初始参数' );
    resize();
    requestRender();
  },
  onSave: () => {
    const payload = saveState( state );
    panel.setSaveStatus( `已保存 ${new Date( payload.savedAt ).toLocaleTimeString( 'zh-CN' )}` );
  },
  onExport: () => {
    const payload = exportState( state );
    const blob = new Blob( [ JSON.stringify( payload, null, 2 ) ], { type: 'application/json' } );
    const url = URL.createObjectURL( blob );
    const a = document.createElement( 'a' );
    a.href = url;
    a.download = `wax-scatter-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL( url );
    panel.setSaveStatus( '已导出 JSON 存档' );
  },
  onImport: async ( file ) => {
    try {
      const text = await file.text();
      const next = importState( JSON.parse( text ) );
      Object.assign( state, next );
      lab.preset = PRESETS[ state.preset ];
      lab.showCompare = false;
      lab.invalidateReference();
      panel.syncAll();
      panel.setCompareActive( false );
      panel.setMetrics( null );
      document.getElementById( 'splitLegend' ).hidden = true;
      panel.setSaveStatus( `已导入 ${file.name}` );
      resize();
      requestRender();
    } catch ( err ) {
      panel.setSaveStatus( `导入失败：${err.message}` );
    }
  }
} );

panel.mount();
lab.onMetrics = ( stats ) => {
  panel.setMetrics( stats );
  panel.setSaveStatus( '高质量参考已生成' );
};

// ---------------------------------------------------------------- viewport

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  lab.resize( cssW, cssH, dpr );
  panel.setResolution( lab.width, lab.height );
  requestRender();
}

let pending = false;
function requestRender() {
  if ( pending ) return;
  pending = true;
  requestAnimationFrame( () => {
    pending = false;
    lab.renderFrame();
  } );
}

lab.onFrame = ( radius ) => {
  const el = document.getElementById( 'pixelRadiusOut' );
  if ( el && Number.isFinite( radius ) ) {
    el.textContent = `半径 ≈ ${Math.max( 1, radius ).toFixed( 0 )} px`;
  }
};

window.addEventListener( 'resize', resize );

// -------------------------------------------------------------- interaction

let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener( 'pointerdown', ( e ) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture( e.pointerId );
} );

canvas.addEventListener( 'pointermove', ( e ) => {
  if ( ! dragging ) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  lab.orbitBy( dx, dy );
  requestRender();
} );

canvas.addEventListener( 'pointerup', ( e ) => {
  dragging = false;
  canvas.releasePointerCapture?.( e.pointerId );
} );

canvas.addEventListener( 'wheel', ( e ) => {
  e.preventDefault();
  lab.zoomBy( e.deltaY > 0 ? 1.06 : 0.94 );
  requestRender();
}, { passive: false } );

// ---------------------------------------------------------------- exposure

let lastChip = 0;
let frames = 0;
function loop( t ) {
  frames ++;
  if ( t - lastChip > 600 ) {
    document.getElementById( 'chipFps' ).textContent =
      `${Math.round( frames * 1000 / ( t - lastChip ) )} fps`;
    frames = 0;
    lastChip = t;
  }
  requestAnimationFrame( loop );
}

resize();
lab.renderFrame();
document.getElementById( 'loading' ).classList.add( 'hidden' );
requestAnimationFrame( loop );

// exposed for automated verification and debugging; not used by the UI path
window.__lab = {
  lab, state, panel, CHANNELS,
  render: () => lab.renderFrame(),
  resize,
  requestReference: () => { lab.requestReference(); lab.renderFrame(); },
  setCompare: ( on ) => { lab.setCompare( on ); lab.renderFrame(); },
  readFinal: () => lab.readFinal(),
  readTarget: ( name, attachment ) => {
    const map = {
      gbuffer: lab.gbufferRT,
      separate: lab.separateRT,
      blurA: lab.blurA,
      blurB: lab.blurB,
      reference: lab.referenceRT,
      back: lab.backDepthRT
    };
    return lab.readTarget( map[ name ], attachment );
  },
  stats: () => lab.referenceStats
};
