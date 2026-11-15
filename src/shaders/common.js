export const FULLSCREEN_VERT = /* glsl */`
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// Scattering lengths are authored in millimetres, converted to world units by
// the model scale, and only then projected to pixels at each sample's own
// view depth. Render resolution therefore cannot masquerade as a change of
// material thickness.
export const DEPTH_HELPERS = /* glsl */`
uniform float uNear;
uniform float uFar;
uniform float uHeight;
uniform float uTanHalfFov;

float pixelsPerWorld( float viewZ ) {
  return uHeight / ( 2.0 * uTanHalfFov * max( viewZ, 1e-3 ) );
}
`;

export const PROFILE_HELPERS = /* glsl */`
// One-dimensional exponential profile: the live separable kernel.
float profile1D( float r, float sigmaPx ) {
  float s = max( sigmaPx, 1e-4 );
  return 0.72 * exp( -r / s ) + 0.28 * exp( -r / ( 3.2 * s ) );
}

// Non-separable 2D profile used by the reference gather. The 1/(1 + r/s)
// factor stands in for the dipole's 1/r falloff integrated over the surface,
// so this kernel cannot be factored into an x pass and a y pass.
float profile2D( float r, float sigma ) {
  float s = max( sigma, 1e-4 );
  return ( 0.7 * exp( -r / s ) + 0.3 * exp( -r / ( 3.4 * s ) ) ) / ( 1.0 + r / s );
}
`;
