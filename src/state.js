// Persistent state, presets, and the save/restore contract for the lab.
//
// PARAM_SCHEMA is the single source of truth for the scattering kernel's
// parameters: defaults, ranges, units, UI labels and the DOM ids of the
// generated controls. The contract doc (docs/model-assumptions.md) is checked
// against this table by tools/check-contract.mjs — renaming a key here without
// updating the doc fails the check.

export const PARAM_SCHEMA = {
  scatterOn: {
    type: 'bool', default: true,
    unit: '—',
    label: '启用次表面散射'
  },
  distanceMm: {
    type: 'number', default: 3.4, min: 0.5, max: 20, step: 0.1,
    unit: 'mm', digits: 1, suffix: 'mm',
    label: '散射距离',
    hint: '以物理毫米为单位的平均自由程；渲染时按场景尺度换算到世界单位，再投影到屏幕像素。',
    control: { section: 'diffusionFields', input: 'distRange', out: 'distOut' }
  },
  strength: {
    type: 'number', default: 0.85, min: 0, max: 1, step: 0.01,
    unit: '无量纲', digits: 2,
    label: '散射强度',
    control: { section: 'diffusionFields', input: 'strengthRange', out: 'strengthOut' }
  },
  thicknessResponse: {
    type: 'number', default: 0.72, min: 0, max: 1, step: 0.01,
    unit: '无量纲', digits: 2,
    label: '厚度响应',
    hint: '薄处透光、厚处更乳浊：散射能量与扩散半径都随局部厚度响应。光学厚度 0.25–2.5 为过渡带。',
    control: { section: 'diffusionFields', input: 'thicknessRange', out: 'thicknessOut' }
  },
  maxThicknessMm: {
    type: 'number', default: 30, min: 4, max: 80, step: 1,
    unit: 'mm', digits: 0, suffix: 'mm',
    label: '厚度上限',
    hint: '视线厚度估计的钳制值（毫米）；超过上限的厚核按上限参与光学厚度计算。',
    control: { section: 'diffusionFields', input: 'maxThicknessRange', out: 'maxThicknessOut' }
  },
  thinBoost: {
    type: 'number', default: 0.55, min: 0, max: 1.5, step: 0.01,
    unit: '无量纲', digits: 2,
    label: '薄片扩散增益',
    hint: '薄壁处光在内部可走更远；增益只作用于光学厚度过渡带内的薄区域。',
    control: { section: 'diffusionFields', input: 'thinBoostRange', out: 'thinBoostOut' }
  },
  quality: {
    type: 'enum', values: [ 'low', 'med', 'high' ], default: 'med',
    unit: '—',
    label: '扩散质量',
    optionLabels: { low: '低 · 17 采样/轴', med: '中 · 33 采样/轴', high: '高 · 65 采样/轴' },
    control: { section: 'diffusionFields', select: 'qualitySelect', out: 'pixelRadiusOut' }
  },
  objectGate: {
    type: 'bool', default: true,
    unit: '—',
    label: '物体边界硬门控'
  },
  depthTol: {
    type: 'number', default: 0.42, min: 0, max: 1.5, step: 0.01,
    unit: '无量纲', digits: 2,
    label: '深度断层容差',
    control: { section: 'gateFields', input: 'depthTol', out: 'depthTolOut' }
  },
  normalTol: {
    type: 'number', default: 0.82, min: 0.4, max: 0.99, step: 0.01,
    unit: '无量纲', digits: 2,
    label: '法线一致性',
    control: { section: 'gateFields', input: 'normalTol', out: 'normalTolOut' }
  },
  modelScale: {
    type: 'number', default: 1, min: 0.45, max: 2.2, step: 0.01,
    unit: '×', digits: 2, suffix: '×',
    label: '模型整体缩放',
    control: { section: 'sceneFields', input: 'scaleRange', out: 'scaleOut', hintId: 'scaleNote' }
  },
  exposure: {
    type: 'number', default: 1, min: 0.3, max: 2.4, step: 0.01,
    unit: '×', digits: 2,
    label: '曝光',
    control: { section: 'sceneFields', input: 'exposureRange', out: 'exposureOut' }
  },
  resolutionScale: {
    type: 'number', default: 1, min: 0.5, max: 1.75, step: 0.05,
    unit: '×',
    label: '预览分辨率'
  },
  channel: {
    type: 'enum', values: [
      'final', 'surface', 'diffuse', 'specular', 'scatter', 'normalShade',
      'albedo', 'normal', 'depth', 'thickness', 'mask', 'objectid'
    ], default: 'final',
    unit: '—',
    label: '显示通道',
    optionLabels: {
      final: '最终合成',
      surface: '表面层（关闭散射）',
      diffuse: '直接漫反射',
      specular: '直接高光 / 反射',
      scatter: '扩散光照',
      normalShade: '法线着色',
      albedo: '漫反射反照率',
      normal: '世界法线',
      depth: '线性深度',
      thickness: '厚度',
      mask: '扩散掩码',
      objectid: '物体 ID'
    }
  },
  preset: {
    type: 'enum', values: [ 'pale', 'amber', 'rose', 'ivory' ], default: 'pale',
    unit: '—',
    label: '蜡材样本'
  }
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
      thinBandOptical: '薄壳过渡带为光学厚度 0.25–2.5（光学厚度 = 厚度mm ÷ 散射距离mm）。',
      limitation: '可见表面屏幕空间近似：背向表面光传输不参与计算。',
      contract: 'docs/model-assumptions.md'
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
