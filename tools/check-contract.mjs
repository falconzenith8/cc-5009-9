// Static contract checker: docs/model-assumptions.md ↔ src/state.js ↔
// src/renderer.js ↔ src/shaders/* ↔ index.html ↔ package.json.
//
// Rename a parameter, change a default, or adjust an approximation range in
// the code without updating the contract doc (or vice versa) and this script
// fails, naming every inconsistency. No browser needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARAM_SCHEMA } from '../src/state.js';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const read = ( rel ) => fs.readFileSync( path.join( ROOT, rel ), 'utf8' );

const DOC = read( 'docs/model-assumptions.md' );
const RENDERER = read( 'src/renderer.js' );
const PASSES = read( 'src/shaders/passes.js' );
const COMMON = read( 'src/shaders/common.js' );
const HTML = read( 'index.html' );
const UI = read( 'src/ui.js' );
const MAIN = read( 'src/main.js' );
const PKG = JSON.parse( read( 'package.json' ) );

const problems = [];
const notes = [];
const bad = ( msg ) => problems.push( msg );
const ok = ( msg ) => notes.push( msg );

// ------------------------------------------------------------- table parsing
function tableAfter( heading ) {
  const idx = DOC.indexOf( heading );
  if ( idx < 0 ) return null;
  const lines = DOC.slice( idx ).split( '\n' ).slice( 1 );
  const rows = [];
  for ( const line of lines ) {
    const t = line.trim();
    if ( t.startsWith( '|' ) ) { rows.push( t ); continue; }
    if ( rows.length > 0 ) break;
  }
  if ( rows.length < 2 ) return null;
  return rows
    .filter( ( r ) => ! /^\|[\s\-|]+\|$/.test( r ) )
    .slice( 1 ) // drop the header row
    .map( ( r ) => r.split( '|' ).slice( 1, -1 ).map( ( c ) => c.trim() ) );
}

// -------------------------------------------------- 1. parameter table ↔ schema
const paramRows = tableAfter( '## 参数契约表' );
if ( ! paramRows ) {
  bad( '文档缺少「## 参数契约表」或表格无法解析' );
} else {
  const docParams = new Map();
  for ( const row of paramRows ) {
    const [ name, unit, def, range ] = row;
    docParams.set( name, { unit, def, range } );
  }

  for ( const key of Object.keys( PARAM_SCHEMA ) ) {
    if ( ! docParams.has( key ) ) {
      bad( `代码参数「${key}」未登记在文档参数表中（新增/改名后请同步 docs/model-assumptions.md）` );
    }
  }
  for ( const [ name, cell ] of docParams ) {
    const def = PARAM_SCHEMA[ name ];
    if ( ! def ) {
      bad( `文档参数「${name}」在 PARAM_SCHEMA 中不存在（参数是否已改名？）` );
      continue;
    }
    if ( cell.unit !== def.unit ) {
      bad( `「${name}」单位不一致：文档「${cell.unit}」 vs 代码「${def.unit}」` );
    }
    if ( def.type === 'bool' ) {
      if ( cell.def !== String( def.default ) ) {
        bad( `「${name}」默认值不一致：文档「${cell.def}」 vs 代码「${def.default}」` );
      }
      if ( cell.range !== 'true/false' ) {
        bad( `「${name}」范围应为「true/false」，文档写作「${cell.range}」` );
      }
    } else if ( def.type === 'enum' ) {
      if ( cell.def !== def.default ) {
        bad( `「${name}」默认值不一致：文档「${cell.def}」 vs 代码「${def.default}」` );
      }
      if ( cell.range !== def.values.join( '/' ) ) {
        bad( `「${name}」枚举值不一致：文档「${cell.range}」 vs 代码「${def.values.join( '/' )}」` );
      }
    } else {
      if ( Math.abs( Number( cell.def ) - def.default ) > 1e-9 ) {
        bad( `「${name}」默认值不一致：文档「${cell.def}」 vs 代码「${def.default}」` );
      }
      const m = cell.range.match( /^(-?[\d.]+)\.\.(-?[\d.]+)$/ );
      if ( ! m ) {
        bad( `「${name}」范围格式应为「最小..最大」，文档写作「${cell.range}」` );
      } else {
        if ( Math.abs( Number( m[ 1 ] ) - def.min ) > 1e-9 ) {
          bad( `「${name}」下限不一致：文档「${m[ 1 ]}」 vs 代码「${def.min}」` );
        }
        if ( Math.abs( Number( m[ 2 ] ) - def.max ) > 1e-9 ) {
          bad( `「${name}」上限不一致：文档「${m[ 2 ]}」 vs 代码「${def.max}」` );
        }
      }
    }
  }
  ok( `参数表核对：${Object.keys( PARAM_SCHEMA ).length} 个参数`);
}

// ---------------------------------------------------- 2. constants ↔ shader code
const constRows = tableAfter( '## 内核常量' );
const docConsts = new Map();
if ( ! constRows ) {
  bad( '文档缺少「## 内核常量」或表格无法解析' );
} else {
  for ( const row of constRows ) docConsts.set( row[ 0 ], row[ 1 ] );
}

