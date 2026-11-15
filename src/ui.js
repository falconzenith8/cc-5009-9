// Canvas-based UI. Every control writes to shared state and re-renders.
import { PRESETS } from './state.js';

const fmt = ( v, digits = 2 ) => Number( v ).toFixed( digits );

export class Panel {
  constructor( root, state, callbacks ) {
    this.root = root;
    this.state = state;
    this.cb = callbacks;
    this.refs = {};
  }

  mount() {
    const $ = ( id ) => document.getElementById( id );
    const state = this.state;

    // ---- scatter toggle -------------------------------------------------
    const toggle = $( 'scatterToggle' );
    toggle.checked = state.scatterOn;
    toggle.addEventListener( 'change', () => {
      this.set( 'scatterOn', toggle.checked );
    } );
    this.refs.scatterStateTag = $( 'scatterStateTag' );

    // ---- preset ---------------------------------------------------------
    const preset = $( 'presetSelect' );
    preset.innerHTML = Object.entries( PRESETS )
      .map( ( [ id, p ] ) => `<option value="${id}">${p.label}</option>` ).join( '' );
    preset.value = state.preset;
    preset.addEventListener( 'change', () => this.set( 'preset', preset.value ) );

    // ---- sliders --------------------------------------------------------
    const sliders = [
      [ 'distRange', 'distanceMm', 'distOut', ( v ) => `${fmt( v, 1 )} mm` ],
      [ 'strengthRange', 'strength', 'strengthOut', ( v ) => fmt( v, 2 ) ],
      [ 'thicknessRange', 'thicknessResponse', 'thicknessOut', ( v ) => fmt( v, 2 ) ],
      [ 'thinBoostRange', 'thinBoost', 'thinBoostOut', ( v ) => fmt( v, 2 ) ],
      [ 'depthTol', 'depthTol', 'depthTolOut', ( v ) => fmt( v, 2 ) ],
      [ 'normalTol', 'normalTol', 'normalTolOut', ( v ) => fmt( v, 2 ) ],
      [ 'scaleRange', 'modelScale', 'scaleOut', ( v ) => `${fmt( v, 2 )}×` ],
      [ 'exposureRange', 'exposure', 'exposureOut', ( v ) => fmt( v, 2 ) ]
    ];
    for ( const [ inputId, key, outId, label ] of sliders ) {
      const input = $( inputId );
      const out = $( outId );
      input.value = state[ key ];
      out.textContent = label( state[ key ] );
      input.addEventListener( 'input', () => {
        const v = Number( input.value );
        out.textContent = label( v );
        this.set( key, v );
        if ( key === 'modelScale' ) this.syncScaleNote();
      } );
      this.refs[ key ] = { input, out, label };
    }

    // ---- selects --------------------------------------------------------
    const quality = $( 'qualitySelect' );
    quality.value = state.quality;
    quality.addEventListener( 'change', () => this.set( 'quality', quality.value ) );

    const resolution = $( 'resolutionSelect' );
    resolution.value = String( state.resolutionScale );
    resolution.addEventListener( 'change', () => {
      this.set( 'resolutionScale', Number( resolution.value ) );
    } );

    const channel = $( 'channelSelect' );
    channel.value = state.channel;
    channel.addEventListener( 'change', () => this.set( 'channel', channel.value ) );

    // ---- gates ----------------------------------------------------------
    const objectGate = $( 'objectGate' );
    objectGate.checked = state.objectGate;
    objectGate.addEventListener( 'change', () => this.set( 'objectGate', objectGate.checked ) );

    // ---- actions --------------------------------------------------------
    $( 'computeRefBtn' ).addEventListener( 'click', () => this.cb.onReference() );
    $( 'compareBtn' ).addEventListener( 'click', () => this.cb.onCompare() );
    $( 'resetBtn' ).addEventListener( 'click', () => this.cb.onReset() );
    $( 'saveBtn' ).addEventListener( 'click', () => this.cb.onSave() );
    $( 'exportBtn' ).addEventListener( 'click', () => this.cb.onExport() );
    $( 'importInput' ).addEventListener( 'change', ( e ) => {
      const file = e.target.files?.[ 0 ];
      if ( file ) this.cb.onImport( file );
      e.target.value = '';
    } );

    const collapse = $( 'collapseBtn' );
    collapse.addEventListener( 'click', ( e ) => {
      // The header has its own reopen handler; stop the bubble so the explicit
      // button's toggle is not immediately undone.
      e.stopPropagation();
      this.root.classList.toggle( 'collapsed' );
    } );
    // When collapsed the explicit button is hidden, so the whole header acts
    // as the reopen affordance.
    this.root.querySelector( '.panel-head' ).addEventListener( 'click', () => {
      if ( this.root.classList.contains( 'collapsed' ) ) this.root.classList.remove( 'collapsed' );
    } );

    // A 300 px panel covers most of the model on small screens; start folded.
    if ( window.innerWidth < 900 ) this.root.classList.add( 'collapsed' );

    this.refs.compareBtn = $( 'compareBtn' );
    this.refs.metrics = $( 'metrics' );
    this.refs.metricMae = $( 'metricMae' );
    this.refs.metricPsnr = $( 'metricPsnr' );
    this.refs.metricPixels = $( 'metricPixels' );
    this.refs.saveStatus = $( 'saveStatus' );
    this.refs.chipRes = $( 'chipRes' );
    this.refs.pixelRadiusOut = $( 'pixelRadiusOut' );

    this.syncScaleNote();
    this.syncAll();
  }

