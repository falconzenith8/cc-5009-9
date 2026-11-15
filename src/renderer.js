import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

import {
  GBUFFER_VERT, GBUFFER_FRAG, BACKGROUND_FRAG,
  THICKNESS_VERT, THICKNESS_FRAG
} from './shaders/gbuffer.js';
import {
  SEPARATE_FRAG, BLUR_FRAG, COMPOSITE_FRAG, REFERENCE_FRAG, COPY_FRAG
} from './shaders/passes.js';
import { FULLSCREEN_VERT } from './shaders/common.js';
import { buildScene } from './scene.js';

export const CHANNELS = [
  'final', 'surface', 'diffuse', 'specular', 'scatter', 'normalShade',
  'albedo', 'normal', 'depth', 'thickness', 'mask', 'objectid'
];

const TAPS = { low: 8, med: 16, high: 32 };
// Kernel radius as a multiple of the scattering length. Fixed for live and
// reference paths so the two are compared on equal footing.
const RADIUS_SCALE = 1.8;

// One world unit is 10 mm at model scale 1. This number is the bridge between
// the physical scattering distance (authored in millimetres) and the render.
const WORLD_PER_MM = 0.1;

function fsMaterial( fragmentShader, uniforms ) {
  return new THREE.ShaderMaterial( {
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false
  } );
}

function colorTarget( width, height, opts = {} ) {
  return new THREE.WebGLRenderTarget( width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
    ...opts
  } );
}

export class ScatterLab {
  constructor( canvas, state, preset ) {
    this.canvas = canvas;
    this.state = state;
    this.preset = preset;

    this.renderer = new THREE.WebGLRenderer( {
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true
    } );
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = false;

    const gl = this.renderer.getContext();
    this.capabilities = {
      webgl2: gl instanceof WebGL2RenderingContext,
      maxDrawBuffers: gl.getParameter( gl.MAX_DRAW_BUFFERS ),
      floatColor: !! gl.getExtension( 'EXT_color_buffer_float' )
    };
    if ( ! this.capabilities.floatColor ) {
      throw new Error( 'GPU 不支持浮点颜色附件，无法建立 HDR 多通道散射管线。' );
    }

    this.scene = new THREE.Scene();
    this.modelRoot = new THREE.Group();
    this.scene.add( this.modelRoot );

    this.camera = new THREE.PerspectiveCamera( 31, 1, 0.1, 300 );
    this.orbit = { theta: 0.34, phi: 1.17, radius: 10.6, targetY: 0.25 };
    this.applyOrbit();

    this.width = 1;
    this.height = 1;
    this.buildBackground();
    this.buildMaterials();
    this.buildTargets( 1, 1 );

    buildScene( this );

    this.referenceValid = false;
    this.referenceRequested = false;
    this.referenceStats = null;
    this.showCompare = false;
  }

  // --------------------------------------------------------------- resources

  buildBackground() {
    const uniforms = {
      uUvScale: { value: new THREE.Vector2( 1, 1 ) },
      uUvOffset: { value: new THREE.Vector2( 0, 0 ) },
      uTangent: { value: new THREE.Vector3( 1, 0, 0 ) },
      uTopColor: { value: new THREE.Color( '#232833' ) },
      uBottomColor: { value: new THREE.Color( '#08080a' ) },
      uGlowColor: { value: new THREE.Color( '#2b2114' ) },
      uGlowPos: { value: 0.52 },
      uDepth: { value: 140.0 }
    };
    this.backgroundQuad = new FullScreenQuad( new THREE.ShaderMaterial( {
      glslVersion: THREE.GLSL3,
      vertexShader: GBUFFER_VERT,
      fragmentShader: BACKGROUND_FRAG,
      uniforms,
      depthTest: false,
      depthWrite: false
    } ) );
  }

