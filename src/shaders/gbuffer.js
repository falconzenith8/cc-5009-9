import { DEPTH_HELPERS, PROFILE_HELPERS } from './common.js';

// ---------------------------------------------------------------------------
// Pass 1 — opaque scene into 4 MRT attachments.
//
//   MRT0  rgb direct reflection (GGX specular + broad environment)
//         a   metalness
//   MRT1  rgb diffusible irradiance (diffuse-capable, non-metal surfaces)
//         a   reserved
//   MRT2  rgb world normal
//         a   linear view depth
//   MRT3  rgb albedo (*)
//         a   objectId + flags / 64
//
// flags: bit0 diffuseEnabled, bit1 sssEnabled, bit2 metal, bit3 textured
//
// Direct reflection and diffusible irradiance are stored in different
// attachments. The diffusion pass reads MRT1 alone, so specular highlights,
// the background and metals are structurally excluded instead of being
// masked after a full-screen blur.
// ---------------------------------------------------------------------------
export const GBUFFER_VERT = /* glsl */`
out vec2 vUv;
out vec3 vWorldPos;
out vec3 vWorldNormal;
out vec2 vObjectUV;
out mat3 vTBN;

uniform vec2 uUvScale;
uniform vec2 uUvOffset;
uniform vec3 uTangent;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  vec3 n = normalize( normalMatrix * normal );
  vWorldNormal = normalize( mat3( modelMatrix ) * normal );
  vObjectUV = uv * uUvScale + uUvOffset;
  vec3 t = normalize( uTangent );
  vTBN = mat3( t, cross( n, t ), n );
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const GBUFFER_FRAG = /* glsl */`
precision highp float;

in vec2 vUv;
in vec3 vWorldPos;
in vec3 vWorldNormal;
in vec2 vObjectUV;
in mat3 vTBN;

layout(location = 0) out vec4 oReflection;
layout(location = 1) out vec4 oDiffuse;
layout(location = 2) out vec4 oNormalDepth;
layout(location = 3) out vec4 oAlbedo;

uniform vec3 uAlbedo;
uniform float uRoughness;
uniform float uMetalness;
uniform float uSssEnabled;
uniform float uDiffuseEnabled;
uniform float uObjectId;
uniform float uTextured;
uniform float uBumpStrength;
uniform float uMarbleScale;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uRimDir;
uniform vec3 uRimColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uEnvIntensity;

const float PI = 3.141592653589793;

float hash21( vec2 p ) {
  p = fract( p * vec2( 234.34, 345.45 ) );
  p += dot( p, p + 34.345 );
  return fract( p.x * p.y );
}

float valueNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( hash21( i ), hash21( i + vec2( 1.0, 0.0 ) ), u.x ),
    mix( hash21( i + vec2( 0.0, 1.0 ) ), hash21( i + vec2( 1.0, 1.0 ) ), u.x ),
    u.y );
}

float fbm( vec2 p ) {
  float v = 0.0;
  float amp = 0.5;
  for ( int i = 0; i < 5; i ++ ) {
    v += amp * valueNoise( p );
    p *= 2.03;
    amp *= 0.5;
  }
  return v;
}

float D_GGX( float NoH, float a ) {
  float a2 = a * a;
  float d = ( NoH * a2 - NoH ) * NoH + 1.0;
  return a2 / ( PI * d * d );
}

float V_SmithGGX( float NoV, float NoL, float a ) {
  float a2 = a * a;
  float ggxV = NoL * sqrt( NoV * NoV * ( 1.0 - a2 ) + a2 );
  float ggxL = NoV * sqrt( NoL * NoL * ( 1.0 - a2 ) + a2 );
  return 0.5 / ( ggxV + ggxL );
}