  set( key, value, rerender = true ) {
    if ( this.state[ key ] === value ) return;
    this.state[ key ] = value;
    this.cb.onChange( key, value, rerender );
  }

  syncScaleNote() {
    const mm = ( 10 / this.state.modelScale ).toFixed( 1 );
    const note = document.getElementById( 'scaleNote' );
    if ( note ) note.textContent = `当前 1 世界单位 ≈ ${mm} mm`;
  }

  // Full refresh from state (used by reset / import / preset sync).
  syncAll() {
    const s = this.state;
    const $ = ( id ) => document.getElementById( id );
    $( 'scatterToggle' ).checked = s.scatterOn;
    $( 'presetSelect' ).value = s.preset;
    $( 'qualitySelect' ).value = s.quality;
    $( 'resolutionSelect' ).value = String( s.resolutionScale );
    $( 'channelSelect' ).value = s.channel;
    $( 'objectGate' ).checked = s.objectGate;

    for ( const [ key, ref ] of Object.entries( this.refs ) ) {
      if ( ! ref || ! ref.input ) continue;
      ref.input.value = s[ key ];
      ref.out.textContent = ref.label( s[ key ] );
    }
    this.updateScatterTag();
    this.syncScaleNote();
  }

  updateScatterTag() {
    const tag = this.refs.scatterStateTag;
    if ( ! tag ) return;
    tag.textContent = this.state.scatterOn ? 'ON' : 'OFF';
    tag.classList.toggle( 'off', ! this.state.scatterOn );
  }

  setMetrics( stats ) {
    if ( ! stats ) {
      this.refs.metrics.hidden = true;
      return;
    }
    this.refs.metrics.hidden = false;
    this.refs.metricMae.textContent = stats.mae.toFixed( 4 );
    this.refs.metricPsnr.textContent = stats.psnr >= 90 ? '∞' : `${stats.psnr.toFixed( 2 )} dB`;
    this.refs.metricPixels.textContent = stats.pixels.toLocaleString( 'en-US' );
  }

  setSaveStatus( text ) {
    this.refs.saveStatus.textContent = text;
  }

  setResolution( w, h ) {
    this.refs.chipRes.textContent = `${w} × ${h}`;
  }

  setCompareActive( on ) {
    this.refs.compareBtn.classList.toggle( 'active', on );
  }
}