  buildMaterials() {
    this.gbufferMaterial = new THREE.ShaderMaterial( {
      glslVersion: THREE.GLSL3,
      vertexShader: GBUFFER_VERT,
      fragmentShader: GBUFFER_FRAG,
      uniforms: {
        uUvScale: { value: new THREE.Vector2( 1, 1 ) },
        uUvOffset: { value: new THREE.Vector2( 0, 0 ) },
        uTangent: { value: new THREE.Vector3( 1, 0, 0 ) },
        uAlbedo: { value: new THREE.Color( '#e3d0ac' ) },
        uRoughness: { value: 0.34 },
        uMetalness: { value: 0 },
        uSssEnabled: { value: 1 },
        uDiffuseEnabled: { value: 1 },
        uObjectId: { value: 1 },
        uTextured: { value: 0 },
        uBumpStrength: { value: 0.4 },
        uMarbleScale: { value: 3.2 },
        uLightDir: { value: new THREE.Vector3( 0.5, 0.82, 0.42 ).normalize() },
        uLightColor: { value: new THREE.Color( 1.0, 0.92, 0.81 ).multiplyScalar( 0.60 ) },
        uRimDir: { value: new THREE.Vector3( -0.92, 0.10, -0.38 ).normalize() },
        uRimColor: { value: new THREE.Color( 0.72, 0.88, 1.0 ).multiplyScalar( 0.42 ) },
        uSkyColor: { value: new THREE.Color( 0.20, 0.25, 0.34 ) },
        uGroundColor: { value: new THREE.Color( 0.05, 0.045, 0.04 ) },
        uEnvIntensity: { value: 1.0 }
      }
    } );

    this.thicknessMaterial = new THREE.ShaderMaterial( {
      glslVersion: THREE.GLSL3,
      vertexShader: THICKNESS_VERT,
      fragmentShader: THICKNESS_FRAG,
      uniforms: { uObjectId: { value: 1 } },
      side: THREE.BackSide,
      depthTest: true,
      depthWrite: true
    } );

    this.separateQuad = new FullScreenQuad( fsMaterial( SEPARATE_FRAG, {
      tAlbedo: { value: null },
      tDiffuse: { value: null },
      tNormalDepth: { value: null },
      tBackDepth: { value: null },
      uNear: { value: 0.1 },
      uFar: { value: 300 },
      uHeight: { value: 1 },
      uTanHalfFov: { value: 0.28 },
      uWorldPerMm: { value: WORLD_PER_MM },
      uMaxThicknessMm: { value: 30 },
      uDistanceMm: { value: 3.4 },
      uThicknessResponse: { value: 0.7 }
    } ) );

    this.blurQuad = new FullScreenQuad( fsMaterial( BLUR_FRAG, {
      tSource: { value: null },
      tGuide: { value: null },
      tAlbedo: { value: null },
      tNormalDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uDirection: { value: new THREE.Vector2( 1, 0 ) },
      uWidth: { value: 1 },
      uHeight: { value: 1 },
      uNear: { value: 0.1 },
      uFar: { value: 300 },
      uTanHalfFov: { value: 0.28 },
      uSigmaWorld: { value: 0.45 },
      uWorldTol: { value: 0.5 },
      uNormalTol: { value: 0.86 },
      uObjectGate: { value: 1 },
      uRadiusScale: { value: RADIUS_SCALE },
      uThinBoost: { value: 0.55 },
      uWorldPerMm: { value: WORLD_PER_MM },
      uDistanceMm: { value: 3.4 },
      uTaps: { value: 16 }
    } ) );

    this.compositeQuad = new FullScreenQuad( fsMaterial( COMPOSITE_FRAG, {
      tAlbedo: { value: null },
      tDiffuse: { value: null },
      tNormalDepth: { value: null },
      tSpecular: { value: null },
      tDiffused: { value: null },
      tGuide: { value: null },
      tReference: { value: null },
      uNear: { value: 0.1 },
      uFar: { value: 300 },
      uHeight: { value: 1 },
      uTanHalfFov: { value: 0.28 },
      uScatterOn: { value: 1 },
      uStrength: { value: 0.72 },
      uExposure: { value: 1 },
      uShowRef: { value: 0 },
      uSplit: { value: 0.5 },
      uChannel: { value: 0 }
    } ) );

    this.referenceQuad = new FullScreenQuad( fsMaterial( REFERENCE_FRAG, {
      tAlbedo: { value: null },
      tDiffuse: { value: null },
      tNormalDepth: { value: null },
      tSpecular: { value: null },
      tSource: { value: null },
      tGuide: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uWidth: { value: 1 },
      uHeight: { value: 1 },
      uNear: { value: 0.1 },
      uFar: { value: 300 },
      uTanHalfFov: { value: 0.28 },
      uSigmaWorld: { value: 0.45 },
      uWorldTol: { value: 0.5 },
      uNormalTol: { value: 0.86 },
      uObjectGate: { value: 1 },
      uRadiusScale: { value: RADIUS_SCALE },
      uThinBoost: { value: 0.55 },
      uWorldPerMm: { value: WORLD_PER_MM },
      uDistanceMm: { value: 3.4 },
      uStrength: { value: 0.72 },
      uExposure: { value: 1 }
    } ) );

    this.copyQuad = new FullScreenQuad( fsMaterial( COPY_FRAG, {
      tSource: { value: null }
    } ) );
    this.blitQuad = new FullScreenQuad( fsMaterial( COPY_FRAG, {
      tSource: { value: null }
    } ) );
  }

