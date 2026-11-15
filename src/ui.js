// Canvas-based UI. Controls are generated from PARAM_SCHEMA — the scattering
// kernel's parameter table is the single source of truth, so a rename or a
// range change in the kernel propagates here instead of drifting in markup.
import { PARAM_SCHEMA, PRESETS } from './state.js';

const fmt = ( v, digits = 2 ) => Number( v ).toFixed( digits );

function fmtFor( def ) {
  const digits = def.digits ?? 2;
  const suffix = def.suffix ? ` ${def.suffix}` : '';
  return ( v ) => `${fmt( v, digits )}${suffix}`;
}

// Build one slider field (.field > .field-label + input[type=range] + hint).
function buildSliderField( key, def ) {
  const c = def.control;
  const field = document.createElement( 'div' );
  field.className = 'field';

  const labelRow = document.createElement( 'div' );
  labelRow.className = 'field-label';
  const label = document.createElement( 'label' );
  label.htmlFor = c.input;
  label.textContent = def.label;
  const out = document.createElement( 'output' );
  out.id = c.out;
  labelRow.append( label, out );

  const input = document.createElement( 'input' );
  input.type = 'range';
  input.id = c.input;
  input.min = def.min;
  input.max = def.max;
  input.step = def.step;
  input.value = def.default;

  field.append( labelRow, input );

  if ( def.hint || c.hintId ) {
    const hint = document.createElement( 'p' );
    hint.className = 'hint';
    if ( c.hintId ) hint.id = c.hintId;
    hint.textContent = def.hint ?? '—';
    field.append( hint );
  }
  return { field, input, out };
}

// Build one select field; options come from the schema enum + optionLabels.
function buildSelectField( key, def ) {
  const c = def.control;
  const field = document.createElement( 'div' );
  field.className = 'field';

  const labelRow = document.createElement( 'div' );
  labelRow.className = 'field-label';
  const label = document.createElement( 'label' );
  label.htmlFor = c.select;
  label.textContent = def.label;
  labelRow.append( label );
  let out = null;
  if ( c.out ) {
    out = document.createElement( 'output' );
    out.id = c.out;
    labelRow.append( out );
  }

  const select = document.createElement( 'select' );
  select.id = c.select;
  for ( const value of def.values ) {
    const option = document.createElement( 'option' );
    option.value = value;
    option.textContent = def.optionLabels?.[ value ] ?? value;
    select.append( option );
  }
  select.value = def.default;

  field.append( labelRow, select );
  return { field, select, out };
}

export class Panel {
  constructor( root, state, callbacks ) {
    this.root = root;
    this.state = state;
    this.cb = callbacks;
    this.refs = {};
  }

  // Generate the schema-driven fields into their section containers.
  buildControls() {
    for ( const [ key, def ] of Object.entries( PARAM_SCHEMA ) ) {
      const c = def.control;
      if ( ! c ) continue;
      const container = document.getElementById( c.section );
      if ( ! container ) continue;
      if ( c.input ) {
        const { field, input, out } = buildSliderField( key, def );
        container.append( field );
        const label = fmtFor( def );
        input.addEventListener( 'input', () => {
          const v = Number( input.value );
          out.textContent = label( v );
          this.set( key, v );
          if ( key === 'modelScale' ) this.syncScaleNote();
        } );
        this.refs[ key ] = { input, out, label };
      } else if ( c.select ) {
        const { field, select, out } = buildSelectField( key, def );
        container.append( field );
        select.addEventListener( 'change', () => {
          const value = def.type === 'number' ? Number( select.value ) : select.value;
          this.set( key, value );
        } );
        this.refs[ key ] = { select, out };
      }
    }
  }

  mount() {
    const $ = ( id ) => document.getElementById( id );
    const state = this.state;

    this.buildControls();

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

    // ---- channel options (from the kernel's channel list) ---------------
    const channelDef = PARAM_SCHEMA.channel;
    const channel = $( 'channelSelect' );
    channel.innerHTML = channelDef.values
      .map( ( v ) => `<option value="${v}">${channelDef.optionLabels[ v ]}</option>` ).join( '' );
    channel.value = state.channel;
    channel.addEventListener( 'change', () => this.set( 'channel', channel.value ) );

    // ---- resolution (static subset of the schema range) -----------------
    const resolution = $( 'resolutionSelect' );
    resolution.value = String( state.resolutionScale );
    resolution.addEventListener( 'change', () => {
      this.set( 'resolutionScale', Number( resolution.value ) );
    } );

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
    this.refs.selfcheckTag = $( 'selfcheckTag' );
    this.refs.selfcheckList = $( 'selfcheckList' );

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
    $( 'resolutionSelect' ).value = String( s.resolutionScale );
    $( 'channelSelect' ).value = s.channel;
    $( 'objectGate' ).checked = s.objectGate;

    for ( const [ key, ref ] of Object.entries( this.refs ) ) {
      if ( ! ref ) continue;
      if ( ref.input ) {
        ref.input.value = s[ key ];
        ref.out.textContent = ref.label( s[ key ] );
      } else if ( ref.select ) {
        ref.select.value = String( s[ key ] );
      }
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

  // Kernel self-check results are shown inside the lab itself: a failed check
  // feeds back into the wax-scattering preview instead of only a log file.
  setSelfcheck( checks ) {
    const tag = this.refs.selfcheckTag;
    const list = this.refs.selfcheckList;
    if ( ! tag || ! list ) return;
    const failed = checks.filter( ( c ) => ! c.pass );
    tag.textContent = failed.length === 0 ? `${checks.length} 项通过` : `${failed.length} 项失败`;
    tag.classList.toggle( 'off', failed.length > 0 );
    list.innerHTML = checks
      .map( ( c ) => `<li class="${c.pass ? 'ok' : 'fail'}"><span>${c.pass ? '✓' : '✗'}</span><div><b>${c.name}</b><i>${c.detail}</i></div></li>` )
      .join( '' );
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
