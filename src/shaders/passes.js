import { DEPTH_HELPERS, PROFILE_HELPERS } from './common.js';

// ---------------------------------------------------------------------------
// Pass 2 — separation & source reconstruction (2-attachment MRT).
//
//   oEmission : rgb = diffusible irradiance of wax surfaces only, tinted by
//                     the thickness response
//               a   = participant mask (1 only for SSS wax)
//   oGuide    : r view depth, g thickness (world units),
//               b thickness validity, a thickness (millimetres)
//
// The source is built exclusively from MRT1 (diffusible irradiance). Direct
// reflection, background and metals live in other attachments, so they are
// structurally absent from the blur input rather than masked afterwards.
// ---------------------------------------------------------------------------
export const SEPARATE_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;

layout(location = 0) out vec4 oEmission;
layout(location = 1) out vec4 oGuide;

uniform sampler2D tAlbedo;
uniform sampler2D tDiffuse;
uniform sampler2D tNormalDepth;
uniform sampler2D tBackDepth;
uniform float uWorldPerMm;
uniform float uMaxThicknessMm;
uniform float uDistanceMm;
uniform float uThicknessResponse;

${DEPTH_HELPERS}

float objectIdOf( float packed ) { return floor( packed + 0.0008 ); }
float flagsOf( float packed ) {
  float id = objectIdOf( packed );
  return floor( ( packed - id ) * 64.0 + 0.5 );
}