  buildTargets( width, height ) {
    this.disposeTargets();
    this.width = width;
    this.height = height;

    this.gbufferRT = new THREE.WebGLRenderTarget( width, height, {
      count: 4,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false
    } );

    this.backDepthRT = new THREE.WebGLRenderTarget( width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false
    } );

    this.separateRT = new THREE.WebGLRenderTarget( width, height, {
      count: 2,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false
    } );

    this.blurA = colorTarget( width, height );
    this.blurB = colorTarget( width, height );
    this.finalRT = colorTarget( width, height );

    this.refW = Math.max( 1, Math.round( width / 2 ) );
    this.refH = Math.max( 1, Math.round( height / 2 ) );
    this.referenceRT = new THREE.WebGLRenderTarget( this.refW, this.refH, {
      count: 2,
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false
    } );
    this.liveDownRT = colorTarget( this.refW, this.refH, { type: THREE.FloatType } );

    this.setSizes();
  }

  disposeTargets() {
    const targets = [
      this.gbufferRT, this.backDepthRT, this.separateRT, this.blurA,
      this.blurB, this.finalRT, this.referenceRT, this.liveDownRT
    ];
    for ( const rt of targets ) if ( rt ) rt.dispose();
    this.gbufferRT = this.backDepthRT = this.separateRT = this.blurA = null;
    this.blurB = this.finalRT = this.referenceRT = this.liveDownRT = null;
  }

  setSizes() {
    const tanHalf = Math.tan( THREE.MathUtils.degToRad( this.camera.fov ) * 0.5 );
    const common = [
      this.separateQuad.material.uniforms,
      this.blurQuad.material.uniforms,
      this.compositeQuad.material.uniforms,
      this.referenceQuad.material.uniforms
    ];
    for ( const u of common ) {
      u.uNear.value = this.camera.near;
      u.uFar.value = this.camera.far;
      u.uTanHalfFov.value = tanHalf;
    }
    this.separateQuad.material.uniforms.uHeight.value = this.height;
    this.blurQuad.material.uniforms.uHeight.value = this.height;
    this.blurQuad.material.uniforms.uWidth.value = this.width;
    this.blurQuad.material.uniforms.uTexel.value.set( 1 / this.width, 1 / this.height );
    this.compositeQuad.material.uniforms.uHeight.value = this.height;
    this.referenceQuad.material.uniforms.uHeight.value = this.refH;
    this.referenceQuad.material.uniforms.uWidth.value = this.refW;
    this.referenceQuad.material.uniforms.uTexel.value.set( 1 / this.refW, 1 / this.refH );
  }

  resize( cssWidth, cssHeight, dpr = 1 ) {
    const scale = this.state.resolutionScale * Math.min( dpr, 1.5 );
    let w = Math.max( 1, Math.round( cssWidth * scale ) );
    let h = Math.max( 1, Math.round( cssHeight * scale ) );
    const budget = 2200 * 1400;
    if ( w * h > budget ) {
      const k = Math.sqrt( budget / ( w * h ) );
      w = Math.max( 1, Math.round( w * k ) );
      h = Math.max( 1, Math.round( h * k ) );
    }
    this.renderer.setSize( w, h, false );
    if ( w !== this.width || h !== this.height ) this.buildTargets( w, h );
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.setSizes();
    this.invalidateReference();
  }

  // ------------------------------------------------------------------ orbit

  applyOrbit() {
    const o = this.orbit;
    const sp = new THREE.Spherical( o.radius, o.phi, o.theta );
    const v = new THREE.Vector3().setFromSpherical( sp );
    this.camera.position.set( v.x, v.y + o.targetY, v.z );
    this.camera.lookAt( 0, o.targetY, 0 );
    this.camera.updateMatrixWorld();
  }

  orbitBy( dx, dy ) {
    this.orbit.theta -= dx * 0.004;
    this.orbit.phi = THREE.MathUtils.clamp( this.orbit.phi - dy * 0.004, 0.26, Math.PI * 0.56 );
    this.applyOrbit();
    this.invalidateReference();
  }

  zoomBy( factor ) {
    this.orbit.radius = THREE.MathUtils.clamp( this.orbit.radius * factor, 4.8, 34 );
    this.applyOrbit();
    this.invalidateReference();
  }

  // ------------------------------------------------------------------ scene

  meshes() {
    const out = [];
    this.modelRoot.traverse( ( o ) => { if ( o.isMesh ) out.push( o ); } );
    return out;
  }

  applyMaterials() {
    const preset = this.preset;
    for ( const mesh of this.meshes() ) {
      const d = mesh.userData;
      const u = d.material.uniforms;
      if ( ! u ) continue;
      if ( d.kind === 'metal' ) {
        u.uObjectId.value = d.objectId;
        continue;
      }
      u.uAlbedo.value.set( preset.albedo );
      u.uRoughness.value = THREE.MathUtils.clamp( preset.roughness + ( d.roughnessBias ?? 0 ), 0.04, 1 );
      u.uSssEnabled.value = preset.sss ? 1 : 0;
      u.uDiffuseEnabled.value = 1;
      u.uMetalness.value = 0;
      u.uObjectId.value = d.objectId;
      u.uTextured.value = d.textured ? 1 : 0;
      u.uBumpStrength.value = d.bump ?? 0.4;
      u.uMarbleScale.value = d.marbleScale ?? 3.2;
    }
  }

  // ------------------------------------------------------------------ frame

  renderFrame() {
    const s = this.state;
    const r = this.renderer;
    const cam = this.camera;

    this.applyMaterials();
    this.modelRoot.scale.setScalar( s.modelScale );
    this.modelRoot.position.y = s.modelScale * 0.12;
    this.modelRoot.updateMatrixWorld( true );
    cam.updateMatrixWorld();

    const worldPerMm = WORLD_PER_MM * s.modelScale;
    const sigmaWorld = s.distanceMm * worldPerMm;
    const worldTol = Math.max( 0.01, sigmaWorld * ( 0.3 + s.depthTol * 1.9 ) );
    const tanHalf = Math.tan( THREE.MathUtils.degToRad( cam.fov ) * 0.5 );

    // Representative on-screen kernel radius at the orbit distance, so the
    // panel can report how many pixels the world-space scattering length
    // currently spans at this resolution.
    const repPpw = this.height / ( 2 * tanHalf * Math.max( this.orbit.radius, 1e-3 ) );
    this.lastPixelRadius = sigmaWorld * RADIUS_SCALE * ( 1 + s.thinBoost ) * repPpw;

    // ---- 1. back-face depth ---------------------------------------------
    // Only wax shells contribute. Front faces are culled; a normal depth test
    // retains the nearest back-facing surface along each ray, and the object
    // id travels with it so thickness cannot be borrowed across meshes.
    const wax = [];
    const others = [];
    for ( const m of this.meshes() ) {
      if ( m.userData.kind === 'wax' ) wax.push( m );
      else others.push( m );
    }
    for ( const m of others ) m.visible = false;
    if ( ! this.thicknessMaterials ) this.thicknessMaterials = new Map();
    for ( const m of wax ) {
      let tm = this.thicknessMaterials.get( m );
      if ( ! tm ) {
        // One material per shell: the object id travels in a uniform and must
        // not be shared, or the last mesh would stamp its id on every pixel.
        tm = this.thicknessMaterial.clone();
        tm.uniforms = THREE.UniformsUtils.clone( this.thicknessMaterial.uniforms );
        this.thicknessMaterials.set( m, tm );
      }
      tm.uniforms.uObjectId.value = m.userData.objectId;
      m.material = tm;
    }
    r.setRenderTarget( this.backDepthRT );
    r.setClearColor( 0x000000, 0 );
    r.clear( true, true, false );
    r.render( this.scene, cam );
    for ( const m of wax ) m.material = m.userData.material;
    for ( const m of others ) m.visible = true;

    // ---- 2. G-buffer -----------------------------------------------------
    r.setRenderTarget( this.gbufferRT );
    r.setClearColor( 0x000000, 0 );
    r.clear( true, true, false );
    r.autoClear = false;
    this.backgroundQuad.render( r );
    r.render( this.scene, cam );
    r.autoClear = false;

    // ---- 3. separation ---------------------------------------------------
    const sep = this.separateQuad.material.uniforms;
    sep.tAlbedo.value = this.gbufferRT.textures[ 3 ];
    sep.tDiffuse.value = this.gbufferRT.textures[ 1 ];
    sep.tNormalDepth.value = this.gbufferRT.textures[ 2 ];
    sep.tBackDepth.value = this.backDepthRT.texture;
    sep.uHeight.value = this.height;
    sep.uWorldPerMm.value = worldPerMm;
    sep.uMaxThicknessMm.value = s.maxThicknessMm;
    sep.uDistanceMm.value = s.distanceMm;
    sep.uThicknessResponse.value = s.thicknessResponse;
    r.setRenderTarget( this.separateRT );
    this.separateQuad.render( r );

    // ---- 4. separable cross-bilateral diffusion -------------------------
    const blur = this.blurQuad.material.uniforms;
    blur.tGuide.value = this.separateRT.textures[ 1 ];
    blur.tAlbedo.value = this.gbufferRT.textures[ 3 ];
    blur.tNormalDepth.value = this.gbufferRT.textures[ 2 ];
    blur.uSigmaWorld.value = sigmaWorld;
    blur.uWorldTol.value = worldTol;
    blur.uNormalTol.value = s.normalTol;
    blur.uObjectGate.value = s.objectGate ? 1 : 0;
    blur.uTaps.value = TAPS[ s.quality ];
    blur.uRadiusScale.value = RADIUS_SCALE;
    blur.uThinBoost.value = s.thinBoost;
    blur.uWorldPerMm.value = worldPerMm;
    blur.uDistanceMm.value = s.distanceMm;

    let src = this.separateRT;
    let dst = this.blurA;
    // The diffusion is always evaluated, even while the scatter toggle is off,
    // so the reference metric compares the approximation itself rather than
    // the toggle state. The composite applies uScatterOn on its own.
    for ( let axis = 0; axis < 2; axis ++ ) {
      blur.tSource.value = src.textures[ 0 ];
      blur.uDirection.value.set( axis === 0 ? 1 : 0, axis === 0 ? 0 : 1 );
      r.setRenderTarget( dst );
      this.blurQuad.render( r );
      src = dst;
      dst = axis === 0 ? this.blurB : this.blurA;
    }
    const diffused = src.textures[ 0 ];

    // ---- 5. reference ----------------------------------------------------
    if ( this.referenceRequested ) {
      const ref = this.referenceQuad.material.uniforms;
      ref.tAlbedo.value = this.gbufferRT.textures[ 3 ];
      ref.tDiffuse.value = this.gbufferRT.textures[ 1 ];
      ref.tNormalDepth.value = this.gbufferRT.textures[ 2 ];
      ref.tSpecular.value = this.gbufferRT.textures[ 0 ];
      ref.tSource.value = this.separateRT.textures[ 0 ];
      ref.tGuide.value = this.separateRT.textures[ 1 ];
      ref.uSigmaWorld.value = sigmaWorld;
      ref.uWorldTol.value = worldTol;
      ref.uNormalTol.value = s.normalTol;
      ref.uObjectGate.value = s.objectGate ? 1 : 0;
      ref.uRadiusScale.value = RADIUS_SCALE;
      ref.uThinBoost.value = s.thinBoost;
      ref.uWorldPerMm.value = worldPerMm;
      ref.uDistanceMm.value = s.distanceMm;
      ref.uStrength.value = s.strength;
      ref.uExposure.value = s.exposure;
      r.setRenderTarget( this.referenceRT );
      this.referenceQuad.render( r );

      this.copyQuad.material.uniforms.tSource.value = diffused;
      r.setRenderTarget( this.liveDownRT );
      this.copyQuad.render( r );

      this.referenceRequested = false;
      this.referenceValid = true;
      this.measure();
    }

    // ---- 6. composite ----------------------------------------------------
    const comp = this.compositeQuad.material.uniforms;
    comp.tAlbedo.value = this.gbufferRT.textures[ 3 ];
    comp.tDiffuse.value = this.gbufferRT.textures[ 1 ];
    comp.tNormalDepth.value = this.gbufferRT.textures[ 2 ];
    comp.tSpecular.value = this.gbufferRT.textures[ 0 ];
    comp.tDiffused.value = diffused;
    comp.tGuide.value = this.separateRT.textures[ 1 ];
    comp.tReference.value = this.referenceRT.textures[ 0 ];
    comp.uScatterOn.value = s.scatterOn ? 1 : 0;
    comp.uStrength.value = s.strength;
    comp.uExposure.value = s.exposure;
    comp.uShowRef.value = this.showCompare && this.referenceValid ? 1 : 0;
    comp.uChannel.value = CHANNELS.indexOf( s.channel );
    comp.uHeight.value = this.height;
    r.setRenderTarget( this.finalRT );
    this.compositeQuad.render( r );

    this.blitQuad.material.uniforms.tSource.value = this.finalRT.texture;
    r.setRenderTarget( null );
    this.blitQuad.render( r );

    if ( this.onFrame ) this.onFrame( this.lastPixelRadius );
  }

  // -------------------------------------------------------------- reference

  requestReference() {
    this.referenceRequested = true;
    this.referenceValid = false;
  }

  setCompare( on ) {
    this.showCompare = on;
    if ( on && ! this.referenceValid ) this.requestReference();
  }

  invalidateReference() {
    this.referenceValid = false;
  }

  measure() {
    const w = this.refW;
    const h = this.refH;
    const live = new Float32Array( w * h * 4 );
    const ref = new Float32Array( w * h * 4 );
    this.renderer.readRenderTargetPixels( this.liveDownRT, 0, 0, w, h, live );
    this.renderer.readRenderTargetPixels( this.referenceRT, 0, 0, w, h, ref, undefined, 1 );

    let absSum = 0;
    let sqSum = 0;
    let count = 0;
    for ( let i = 0; i < live.length; i += 4 ) {
      const mask = Math.min( live[ i + 3 ], ref[ i + 3 ] );
      if ( mask < 0.5 ) continue;
      for ( let c = 0; c < 3; c ++ ) {
        const e = live[ i + c ] - ref[ i + c ];
        absSum += Math.abs( e );
        sqSum += e * e;
      }
      count ++;
    }
    if ( count === 0 ) {
      this.referenceStats = { mae: 0, psnr: 0, pixels: 0 };
    } else {
      const mae = absSum / ( count * 3 );
      const mse = sqSum / ( count * 3 );
      const psnr = mse > 1e-9 ? 10 * Math.log10( 1 / mse ) : 99;
      this.referenceStats = { mae, psnr, pixels: count };
    }
    if ( this.onMetrics ) this.onMetrics( this.referenceStats );
  }

  // ------------------------------------------------------------------ debug

  readFinal() {
    const w = this.width;
    const h = this.height;
    const half = new Uint16Array( w * h * 4 );
    this.renderer.readRenderTargetPixels( this.finalRT, 0, 0, w, h, half );
    const out = new Float32Array( w * h * 4 );
    for ( let i = 0; i < half.length; i ++ ) out[ i ] = THREE.DataUtils.fromHalfFloat( half[ i ] );
    return { data: out, width: w, height: h };
  }

  readTarget( rt, attachment = 0 ) {
    const w = rt.width;
    const h = rt.height;
    const half = new Uint16Array( w * h * 4 );
    this.renderer.readRenderTargetPixels( rt, 0, 0, w, h, half, undefined, attachment );
    const out = new Float32Array( w * h * 4 );
    for ( let i = 0; i < half.length; i ++ ) out[ i ] = THREE.DataUtils.fromHalfFloat( half[ i ] );
    return { data: out, width: w, height: h };
  }

  dispose() {
    this.disposeTargets();
    this.renderer.dispose();
  }
}
