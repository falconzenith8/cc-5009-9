import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;

function ensureUV( geometry ) {
  if ( geometry.attributes.uv ) return;
  const pos = geometry.attributes.position;
  const uv = new Float32Array( pos.count * 2 );
  for ( let i = 0; i < pos.count; i ++ ) {
    uv[ i * 2 ] = pos.getX( i ) * 1.6;
    uv[ i * 2 + 1 ] = pos.getY( i ) * 1.6;
  }
  geometry.setAttribute( 'uv', new THREE.BufferAttribute( uv, 2 ) );
}

// Tangent attribute is only needed for the textured model. Geometry without
// an index (Extrude) gets a stable fallback so the shader stays happy.
function ensureTangents( geometry ) {
  ensureUV( geometry );
  if ( ! geometry.attributes.normal ) geometry.computeVertexNormals();
  if ( geometry.index ) {
    try { geometry.computeTangents(); return geometry; } catch ( e ) { /* fall through */ }
  }
  const n = geometry.attributes.position.count;
  const t = new Float32Array( n * 4 );
  for ( let i = 0; i < n; i ++ ) {
    t[ i * 4 ] = 1; t[ i * 4 + 1 ] = 0; t[ i * 4 + 2 ] = 0; t[ i * 4 + 3 ] = 1;
  }
  geometry.setAttribute( 'tangent', new THREE.BufferAttribute( t, 4 ) );
  return geometry;
}

