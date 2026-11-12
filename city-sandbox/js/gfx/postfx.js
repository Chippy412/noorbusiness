// postfx.js — HDR post-processing chain.
//
//   RenderPass (MSAA, half-float) -> UnrealBloomPass -> FinalPass -> OutputPass
//
// FinalPass works on linear HDR colour (before tone mapping): speed radial
// blur + edge chromatic aberration, a gentle grade, vignette and animated grain.
// OutputPass then applies the renderer's tone mapping (ACES) and sRGB encoding.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const FinalShader = {
  name: 'NeonTideFinal',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uNight: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uSpeed, uNight, uAspect;
    varying vec2 vUv;

    float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c * vec2(uAspect, 1.0), c * vec2(uAspect, 1.0)) / (0.25 * (uAspect * uAspect + 1.0)); // 0 centre .. 1 corner
      float edge = smoothstep(0.08, 1.0, r2);

      // chromatic aberration: tiny always-on lens fringe at the corners, more with speed
      float ca = edge * (0.0009 + 0.0045 * uSpeed);
      vec3 col;
      if (uSpeed > 0.004) {
        // radial blur toward the centre, weighted to the frame edges
        float blur = edge * uSpeed * 0.055;
        float j = hash(gl_FragCoord.xy + fract(uTime) * 61.0);
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 8; i++) {
          float t = (float(i) + j) / 8.0;
          vec2 uv = vUv - c * blur * t;
          acc.r += texture2D(tDiffuse, uv - c * ca).r;
          acc.g += texture2D(tDiffuse, uv).g;
          acc.b += texture2D(tDiffuse, uv + c * ca).b;
        }
        col = acc / 8.0;
      } else {
        col.r = texture2D(tDiffuse, vUv - c * ca).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv + c * ca).b;
      }
      col = max(col, vec3(0.0));

      // ---- grade (scene-linear) ----
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // contrast pivoted on mid grey, applied to luminance so hues hold
      float l2 = 0.18 * pow(max(luma, 1e-5) / 0.18, 1.10);
      col *= l2 / max(luma, 1e-5);
      // saturation lift
      col = mix(vec3(l2), col, 1.18);
      // split tone: cool teal shadows, warm highlights (stronger at night for the neon mood)
      float sh = 1.0 - smoothstep(0.0, 0.25, l2);
      float hi = smoothstep(0.35, 1.6, l2);
      col *= mix(vec3(1.0), vec3(0.93, 1.0, 1.08), sh * mix(0.5, 0.9, uNight));
      col *= mix(vec3(1.0), vec3(1.04, 1.0, 0.95), hi * 0.6);
      col = max(col, vec3(0.0));

      // vignette
      float vig = 1.0 - smoothstep(0.25, 1.25, r2) * mix(0.34, 0.46, uNight);
      col *= vig;

      // animated film grain, luminance-proportional so blacks stay clean
      float g = hash(gl_FragCoord.xy + vec2(fract(uTime * 7.13) * 311.0, fract(uTime * 3.71) * 173.0)) - 0.5;
      col *= 1.0 + g * 0.055;
      col += g * 0.0015;

      gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
    }`,
};

const lerp = (a, b, t) => a + (b - a) * t;

export class PostFX {
  /**
   * @param {{renderer:THREE.WebGLRenderer, scene:THREE.Scene, camera:THREE.Camera}} o
   */
  constructor({ renderer, scene, camera }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = 'high';
    this._night = 0;
    this._speed = 0;
    this._time = 0;

    // PostFX owns the display transform: ACES + sRGB, applied by OutputPass
    // (or inline by the materials on the 'low' path, which skips the composer).
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    this._w = Math.max(1, size.x);
    this._h = Math.max(1, size.y);

    // Half-float HDR target, multisampled when the context supports it, so the
    // composer path keeps anti-aliasing (the canvas' own MSAA is bypassed).
    const gl = renderer.getContext();
    const isWebGL2 = renderer.capabilities.isWebGL2;
    const hdr = isWebGL2 || renderer.extensions.has('OES_texture_half_float');
    const samples = isWebGL2 ? Math.min(4, renderer.capabilities.maxSamples || gl.getParameter(gl.MAX_SAMPLES) || 0) : 0;
    const target = new THREE.WebGLRenderTarget(Math.round(this._w * pr), Math.round(this._h * pr), {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      samples,
    });
    target.texture.name = 'NeonTide.rt';

    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(pr);
    this.renderPass = new RenderPass(scene, camera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(this._w * pr, this._h * pr), 0.25, 0.55, 1.2);
    this.finalPass = new ShaderPass(FinalShader);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.finalPass);
    this.composer.addPass(this.outputPass);

    this.setSize(this._w, this._h);
    this.setNight(0);
  }

  /** CSS-pixel size; the renderer's current pixel ratio is applied on top. */
  setSize(w, h) {
    this._w = Math.max(1, w | 0);
    this._h = Math.max(1, h | 0);
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);         // also resizes every pass
    this.composer.setSize(this._w, this._h);
    this.finalPass.uniforms.uAspect.value = this._w / this._h;
    this._applyBloomRes();
  }

  _applyBloomRes() {
    const pr = this.renderer.getPixelRatio();
    // UnrealBloom's mip chain already starts at half its nominal size;
    // 'medium' halves it again for cheaper GPUs.
    const k = this.quality === 'medium' ? 0.5 : 1.0;
    this.bloomPass.setSize(Math.max(2, Math.round(this._w * pr * k)), Math.max(2, Math.round(this._h * pr * k)));
  }

  /** 'low' = plain renderer.render, 'medium' = bloom only (half res), 'high' = everything. */
  setQuality(q) {
    this.quality = q === 'low' || q === 'medium' ? q : 'high';
    this.finalPass.enabled = this.quality === 'high';
    this.bloomPass.enabled = this.quality !== 'low';
    this._applyBloomRes();
  }

  /** 0 day .. 1 night: restrained bloom by day, lush glow for neon/windows at night. */
  setNight(n) {
    n = Math.min(1, Math.max(0, n));
    this._night = n;
    this.bloomPass.strength = lerp(0.14, 0.34, n);
    this.bloomPass.radius = lerp(0.45, 0.6, n);
    this.bloomPass.threshold = lerp(1.35, 0.95, n);
    this.finalPass.uniforms.uNight.value = n;
  }

  /** 0..1 speed feel: radial blur + chromatic aberration at the frame edges. */
  setSpeed(s) {
    this._speed = Math.min(1, Math.max(0, s || 0));
    this.finalPass.uniforms.uSpeed.value = this._speed;
  }

  render(dt = 0.016) {
    this._time += dt;
    if (this.quality === 'low') {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.finalPass.uniforms.uTime.value = this._time;
    this.composer.render(dt);
  }

  dispose() {
    this.composer.dispose();
    this.bloomPass.dispose();
    this.finalPass.dispose();
    this.outputPass.dispose();
  }
}