function expectConst( name, actual ) {
  const docVal = docConsts.get( name );
  if ( docVal === undefined ) {
    bad( `内核常量「${name}」未登记在文档常量表中` );
    return;
  }
  if ( docVal.replace( /\s/g, '' ) !== String( actual ).replace( /\s/g, '' ) ) {
    bad( `常量「${name}」不一致：文档「${docVal}」 vs 实现「${actual}」` );
  }
}

const mWorld = RENDERER.match( /const WORLD_PER_MM = ([\d.]+)/ );
const mRadius = RENDERER.match( /const RADIUS_SCALE = ([\d.]+)/ );
const mTaps = RENDERER.match( /const TAPS = \{\s*low:\s*(\d+),\s*med:\s*(\d+),\s*high:\s*(\d+)\s*\}/ );
if ( ! mWorld ) bad( '无法在 renderer.js 解析 WORLD_PER_MM' );
if ( ! mRadius ) bad( '无法在 renderer.js 解析 RADIUS_SCALE' );
if ( ! mTaps ) bad( '无法在 renderer.js 解析 TAPS' );
if ( mWorld ) expectConst( 'WORLD_PER_MM', mWorld[ 1 ] );
if ( mRadius ) expectConst( 'RADIUS_SCALE', mRadius[ 1 ] );
if ( mTaps ) {
  const taps = [ Number( mTaps[ 1 ] ), Number( mTaps[ 2 ] ), Number( mTaps[ 3 ] ) ];
  expectConst( 'TAPS_PER_AXIS', taps.join( '/' ) );
  expectConst( 'SAMPLES_PER_AXIS', taps.map( ( t ) => 2 * t + 1 ).join( '/' ) );

  // The quality option labels in the schema must quote the same sample counts.
  const labels = PARAM_SCHEMA.quality.optionLabels ?? {};
  const want = [ 2 * taps[ 0 ] + 1, 2 * taps[ 1 ] + 1, 2 * taps[ 2 ] + 1 ];
  [ 'low', 'med', 'high' ].forEach( ( q, i ) => {
    const label = labels[ q ] ?? '';
    if ( ! label.includes( String( want[ i ] ) ) ) {
      bad( `quality 选项「${q}」文案「${label}」与 TAPS 推导的 ${want[ i ]} 采样/轴不符` );
    }
  } );
}

const bands = [ ...PASSES.matchAll( /smoothstep\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*optical\s*\)/g ) ]
  .map( ( m ) => `${m[ 1 ]}..${m[ 2 ]}` );
if ( bands.length === 0 ) {
  bad( '无法在 passes.js 解析薄壳过渡带 smoothstep(a, b, optical)' );
} else {
  if ( new Set( bands ).size !== 1 ) {
    bad( `薄壳过渡带在 passes.js 中不一致：${bands.join( ' vs ' )}` );
  }
  expectConst( 'THIN_BAND_OPTICAL', bands[ 0 ] );
}

const mP1 = COMMON.match( /return\s+([\d.]+)\s*\*\s*exp\(\s*-r\s*\/\s*s\s*\)\s*\+\s*([\d.]+)\s*\*\s*exp\(\s*-r\s*\/\s*\(\s*([\d.]+)\s*\*\s*s\s*\)\s*\)/ );
if ( ! mP1 ) {
  bad( '无法在 common.js 解析 PROFILE_1D 系数' );
} else {
  expectConst( 'PROFILE_1D', `${mP1[ 1 ]}/${mP1[ 2 ]}@${mP1[ 3 ]}` );
}
const mP2 = COMMON.match( /\(\s*([\d.]+)\s*\*\s*exp\(\s*-r\s*\/\s*s\s*\)\s*\+\s*([\d.]+)\s*\*\s*exp\(\s*-r\s*\/\s*\(\s*([\d.]+)\s*\*\s*s\s*\)\s*\)\s*\)\s*\/\s*\(\s*1\.0\s*\+\s*r\s*\/\s*s\s*\)/ );
if ( ! mP2 ) {
  bad( '无法在 common.js 解析 PROFILE_2D 系数' );
} else {
  expectConst( 'PROFILE_2D', `${mP2[ 1 ]}/${mP2[ 2 ]}@${mP2[ 3 ]}` );
}
ok( '内核常量核对完成' );

// ------------------------------------ 3. kernel uniforms must init from schema
for ( const key of [
  'distanceMm', 'thicknessResponse', 'maxThicknessMm', 'strength',
  'normalTol', 'thinBoost', 'exposure', 'scatterOn', 'objectGate'
] ) {
  if ( ! RENDERER.includes( `value: P.${key}` ) ) {
    bad( `renderer.js 中 ${key} 对应的 uniform 初值未取自 PARAM_SCHEMA（缺少 value: P.${key}），默认值可能漂移` );
  }
}
if ( ! RENDERER.includes( 'TAPS[ P.quality ]' ) ) {
  bad( 'renderer.js 中 uTaps 初值未取自 TAPS[ P.quality ]' );
}
ok( 'uniform 初值来源核对完成' );