void main() {
  vec3 Ng = normalize( vWorldNormal );
  vec3 V = normalize( cameraPosition - vWorldPos );
  if ( dot( Ng, V ) < 0.0 ) Ng = -Ng;

  float flags = 0.0;
  if ( uDiffuseEnabled > 0.5 ) flags += 1.0;
  if ( uSssEnabled > 0.5 ) flags += 2.0;
  if ( uMetalness > 0.5 ) flags += 4.0;
  flags += 16.0 * uTextured;

  vec3 albedo = uAlbedo;
  vec3 nWorld = Ng;

  if ( uTextured > 0.5 ) {
    vec2 uv = vObjectUV;
    float marbling = fbm( uv * max( uMarbleScale, 0.25 ) );
    float veining = fbm( uv * 3.6 + 9.1 );
    vec3 tint = mix( uAlbedo * 0.52, mix( uAlbedo, vec3( 0.72, 0.54, 0.31 ), 0.45 ), marbling );
    tint *= mix( 0.86, 1.12, smoothstep( 0.28, 0.92, veining ) );
    albedo = tint;

    // Relief is evaluated in object space, so the grain is welded to the
    // material and scales with the model instead of clinging to pixels.
    float e = 0.004;
    float h0 = fbm( uv * 7.5 );
    float hx = fbm( ( uv + vec2( e, 0.0 ) ) * 7.5 );
    float hy = fbm( ( uv + vec2( 0.0, e ) ) * 7.5 );
    vec2 grad = vec2( hx - h0, hy - h0 ) / e * uBumpStrength * 0.010;
    nWorld = normalize( Ng - vTBN * vec3( grad, 0.0 ) );
  }

  vec3 Ld = normalize( uLightDir );
  vec3 Lr = normalize( uRimDir );
  float NoLd = max( dot( nWorld, Ld ), 0.0 );
  float NoLr = max( dot( nWorld, Lr ), 0.0 );
  float NoV = max( dot( nWorld, V ), 1e-3 );
  float metal = step( 0.5, uMetalness );
  float a = max( uRoughness * uRoughness, 0.0015 );

  vec3 F0 = mix( vec3( 0.04 ), albedo, metal );
  vec3 H = normalize( Ld + V );
  float D = D_GGX( max( dot( nWorld, H ), 0.0 ), a );
  float Vis = V_SmithGGX( NoV, NoLd, a );
  float Fres = pow( 1.0 - NoV, 5.0 );
  vec3 spec = ( F0 + ( 1.0 - F0 ) * Fres ) * D * Vis * uLightColor * NoLd;

  vec3 Hr = normalize( Lr + V );
  float Dr = D_GGX( max( dot( nWorld, Hr ), 0.0 ), a * 1.6 );
  spec += F0 * Dr * V_SmithGGX( NoV, NoLr, a * 1.6 ) * uRimColor * NoLr;

  // The broad environment term is reflection, not diffusion: it stays in the
  // reflection layer so it can never be blurred.
  float envMix = 0.5 + 0.5 * nWorld.y;
  vec3 env = mix( uGroundColor, uSkyColor, envMix );
  spec += F0 * env * uEnvIntensity;

  vec3 diffuse = vec3( 0.0 );
  if ( uDiffuseEnabled > 0.5 && metal < 0.5 ) {
    diffuse = albedo * ( uLightColor * NoLd + uRimColor * NoLr );
    diffuse += albedo * env * uEnvIntensity * 0.10;
  }

  oReflection = vec4( spec, metal );
  oDiffuse = vec4( diffuse, 0.0 );
  oNormalDepth = vec4( normalize( nWorld ), -( viewMatrix * vec4( vWorldPos, 1.0 ) ).z );
  oAlbedo = vec4( albedo, uObjectId + flags / 64.0 );
}
`;

// Background: sky gradient with an emissive glow and a faint grid. objectId 0
// and no diffuse flags means it can neither emit nor receive diffusion.
export const BACKGROUND_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 oReflection;
layout(location = 1) out vec4 oDiffuse;
layout(location = 2) out vec4 oNormalDepth;
layout(location = 3) out vec4 oAlbedo;
uniform vec3 uTopColor;
uniform vec3 uBottomColor;
uniform vec3 uGlowColor;
uniform float uGlowPos;
uniform float uDepth;

void main() {
  float t = clamp( vUv.y, 0.0, 1.0 );
  vec3 sky = mix( uBottomColor, uTopColor, pow( t, 0.85 ) );
  float glow = exp( -pow( ( vUv.x - uGlowPos ) * 5.0, 2.0 ) ) * smoothstep( 0.85, 0.05, t );

  float gx = abs( fract( vUv.x * 24.0 ) - 0.5 );
  float gy = abs( fract( vUv.y * 16.0 ) - 0.5 );
  float grid = smoothstep( 0.492, 0.5, max( gx, gy ) ) * 0.05;

  oReflection = vec4( 0.0 );
  oDiffuse = vec4( 0.0 );
  oNormalDepth = vec4( 0.0, 0.0, 1.0, uDepth );
  oAlbedo = vec4( ( sky + uGlowColor * glow ) * ( 0.95 + grid ), 0.0 );
}
`;

// ---------------------------------------------------------------------------
// Back-face depth prepass. Front faces are culled; with a normal depth test
// the nearest back-facing surface survives per pixel, and its object id rides
// along in g so thickness can never be borrowed across meshes.
// ---------------------------------------------------------------------------
export const THICKNESS_VERT = /* glsl */`
out float vViewDepth;
void main() {
  vec4 mv = viewMatrix * modelMatrix * vec4( position, 1.0 );
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const THICKNESS_FRAG = /* glsl */`
precision highp float;
in float vViewDepth;
layout(location = 0) out vec4 oBack;
uniform float uObjectId;
void main() {
  oBack = vec4( vViewDepth, uObjectId, 1.0, 1.0 );
}
`;