void main() {
  vec4 A = texture( tAlbedo, vUv );
  vec4 D = texture( tDiffuse, vUv );
  vec4 ND = texture( tNormalDepth, vUv );

  float id = objectIdOf( A.a );
  float flags = flagsOf( A.a );
  bool diffuseOn = mod( flags, 2.0 ) >= 0.5;
  bool sssOn = mod( floor( flags / 2.0 ), 2.0 ) >= 0.5;
  bool metal = mod( floor( flags / 4.0 ), 2.0 ) >= 0.5;

  float depth = ND.a;
  bool background = id < 0.5;
  bool participant = diffuseOn && sssOn && ! metal && ! background;

  // Interior thickness along the view ray: nearest back-facing surface minus
  // the visible front surface. The back-face prepass also records its object
  // id, so a wax surface cannot borrow the back depth of another mesh. Only
  // diffuse-capable wax tracks thickness; metals and the background have no
  // volumetric interior to report.
  vec4 back = texture( tBackDepth, vUv );
  float thicknessWorld = 0.0;
  float valid = 0.0;
  if ( participant ) {
    thicknessWorld = uMaxThicknessMm * uWorldPerMm;
    if ( back.r > depth + 1e-4 && abs( back.g - id ) < 0.5 ) {
      thicknessWorld = min( back.r - depth, uMaxThicknessMm * uWorldPerMm );
      valid = 1.0;
    }
  }
  float thicknessMm = thicknessWorld / max( uWorldPerMm, 1e-6 );

  // Optical thickness = physical thickness over the scattering length. This
  // is what decides whether light escapes the front face, so both the emitted
  // energy and the effective diffusion radius are keyed to it rather than to
  // an absolute millimetre threshold.
  float optical = thicknessMm / max( uDistanceMm, 1e-3 );
  float thin = 1.0 - smoothstep( 0.25, 2.5, optical );
  float response = clamp( uThicknessResponse, 0.0, 1.0 );

  // Thin wax glows warm and bright; thick wax goes milky and a little cooler.
  float loudness = mix( 1.0, mix( 0.74, 1.62, thin ), response );
  vec3 tintColor = mix( vec3( 0.95, 0.96, 0.95 ), vec3( 1.16, 0.97, 0.78 ), thin * response );

  float mask = participant ? 1.0 : 0.0;
  oEmission = vec4( D.rgb * loudness * tintColor * mask, mask );
  oGuide = vec4( depth, thicknessWorld, valid, thicknessMm );
}
`;

// ---------------------------------------------------------------------------
// Pass 3 — one axis of a separable cross-bilateral diffusion filter.
//
// The kernel width comes from a world-space scattering length projected to
// pixels at the sample's own view depth, so changing render resolution cannot
// change the apparent material thickness. Taps are rejected when:
//   * the neighbour is not a wax participant,
//   * the neighbour belongs to a different object (identity gate),
//   * the neighbour lies off the centre's tangent plane by more than a
//     world-space tolerance derived from the scattering length
//     (silhouette / depth-cliff / adjacent-but-unconnected gate),
//   * the surface orientation diverges (crease gate).
// Normalisation divides by the accepted weights, so a flat interior surface
// keeps its own energy exactly while a real boundary receives only the taps
// that passed the gates — energy fades at a silhouette instead of being
// renormalised back to full strength.
// ---------------------------------------------------------------------------
export const BLUR_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 oResult;

uniform sampler2D tSource;
uniform sampler2D tGuide;
uniform sampler2D tAlbedo;
uniform sampler2D tNormalDepth;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uWidth;
uniform float uSigmaWorld;
uniform float uWorldTol;
uniform float uNormalTol;
uniform float uObjectGate;
uniform float uRadiusScale;
uniform float uThinBoost;
uniform float uWorldPerMm;
uniform float uDistanceMm;
uniform int uTaps;

${DEPTH_HELPERS}
${PROFILE_HELPERS}

float objectIdOf( float packed ) { return floor( packed + 0.0008 ); }
float flagsOf( float packed ) {
  float id = objectIdOf( packed );
  return floor( ( packed - id ) * 64.0 + 0.5 );
}

vec3 viewPosition( vec2 uv, float z ) {
  vec2 ndc = uv * 2.0 - 1.0;
  float aspect = uWidth / max( uHeight, 1.0 );
  return vec3( ndc.x * uTanHalfFov * aspect * z, ndc.y * uTanHalfFov * z, -z );
}

bool eligibleAt( vec4 a, vec4 g ) {
  float f = flagsOf( a.a );
  float id = objectIdOf( a.a );
  return id >= 0.5
    && mod( f, 2.0 ) >= 0.5
    && mod( floor( f / 2.0 ), 2.0 ) >= 0.5
    && mod( floor( f / 4.0 ), 2.0 ) < 0.5
    && g.x > 0.0;
}

void main() {
  vec4 srcC = texture( tSource, vUv );
  vec4 gC = texture( tGuide, vUv );
  vec4 aC = texture( tAlbedo, vUv );
  vec4 nC = texture( tNormalDepth, vUv );

  if ( ! eligibleAt( aC, gC ) ) {
    oResult = vec4( 0.0 );
    return;
  }

  float idC = objectIdOf( aC.a );
  vec3 Nc = normalize( nC.xyz );
  vec3 Ncv = normalize( ( viewMatrix * vec4( Nc, 0.0 ) ).xyz );
  vec3 Pc = viewPosition( vUv, gC.x );

  // The kernel is defined in world units and sampled at fixed world intervals,
  // then projected to pixels at this depth. The sampling pattern in world
  // space is therefore independent of render resolution.
  // Thin wax spreads light further than thick wax: scale the kernel by the
  // local thickness before projecting it. This is a material response, not a
  // visual fudge, and it is mirrored exactly by the reference path.
  float ppw = pixelsPerWorld( gC.x );
  // Thin-shell response, expressed as optical thickness so it survives any
  // model scale or scattering-length change.
  float optical = ( gC.y / max( uWorldPerMm, 1e-6 ) ) / max( uDistanceMm, 1e-3 );
  float thin = 1.0 - smoothstep( 0.25, 2.5, optical );
  float sigmaLocal = uSigmaWorld * mix( 1.0, 1.0 + uThinBoost, thin );
  float radiusWorld = sigmaLocal * uRadiusScale;
  float stepWorld = radiusWorld / float( max( uTaps, 1 ) );
  float stepPx = max( stepWorld * ppw, 0.02 );

  // Cross-bilateral normalisation: divide by the weights that were actually
  // accepted. A flat, continuous surface therefore keeps its own energy
  // exactly, while a real silhouette contributes only same-object taps, so
  // nothing bleeds across and nothing is spuriously darkened.
  vec3 acc = srcC.rgb;
  float wSum = 1.0;

  for ( int i = 1; i <= 40; i ++ ) {
    if ( i > uTaps ) break;
    for ( int s = -1; s <= 1; s += 2 ) {
      vec2 uv = vUv + uDirection * uTexel * ( float( i ) * stepPx * float( s ) );

      float offWorld = float( i ) * stepPx / ppw;
      float wProfile = profile1D( offWorld, sigmaLocal );

      vec4 a2 = texture( tAlbedo, uv );
      vec4 g2 = texture( tGuide, uv );

      float w = 0.0;
      if ( eligibleAt( a2, g2 ) ) {
        float id2 = objectIdOf( a2.a );
        if ( uObjectGate < 0.5 || abs( id2 - idC ) < 0.5 ) {
          vec3 P2 = viewPosition( uv, g2.x );
          float planeDist = abs( dot( Ncv, P2 - Pc ) );
          float wDepth = 1.0 - smoothstep( uWorldTol * 0.7, uWorldTol, planeDist );

          vec3 N2 = normalize( texture( tNormalDepth, uv ).xyz );
          // Orientation gate is deliberately loose inside one surface: a
          // curved wax shell changes normal over the kernel and must not lose
          // energy just because it bends. Silhouettes are handled by identity
          // and depth-plane gates instead.
          float wN = smoothstep( uNormalTol - 0.35, uNormalTol - 0.05, dot( Nc, N2 ) );

          w = wProfile * wDepth * wN;
        }
      }
      acc += texture( tSource, uv ).rgb * w;
      wSum += w;
    }
  }

  oResult = vec4( acc / max( wSum, 1e-4 ), srcC.a );
}
`;