// ------------------------------------------------- 4. index.html mount points
for ( const id of [
  'diffusionFields', 'gateFields', 'sceneFields',
  'presetSelect', 'channelSelect', 'resolutionSelect',
  'scatterToggle', 'objectGate', 'selfcheckList', 'selfcheckTag'
] ) {
  if ( ! HTML.includes( `id="${id}"` ) ) {
    bad( `index.html 缺少挂载点 id="${id}"` );
  }
}

// Generated control ids must NOT remain as stale static markup.
for ( const [ key, def ] of Object.entries( PARAM_SCHEMA ) ) {
  const c = def.control;
  if ( ! c ) continue;
  for ( const id of [ c.input, c.out, c.select, c.hintId ].filter( Boolean ) ) {
    if ( HTML.includes( `id="${id}"` ) ) {
      bad( `index.html 仍静态包含应由 schema 生成的控件 id="${id}"（${key}）——陈旧标记` );
    }
  }
}
if ( HTML.includes( 'irradiance' ) ) {
  bad( 'index.html 仍包含已移除的「irradiance」通道选项（陈旧）' );
}
if ( ! /<select id="channelSelect"><\/select>/.test( HTML ) ) {
  bad( 'channelSelect 应为空壳，选项由 PARAM_SCHEMA.channel 生成' );
}

// resolutionSelect options must stay inside the schema range and offer default.
{
  const m = HTML.match( /<select id="resolutionSelect">([\s\S]*?)<\/select>/ );
  const def = PARAM_SCHEMA.resolutionScale;
  if ( ! m ) {
    bad( 'index.html 缺少 resolutionSelect' );
  } else {
    const vals = [ ...m[ 1 ].matchAll( /value="([\d.]+)"/g ) ].map( ( x ) => Number( x[ 1 ] ) );
    for ( const v of vals ) {
      if ( v < def.min - 1e-9 || v > def.max + 1e-9 ) {
        bad( `resolutionSelect 选项 ${v} 超出 schema 范围 ${def.min}..${def.max}` );
      }
    }
    if ( ! vals.includes( def.default ) ) {
      bad( `resolutionSelect 缺少默认值 ${def.default} 选项` );
    }
  }
}
ok( 'index.html 挂载点核对完成' );

// ------------------------------------------- 5. schema control ids are coherent
{
  const ids = new Map();
  for ( const [ key, def ] of Object.entries( PARAM_SCHEMA ) ) {
    const c = def.control;
    if ( ! c ) continue;
    for ( const id of [ c.input, c.out, c.select ].filter( Boolean ) ) {
      if ( ids.has( id ) ) bad( `控件 id「${id}」被「${ids.get( id )}」与「${key}」重复使用` );
      ids.set( id, key );
    }
    if ( c.section && ! HTML.includes( `id="${c.section}"` ) ) {
      bad( `「${key}」指定了界面中不存在的挂载容器 id="${c.section}"` );
    }
  }
  if ( ! UI.includes( 'PARAM_SCHEMA' ) || ! UI.includes( 'buildControls' ) ) {
    bad( 'ui.js 未从 PARAM_SCHEMA 生成控件（控件必须由内核参数表驱动）' );
  }
  if ( ! MAIN.includes( 'runSelfcheck' ) || ! MAIN.includes( 'setSelfcheck' ) ) {
    bad( 'main.js 未接入内核自检（失败必须反馈回预览界面）' );
  }
  ok( '控件 id 与自检接线核对完成' );
}

// ------------------------------------------------- 6. package.json entry points
{
  const s = PKG.scripts ?? {};
  if ( s.contract !== 'node tools/check-contract.mjs' ) {
    bad( 'package.json 缺少 "contract": "node tools/check-contract.mjs"' );
  }
  if ( ! s.assumptions || ! s.assumptions.includes( 'verify-contract.mjs' ) || ! s.assumptions.includes( 'assumptions.mjs' ) ) {
    bad( 'package.json 的 "assumptions" 入口应串联 verify-contract.mjs 与 assumptions.mjs' );
  }
  if ( s.verify !== 'node tools/verify.mjs' ) {
    bad( 'package.json 缺少 "verify": "node tools/verify.mjs"（既有流程入口不可破坏）' );
  }
  ok( '维护入口核对完成' );
}

// ------------------------------------------------------------------- report
console.log( `契约静态核对：${notes.length} 组检查` );
for ( const n of notes ) console.log( `  · ${n}` );
if ( problems.length > 0 ) {
  console.error( `\n发现 ${problems.length} 处不一致：` );
  for ( const p of problems ) console.error( `  ✗ ${p}` );
  process.exitCode = 1;
} else {
  console.log( '\n全部一致：文档、默认配置、内核常量与界面挂载点互相对齐。' );
}
