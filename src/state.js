// Persistent state, presets, and the save/restore contract for the lab.

export const PARAM_SCHEMA = {
  scatterOn: { type: 'bool', default: true },
  distanceMm: { type: 'number', default: 3.4, min: 0.5, max: 20, step: 0.1 },
  strength: { type: 'number', default: 0.85, min: 0, max: 1, step: 0.01 },
  thicknessResponse: { type: 'number', default: 0.72, min: 0, max: 1, step: 0.01 },
  maxThicknessMm: { type: 'number', default: 30, min: 4, max: 80, step: 1 },
  thinBoost: { type: 'number', default: 0.55, min: 0, max: 1.5, step: 0.01 },
  quality: { type: 'enum', values: [ 'low', 'med', 'high' ], default: 'med' },
  objectGate: { type: 'bool', default: true },
  depthTol: { type: 'number', default: 0.42, min: 0, max: 1.5, step: 0.01 },
  normalTol: { type: 'number', default: 0.82, min: 0.4, max: 0.99, step: 0.01 },
  modelScale: { type: 'number', default: 1, min: 0.45, max: 2.2, step: 0.01 },
  exposure: { type: 'number', default: 1, min: 0.3, max: 2.4, step: 0.01 },
  resolutionScale: { type: 'number', default: 1, min: 0.5, max: 1.75, step: 0.05 },
  channel: { type: 'enum', values: [
    'final', 'surface', 'diffuse', 'specular', 'scatter', 'normalShade',
    'albedo', 'normal', 'depth', 'thickness', 'mask', 'objectid'
  ], default: 'final' },
  preset: { type: 'enum', values: [ 'pale', 'amber', 'rose', 'ivory' ], default: 'pale' }
};

export const PRESETS = {
  pale: { label: '浅蜂蜡', albedo: '#e4d1ad', roughness: 0.34, sss: true },
  amber: { label: '琥珀蜡', albedo: '#d29a52', roughness: 0.42, sss: true },
  rose: { label: '蔷薇蜡', albedo: '#d9a096', roughness: 0.46, sss: true },
  ivory: { label: '象牙蜡', albedo: '#e9e2d3', roughness: 0.28, sss: true }
};

const STORAGE_KEY = 'wax-scatter-lab:v1';

export function defaultState() {
  const s = {};
  for ( const [ key, def ] of Object.entries( PARAM_SCHEMA ) ) s[ key ] = def.default;
  return s;
}

export function sanitize( raw ) {
  const out = defaultState();
  if ( ! raw || typeof raw !== 'object' ) return out;
  for ( const [ key, def ] of Object.entries( PARAM_SCHEMA ) ) {
    if ( ! ( key in raw ) ) continue;
    const v = raw[ key ];
    if ( def.type === 'bool' ) out[ key ] = !! v;
    else if ( def.type === 'number' ) {
      const n = Number( v );
      if ( Number.isFinite( n ) ) out[ key ] = Math.min( def.max, Math.max( def.min, n ) );
    } else if ( def.type === 'enum' && def.values.includes( v ) ) {
      out[ key ] = v;
    }
  }
  return out;
}

export function loadState() {
  try {
    const raw = localStorage.getItem( STORAGE_KEY );
    if ( ! raw ) return defaultState();
    return sanitize( JSON.parse( raw ) );
  } catch ( e ) {
    return defaultState();
  }
}

export function saveState( state ) {
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    params: state,
    presetId: state.preset,
    preset: PRESETS[ state.preset ]
  };
  localStorage.setItem( STORAGE_KEY, JSON.stringify( payload ) );
  return payload;
}

export function exportState( state ) {
  const payload = {
    format: 'wax-scatter-lab',
    version: 1,
    exportedAt: new Date().toISOString(),
    params: state,
    preset: PRESETS[ state.preset ],
    notes: {
      units: '散射距离与厚度以毫米为单位；模型缩放 1 时 1 世界单位 = 10 mm。',
      limitation: '可见表面屏幕空间近似：背向表面光传输不参与计算。'
    }
  };
  return payload;
}

export function importState( obj ) {
  if ( ! obj || typeof obj !== 'object' ) throw new Error( '文件不是有效的 JSON 对象' );
  const raw = obj.params ?? obj;
  const state = sanitize( raw );
  return state;
}