// ---------------------------------------------------------------------------
// Pass 4 — composite.
//
// For wax participants the direct diffuse term is replaced, by weight, with
// the diffused transport; direct reflection, background and non-participants
// are untouched, so total energy stays roughly constant while the diffuse
// distribution softens. With scattering off, or at blend 0, the image is
// exactly the plain surface shading, which makes the A/B honest.
// ---------------------------------------------------------------------------
export const COMPOSITE_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 oColor;

uniform sampler2D tAlbedo;
uniform sampler2D tDiffuse;
uniform sampler2D tNormalDepth;
uniform sampler2D tSpecular;
uniform sampler2D tDiffused;
uniform sampler2D tGuide;
uniform sampler2D tReference;
uniform float uScatterOn;
uniform float uStrength;
uniform float uExposure;
uniform float uShowRef;
uniform float uSplit;
uniform float uMaxThicknessMm;
uniform int uChannel;

${DEPTH_HELPERS}

vec3 aces( vec3 v ) {
  v *= 0.6;
  return clamp( ( v * ( 2.51 * v + 0.03 ) ) / ( v * ( 2.43 * v + 0.59 ) + 0.14 ), 0.0, 1.0 );
}

vec3 toDisplay( vec3 c ) {
  return pow( aces( c * uExposure ), vec3( 1.0 / 2.2 ) );
}

vec3 compositeLinear( vec4 A, vec4 D, vec4 S, vec4 dif ) {
  // Energy-conserving separable-SSS blend: the local single-scatter diffuse
  // term is replaced, by weight, with the multi-scattered transport gathered
  // from neighbours. Total diffuse energy stays roughly constant; only its
  // spatial distribution softens. Direct reflection is never touched, and the
  // mask keeps metals and background out of the mix entirely.
  float blend = dif.a * uScatterOn * clamp( uStrength, 0.0, 1.0 );
  bool background = floor( A.a + 0.0008 ) < 0.5;
  vec3 base = background ? A.rgb : S.rgb + D.rgb;
  vec3 diffusePart = background ? vec3( 0.0 ) : mix( D.rgb, dif.rgb, blend );
  return background ? A.rgb : S.rgb + diffusePart;
}