// Thin, warped ear-like sheet. The extruded rim is only a few millimetres
// thick, so it is the test case where transmitted light should glow through
// while a normal-incidence highlight stays crisp.
function createEarGeometry() {
  const shape = new THREE.Shape();
  const segments = 110;
  for ( let i = 0; i <= segments; i ++ ) {
    const a = ( i / segments ) * TAU;
    const r = 0.62 + 0.26 * Math.sin( a ) + 0.09 * Math.sin( a * 3.0 + 0.7 );
    const x = Math.cos( a ) * r * 0.94;
    const y = Math.sin( a ) * r * 1.42 + 0.05 * Math.sin( a * 2.0 );
    if ( i === 0 ) shape.moveTo( x, y ); else shape.lineTo( x, y );
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry( shape, {
    depth: 0.085,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize: 0.045,
    bevelSegments: 4,
    curveSegments: 2,
    steps: 1
  } );
  geo.center();

  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for ( let i = 0; i < pos.count; i ++ ) {
    v.set( pos.getX( i ), pos.getY( i ), pos.getZ( i ) );
    const bow = 0.26 * v.x * v.x - 0.13 * v.y * v.y;
    const taper = 1 - 0.30 * Math.abs( v.x / 0.75 ) * Math.abs( v.y / 1.0 );
    pos.setXYZ( i, v.x * taper, v.y, v.z + bow );
  }
  // ExtrudeGeometry is non-indexed. The existing normals would block the weld
  // (mergeVertices compares every attribute), so drop them first, weld, then
  // rebuild smooth normals on the indexed mesh.
  geo.deleteAttribute( 'normal' );
  const welded = mergeVertices( geo, 1e-4 );
  welded.computeVertexNormals();
  return ensureTangents( welded );
}

// Thick cylinder: its optical thickness along most view rays is far larger
// than the scattering length, so it must read as milky and opaque at the core.
// This is the control that proves the effect is thickness-driven, not a blur.
function createCylinderGeometry() {
  const geo = new THREE.CylinderGeometry( 0.44, 0.50, 1.5, 128, 24, false );
  const pos = geo.attributes.position;
  for ( let i = 0; i < pos.count; i ++ ) {
    const y = pos.getY( i ) / 0.75;
    const k = 1 + 0.03 * Math.cos( y * 2.2 );
    pos.setX( i, pos.getX( i ) * k );
    pos.setZ( i, pos.getZ( i ) * k );
  }
  geo.computeVertexNormals();
  return ensureTangents( geo );
}

// Textured test model: a turned, banded wax form. The ridges are real geometry
// in object space, so the relief scales with the model and cannot swim when
// the whole scene is rescaled.
function createTurnedGeometry() {
  const profile = [];
  const steps = 56;
  for ( let i = 0; i <= steps; i ++ ) {
    const t = i / steps;
    const y = ( t - 0.5 ) * 1.45;
    const ridge = 0.026 * Math.sin( t * TAU * 6.0 ) + 0.010 * Math.sin( t * TAU * 17.0 + 1.4 );
    const base = 0.42 * Math.pow( Math.sin( Math.PI * ( 0.10 + 0.80 * t ) ), 0.6 ) + 0.055;
    const r = Math.max( base + ridge, 0.05 );
    // The first and last rings collapse toward the axis, closing the shell so
    // the back-face prepass always has a surface to find.
    const capFade = Math.min( 1, t * 18, ( 1 - t ) * 18 );
    profile.push( new THREE.Vector2( t <= 1e-6 || t >= 1 - 1e-6 ? 0.002 : r * capFade + 0.002, y ) );
  }
  const geo = new THREE.LatheGeometry( profile, 160 );
  geo.computeVertexNormals();
  return ensureTangents( geo );
}

function makeWaxMaterial( lab, spec ) {
  const shared = lab.gbufferMaterial.uniforms;
  return new THREE.ShaderMaterial( {
    glslVersion: THREE.GLSL3,
    vertexShader: lab.gbufferMaterial.vertexShader,
    fragmentShader: lab.gbufferMaterial.fragmentShader,
    uniforms: {
      uUvScale: { value: new THREE.Vector2( spec.uvScale ?? 1, spec.uvScale ?? 1 ) },
      uUvOffset: { value: new THREE.Vector2( 0, 0 ) },
      uTangent: { value: new THREE.Vector3( 1, 0, 0 ) },
      uAlbedo: { value: new THREE.Color( '#e3d0ac' ) },
      uRoughness: { value: spec.roughness ?? 0.34 },
      uMetalness: { value: 0 },
      uSssEnabled: { value: 1 },
      uDiffuseEnabled: { value: 1 },
      uObjectId: { value: spec.id },
      uTextured: { value: spec.textured ? 1 : 0 },
      uBumpStrength: { value: spec.bump ?? 0.4 },
      uMarbleScale: { value: spec.marbleScale ?? 3.2 },
      uLightDir: shared.uLightDir,
      uLightColor: shared.uLightColor,
      uRimDir: shared.uRimDir,
      uRimColor: shared.uRimColor,
      uSkyColor: shared.uSkyColor,
      uGroundColor: shared.uGroundColor,
      uEnvIntensity: shared.uEnvIntensity
    }
  } );
}

// Polished metal ring, adjacent to but not touching the cylinder. It is the
// gating witness: it must stay glossy and receive zero diffusion even at a
// one-pixel gap.
function makeMetalMaterial( lab ) {
  const shared = lab.gbufferMaterial.uniforms;
  return new THREE.ShaderMaterial( {
    glslVersion: THREE.GLSL3,
    vertexShader: lab.gbufferMaterial.vertexShader,
    fragmentShader: lab.gbufferMaterial.fragmentShader,
    uniforms: {
      uUvScale: { value: new THREE.Vector2( 1, 1 ) },
      uUvOffset: { value: new THREE.Vector2( 0, 0 ) },
      uTangent: { value: new THREE.Vector3( 1, 0, 0 ) },
      uAlbedo: { value: new THREE.Color( 0.66, 0.60, 0.52 ) },
      uRoughness: { value: 0.18 },
      uMetalness: { value: 1 },
      uSssEnabled: { value: 0 },
      uDiffuseEnabled: { value: 0 },
      uObjectId: { value: 9 },
      uTextured: { value: 0 },
      uBumpStrength: { value: 0 },
      uMarbleScale: { value: 1 },
      uLightDir: shared.uLightDir,
      uLightColor: shared.uLightColor,
      uRimDir: shared.uRimDir,
      uRimColor: shared.uRimColor,
      uSkyColor: shared.uSkyColor,
      uGroundColor: shared.uGroundColor,
      uEnvIntensity: shared.uEnvIntensity
    }
  } );
}

export function buildScene( lab ) {
  const root = lab.modelRoot;
  root.clear();

  const specs = [
    {
      id: 1, name: 'thin-ear', geometry: createEarGeometry(),
      position: [ -1.35, 0.42, 0.28 ], rotation: [ -0.04, 0.55, 0.12 ],
      roughness: 0.32, textured: false, bump: 0.22
    },
    {
      id: 2, name: 'thick-cylinder', geometry: createCylinderGeometry(),
      position: [ 1.22, 0.10, -0.42 ], rotation: [ 0.02, -0.3, 0.02 ],
      roughness: 0.40, textured: false, bump: 0.18
    },
    {
      id: 3, name: 'textured-turn', geometry: createTurnedGeometry(),
      position: [ -0.02, 0.06, 1.32 ], rotation: [ 0, 0.24, 0 ],
      roughness: 0.36, textured: true, bump: 0.9, marbleScale: 3.6
    }
  ];

  const meshes = [];
  for ( const spec of specs ) {
    const material = makeWaxMaterial( lab, spec );
    const mesh = new THREE.Mesh( spec.geometry, material );
    mesh.position.fromArray( spec.position );
    mesh.rotation.fromArray( spec.rotation );
    mesh.name = spec.name;
    mesh.userData.kind = 'wax';
    mesh.userData.material = material;
    mesh.userData.objectId = spec.id;
    mesh.userData.textured = spec.textured;
    mesh.userData.bump = spec.bump;
    mesh.userData.marbleScale = spec.marbleScale;
    mesh.userData.roughnessBias = 0;
    root.add( mesh );
    meshes.push( mesh );
  }

  const ringGeo = new THREE.TorusGeometry( 0.72, 0.075, 28, 140 );
  ringGeo.rotateX( Math.PI / 2 );
  const ringMat = makeMetalMaterial( lab );
  const ring = new THREE.Mesh( ringGeo, ringMat );
  ring.position.set( 1.22, -0.86, -0.42 );
  ring.name = 'metal-ring';
  ring.userData.kind = 'metal';
  ring.userData.material = ringMat;
  ring.userData.objectId = 9;
  root.add( ring );

  return { meshes, ring };
}