void main() {
  vec4 A = texture( tAlbedo, vUv );
  vec4 D = texture( tDiffuse, vUv );
  vec4 ND = texture( tNormalDepth, vUv );
  vec4 S = texture( tSpecular, vUv );
  vec4 dif = texture( tDiffused, vUv );
  vec4 g = texture( tGuide, vUv );

  float id = floor( A.a + 0.0008 );
  bool background = id < 0.5;

  vec3 col = toDisplay( compositeLinear( A, D, S, dif ) );

  if ( uShowRef > 0.5 ) {
    vec3 ref = texture( tReference, vUv ).rgb;
    float seam = 1.0 - smoothstep( 0.0, 0.0022, abs( vUv.x - uSplit ) );
    if ( vUv.x >= uSplit ) col = ref;
    col = mix( col, vec3( 0.86, 0.80, 0.66 ), seam * 0.9 );
  }

  if ( uChannel == 1 ) {
    col = toDisplay( background ? A.rgb : D.rgb + S.rgb );
  } else if ( uChannel == 2 ) {
    col = toDisplay( D.rgb );
  } else if ( uChannel == 3 ) {
    col = toDisplay( S.rgb );
  } else if ( uChannel == 4 ) {
    col = toDisplay( dif.rgb );
  } else if ( uChannel == 5 ) {
    vec3 n = normalize( ND.xyz );
    float lambert = max( dot( n, normalize( vec3( 0.55, 0.85, 0.5 ) ) ), 0.0 );
    col = pow( vec3( lambert ), vec3( 1.0 / 2.2 ) );
  } else if ( uChannel == 6 ) {
    col = pow( A.rgb, vec3( 1.0 / 2.2 ) );
  } else if ( uChannel == 7 ) {
    col = ND.xyz * 0.5 + 0.5;
  } else if ( uChannel == 8 ) {
    col = vec3( clamp( 1.0 - g.x / 30.0, 0.0, 1.0 ) );
  } else if ( uChannel == 9 ) {
    float t = clamp( g.a / max( uMaxThicknessMm, 1.0 ), 0.0, 1.0 );
    col = mix( vec3( 0.09, 0.13, 0.24 ), vec3( 0.98, 0.72, 0.36 ), t );
    col *= mix( 0.45, 1.0, g.b );
  } else if ( uChannel == 10 ) {
    col = vec3( dif.a );
  } else if ( uChannel == 11 ) {
    col = vec3( fract( id * 0.37 ), fract( id * 0.61 + 0.2 ), fract( id * 0.89 + 0.5 ) );
  }

  oColor = vec4( col, 1.0 );
}
`;

// ---------------------------------------------------------------------------
// Reference path — exact non-separable 2D gather over the same source.
//
// Same gates, same source, same thickness response. The differences are
// (a) the kernel is evaluated over true 2D distance with the radial profile,
// (b) the tap budget is much larger. This is the high-quality comparator for
// the separable bilateral approximation. It remains a visible-surface method:
// light entering a surface the camera cannot see is still not represented.
//
// Attachment 0 is the tonemapped composite; attachment 1 is linear scatter
// plus mask, kept for numeric comparison.
// ---------------------------------------------------------------------------
export const REFERENCE_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;

layout(location = 0) out vec4 oDisplay;
layout(location = 1) out vec4 oLinear;

uniform sampler2D tAlbedo;
uniform sampler2D tDiffuse;
uniform sampler2D tSpecular;
uniform sampler2D tSource;
uniform sampler2D tGuide;
uniform sampler2D tNormalDepth;
uniform vec2 uTexel;
uniform float uWidth;
uniform float uSigmaWorld;
uniform float uWorldTol;
uniform float uNormalTol;
uniform float uObjectGate;
uniform float uRadiusScale;
uniform float uThinBoost;
uniform float uWorldPerMm;
uniform float uDistanceMm;
uniform float uStrength;
uniform float uExposure;

${DEPTH_HELPERS}
${PROFILE_HELPERS}

float objectIdOf( float packed ) { return floor( packed + 0.0008 ); }
float flagsOf( float packed ) {
  float id = objectIdOf( packed );
  return floor( ( packed - id ) * 64.0 + 0.5 );
}

vec3 viewPosition( vec2 uv, float z ) {
  vec2 ndc = uv * 2.0 - 1.0;
  float aspect = uWidth / max( uHeight, 1.0 );
  return vec3( ndc.x * uTanHalfFov * aspect * z, ndc.y * uTanHalfFov * z, -z );
}

vec3 aces( vec3 v ) {
  v *= 0.6;
  return clamp( ( v * ( 2.51 * v + 0.03 ) ) / ( v * ( 2.43 * v + 0.59 ) + 0.14 ), 0.0, 1.0 );
}

void main() {
  vec4 A = texture( tAlbedo, vUv );
  vec4 ND = texture( tNormalDepth, vUv );
  vec4 S = texture( tSpecular, vUv );
  vec4 D = texture( tDiffuse, vUv );
  vec4 G = texture( tGuide, vUv );

  float idC = objectIdOf( A.a );
  float fC = flagsOf( A.a );
  bool eligible = idC >= 0.5
    && mod( fC, 2.0 ) >= 0.5
    && mod( floor( fC / 2.0 ), 2.0 ) >= 0.5
    && mod( floor( fC / 4.0 ), 2.0 ) < 0.5;

  vec3 scatter = vec3( 0.0 );

  if ( eligible && G.x > 0.0 ) {
    vec3 Nc = normalize( ND.xyz );
    vec3 Ncv = normalize( ( viewMatrix * vec4( Nc, 0.0 ) ).xyz );
    vec3 Pc = viewPosition( vUv, G.x );

    float ppw = pixelsPerWorld( G.x );
    float optical = ( G.y / max( uWorldPerMm, 1e-6 ) ) / max( uDistanceMm, 1e-3 );
    float thin = 1.0 - smoothstep( 0.25, 2.5, optical );
    float sigmaLocal = uSigmaWorld * mix( 1.0, 1.0 + uThinBoost, thin );
    float radiusWorld = sigmaLocal * uRadiusScale;
    float radiusPx = max( radiusWorld * ppw, 0.02 );

    // Stratified polar gather over the true 2D disc. The area measure r*dr is
    // included in the weight, so this integrates the same radial profile as
    // the live pass without relying on separability, and the sample count is
    // independent of the screen-space radius. This is the quality reference
    // the separable approximation is measured against.
    vec3 acc = vec3( 0.0 );
    float wAccepted = 0.0;
    const int RADIAL = 14;
    const int ANGULAR = 24;

    for ( int i = 0; i < RADIAL; i ++ ) {
      float rn = sqrt( ( float( i ) + 0.5 ) / float( RADIAL ) );
      float rPx = radiusPx * rn;
      float rWorld = radiusWorld * rn;
      float wRadial = profile2D( rWorld, sigmaLocal ) * rWorld;

      for ( int j = 0; j < ANGULAR; j ++ ) {
        float a = ( float( j ) + 0.5 * float( i % 2 ) ) / float( ANGULAR ) * 6.2831853;
        vec2 offPx = vec2( cos( a ), sin( a ) ) * rPx;
        vec2 uv = vUv + offPx * uTexel;

        vec4 a2 = texture( tAlbedo, uv );
        float id2 = objectIdOf( a2.a );
        float f2 = flagsOf( a2.a );
        bool eligible2 = id2 >= 0.5
          && mod( f2, 2.0 ) >= 0.5
          && mod( floor( f2 / 2.0 ), 2.0 ) >= 0.5
          && mod( floor( f2 / 4.0 ), 2.0 ) < 0.5;
        if ( ! eligible2 ) continue;
        if ( uObjectGate > 0.5 && abs( id2 - idC ) >= 0.5 ) continue;

        vec4 g2 = texture( tGuide, uv );
        if ( g2.x <= 0.0 ) continue;
        vec3 P2 = viewPosition( uv, g2.x );
        float planeDist = abs( dot( Ncv, P2 - Pc ) );
        float wDepth = 1.0 - smoothstep( uWorldTol * 0.7, uWorldTol, planeDist );

        vec3 N2 = normalize( texture( tNormalDepth, uv ).xyz );
        float wN = smoothstep( uNormalTol - 0.35, uNormalTol - 0.05, dot( Nc, N2 ) );

        float w = wRadial * wDepth * wN;
        if ( w <= 0.0 ) continue;
        acc += texture( tSource, uv ).rgb * w;
        wAccepted += w;
      }
    }
    scatter = acc / max( wAccepted, 1e-4 );
  }

  float mask = eligible ? 1.0 : 0.0;
  float blend = mask * clamp( uStrength, 0.0, 1.0 );
  bool background = idC < 0.5;
  vec3 base = background ? A.rgb : S.rgb + mix( D.rgb, scatter, blend );

  oDisplay = vec4( pow( aces( base * uExposure ), vec3( 1.0 / 2.2 ) ), 1.0 );
  oLinear = vec4( scatter, mask );
}
`;

// Plain texture copy, used to resample the live scatter into the reference
// resolution for numeric comparison.
export const COPY_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 oColor;
uniform sampler2D tSource;
void main() {
  oColor = texture( tSource, vUv );
}
`;
