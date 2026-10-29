import type { Mat4, Vec3 } from './mat4';
import { radius, type Bounds } from './orbit';
import { ringLayout, type RingLayout, type RowSegment } from './ring';
import type { RenderMode } from './settings';

/**
 * Draws a point cloud, or a surface through it, straight from stored profiles with WebGL2.
 *
 * The profiles live in one `R16UI` 2D array texture, laid out like the `RowRing` (see
 * `core/cloud/ring.ts`); there are no vertex buffers at all. Each point (or triangle corner) is
 * one `gl_VertexID`: the vertex shader works out its column and profile, fetches the value, and
 * places it. So a rolling buffer only uploads its new rows, and decimating is a matter of strides.
 *
 * Lit, the normal comes from the neighbouring values, and one white directional light shades
 * (ambient, Lambert, Blinn-Phong). Shadows come from a depth map rendered from the light, with the
 * surface as the caster in both modes: sparse points would cast noise.
 */

/** Fetching and placing held values, shared by the point, surface and shadow passes. */
const GRID = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;

uniform usampler2DArray uRing;
uniform int uCols;        // columns drawn per profile
uniform int uColStride;
uniform int uRowStride;
uniform int uKStart;      // first profile drawn, counted from the oldest held
uniform int uFirst;       // vertex of the grid the draw starts at (large grids take several draws)
uniform int uOldest;      // slot of the oldest profile held
uniform int uCapacity;
uniform int uLayerRows;
uniform int uWidth;       // columns held
uniform int uFilled;      // profiles held
uniform uint uInvalid;
uniform vec3 uScale;
uniform vec3 uOffset;
uniform mat4 uMvp;
uniform vec2 uWindow;
uniform bool uLit;

out float vLevel;
out vec3 vPos;
out vec3 vNormal;

uint valueAt(int c, int k) {
  int slot = (uOldest + k) % uCapacity;
  return texelFetch(uRing, ivec3(c, slot % uLayerRows, slot / uLayerRows), 0).r;
}

vec3 place(int c, int k, uint v) {
  return vec3(float(c), float(k), float(v)) * uScale + uOffset;
}

float level(uint v) {
  return clamp((float(v) - uWindow.x) / max(uWindow.y - uWindow.x, 1.0), 0.0, 1.0);
}

// The surface's normal at held point p, from its neighbours at the draw strides (one side where
// the other is missing).
vec3 normalAt(int c, int k, vec3 p) {
  vec3 along = vec3(0.0);
  vec3 across = vec3(0.0);
  if (c + uColStride < uWidth) {
    uint v = valueAt(c + uColStride, k);
    if (v != uInvalid) along += place(c + uColStride, k, v) - p;
  }
  if (c - uColStride >= 0) {
    uint v = valueAt(c - uColStride, k);
    if (v != uInvalid) along += p - place(c - uColStride, k, v);
  }
  if (k + uRowStride < uFilled) {
    uint v = valueAt(c, k + uRowStride);
    if (v != uInvalid) across += place(c, k + uRowStride, v) - p;
  }
  if (k - uRowStride >= 0) {
    uint v = valueAt(c, k - uRowStride);
    if (v != uInvalid) across += p - place(c, k - uRowStride, v);
  }
  // Without neighbours a point faces straight up. The fallbacks keep the scale's sign, so they
  // point the way the neighbours would.
  if (along == vec3(0.0)) along = vec3(uScale.x, 0.0, 0.0);
  if (across == vec3(0.0)) across = vec3(0.0, uScale.y, 0.0);
  // Profiles run toward -Y, so cross(across, along) points up on a flat cloud. A mirrored x
  // (uScale.x < 0) turns along around, and the normal with it: flip it back up.
  return normalize(cross(across, along)) * (uScale.x < 0.0 ? -1.0 : 1.0);
}

void hide() {
  // Outside the clip volume, so nothing is drawn.
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 0.0;
  vLevel = 0.0;
  vPos = vec3(0.0);
  vNormal = vec3(0.0, 0.0, 1.0);
}
`;

const POINTS_VS = `${GRID}
uniform float uPointSize;

void main() {
  int id = gl_VertexID + uFirst;
  int c = (id % uCols) * uColStride;
  int k = uKStart + (id / uCols) * uRowStride;
  uint v = valueAt(c, k);
  if (v == uInvalid) {
    hide();
    return;
  }
  vec3 p = place(c, k, v);
  gl_Position = uMvp * vec4(p, 1.0);
  gl_PointSize = uPointSize;
  vLevel = level(v);
  vPos = p;
  vNormal = uLit ? normalAt(c, k, p) : vec3(0.0, 0.0, 1.0);
}
`;

/**
 * Two triangles per quad of drawn columns and profiles, six vertices each. A triangle with a
 * corner missing, or spanning a step larger than `uJump` of the window, collapses: a gap rather
 * than a wall down a laser shadow.
 */
const SURFACE_VS = `${GRID}
uniform float uJump;

const ivec2 CORNERS[6] = ivec2[6](ivec2(0, 0), ivec2(1, 0), ivec2(0, 1), ivec2(1, 0), ivec2(1, 1), ivec2(0, 1));

void main() {
  int id = gl_VertexID + uFirst;
  int quad = id / 6;
  int corner = id % 6;
  int first = corner - corner % 3;
  int qc = quad % (uCols - 1);
  int qk = quad / (uCols - 1);

  ivec2 cell[3];
  uint value[3];
  for (int i = 0; i < 3; i++) {
    ivec2 at = CORNERS[first + i];
    cell[i] = ivec2((qc + at.x) * uColStride, uKStart + (qk + at.y) * uRowStride);
    value[i] = valueAt(cell[i].x, cell[i].y);
  }
  uint lo = min(value[0], min(value[1], value[2]));
  uint hi = max(value[0], max(value[1], value[2]));
  // The invalid value is 0, the lowest there is.
  if (lo == uInvalid || float(hi - lo) > uJump * max(uWindow.y - uWindow.x, 1.0)) {
    hide();
    return;
  }
  int own = corner % 3;
  int c = cell[own].x;
  int k = cell[own].y;
  uint v = value[own];
  vec3 p = place(c, k, v);
  gl_Position = uMvp * vec4(p, 1.0);
  gl_PointSize = 1.0;
  vLevel = level(v);
  vPos = p;
  vNormal = uLit ? normalAt(c, k, p) : vec3(0.0, 0.0, 1.0);
}
`;

/** Colours from the palette's lookup table, low value at entry 0, shaded when lit. */
const SHADE_FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;

uniform sampler2D uPalette;
uniform int uPaletteSize;
uniform bool uLit;
uniform vec3 uEye;
uniform vec3 uLightDir;
uniform float uAmbient;
uniform float uIntensity;
uniform float uSpecular;
uniform float uShininess;
uniform bool uShadows;
uniform sampler2DShadow uShadowMap;
uniform mat4 uLightMvp;
uniform float uShadowTexel;
uniform float uNormalBias;

in float vLevel;
in vec3 vPos;
in vec3 vNormal;
out vec4 color;

// 1 lit, 0 in shadow: a 3x3 filtered look-up in the light's depth map.
float lightAt(vec3 p, vec3 n) {
  vec4 q = uLightMvp * vec4(p + n * uNormalBias, 1.0);
  vec3 s = q.xyz / q.w * 0.5 + 0.5;
  if (any(lessThan(s, vec3(0.0))) || any(greaterThan(s, vec3(1.0)))) {
    return 1.0;
  }
  float sum = 0.0;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      sum += texture(uShadowMap, vec3(s.xy + vec2(float(i), float(j)) * uShadowTexel, s.z));
    }
  }
  return sum / 9.0;
}

void main() {
  int i = int(vLevel * float(uPaletteSize - 1) + 0.5);
  vec3 base = texelFetch(uPalette, ivec2(i, 0), 0).rgb;
  if (!uLit) {
    color = vec4(base, 1.0);
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vPos);
  // Two-sided: the side facing the eye is the one lit.
  if (dot(n, v) < 0.0) {
    n = -n;
  }
  vec3 l = normalize(uLightDir);
  float diffuse = max(dot(n, l), 0.0);
  float highlight = diffuse > 0.0 ? pow(max(dot(n, normalize(l + v)), 0.0), uShininess) : 0.0;
  float lit = uShadows ? lightAt(vPos, n) : 1.0;
  color = vec4(base * (uAmbient + uIntensity * diffuse * lit) + vec3(uSpecular * highlight * lit), 1.0);
}
`;

/** Depth only. */
const DEPTH_FS = `#version 300 es
precision mediump float;
void main() {}
`;

/** The 12 edges of a box from `gl_VertexID`; corner bits are x, y, z. */
const BOX_VS = `#version 300 es
precision highp float;

uniform mat4 uMvp;
uniform vec3 uMin;
uniform vec3 uMax;

const int EDGES[24] = int[24](0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7);

void main() {
  int i = EDGES[gl_VertexID];
  vec3 t = vec3(float(i & 1), float((i >> 1) & 1), float((i >> 2) & 1));
  gl_Position = uMvp * vec4(mix(uMin, uMax, t), 1.0);
}
`;

const BOX_FS = `#version 300 es
precision mediump float;

uniform vec3 uColor;
out vec4 color;

void main() {
  color = vec4(uColor, 1.0);
}
`;

/** Texture units. */
const RING_UNIT = 0;
const PALETTE_UNIT = 1;
const SHADOW_UNIT = 2;
/** The receiver moves this many shadow-map texels along its normal before the look-up, against acne. */
const NORMAL_BIAS_TEXELS = 1.5;

/** Vertices per draw call at most; a multiple of 6, so a draw ends on a whole quad. */
const MAX_DRAW_VERTICES = 6 * 2 ** 20;
/** The largest profile store the renderer tries for; the budgets ask for no more. */
const PROBE_MAX_BYTES = 256 * 2 ** 20;
/** Below this a store is not tried: the card is too short of memory to be worth halving further. */
const PROBE_MIN_BYTES = 8 * 2 ** 20;

/** The card refused the profile store: it holds at most `maxBytes` now (already lowered). */
export class GpuMemoryError extends Error {
  constructor(readonly maxBytes: number) {
    super('the graphics card has no room for this many profiles');
  }
}

export interface GpuLimits {
  maxTextureSize: number;
  maxLayers: number;
  /**
   * The largest profile store (16-bit values, bytes) the card took when the renderer was made,
   * halved again whenever a store is refused later.
   */
  maxBytes: number;
  /** Smallest and largest point size, in device pixels. */
  pointSize: [number, number];
}

/** Which held values one pass draws. */
export interface DrawGrid {
  /** Columns drawn per profile, and the strides between drawn columns and profiles. */
  cols: number;
  colStride: number;
  rowStride: number;
  kStart: number;
  /** Profiles drawn. */
  count: number;
}

export interface DrawLight {
  /** Toward the light, in the world. */
  dir: Vec3;
  intensity: number;
  ambient: number;
  specular: number;
  shininess: number;
  /** The light's view and projection, the map's edge in texels, and what casts. */
  shadow: { mvp: Mat4; size: number; grid: DrawGrid } | null;
}

/** One frame's worth of drawing. */
export interface CloudDraw {
  layout: RingLayout;
  oldestSlot: number;
  /** Columns and profiles held. */
  width: number;
  filled: number;
  mode: RenderMode;
  grid: DrawGrid;
  mvp: Mat4;
  eye: Vec3;
  /** `position = vec3(column, k, value) * scale + offset`. */
  scale: Vec3;
  offset: Vec3;
  /** Values mapped to `lo` and `hi`. */
  window: [number, number];
  /** Device pixels. */
  pointSize: number;
  /** Surface triangles spanning more than this share of the window are left out. */
  jump: number;
  light: DrawLight | null;
  box: Bounds | null;
  boxColor: Vec3;
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export class CloudRenderer {
  readonly limits: GpuLimits;
  private points!: Program;
  private surface!: Program;
  private depth!: Program;
  private box!: Program;
  private vao!: WebGLVertexArrayObject;
  private texture: WebGLTexture | null = null;
  private paletteTexture: WebGLTexture | null = null;
  /** The light's depth map; 1×1 until shadows are on, as the shadow sampler always needs one. */
  private shadowTexture: WebGLTexture | null = null;
  private shadowFbo: WebGLFramebuffer | null = null;
  private shadowSize = 0;
  /** The palette's RGBA8 entries, kept to upload again after a lost context. */
  private palette: Uint8Array = new Uint8Array([255, 255, 255, 255]);

  private constructor(private readonly gl: WebGL2RenderingContext) {
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
    this.limits = {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
      maxBytes: 0,
      pointSize: [range[0], range[1]],
    };
    this.limits.maxBytes = this.probeStore();
    this.build();
  }

  /** A renderer for `canvas`, or `null` without WebGL2. Throws if the shaders don't build. */
  static create(canvas: HTMLCanvasElement): CloudRenderer | null {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    return gl ? new CloudRenderer(gl) : null;
  }

  /** After a lost context came back: everything GPU-side is gone and is built again. */
  restore(): void {
    this.texture = null;
    this.build();
  }

  /** Colour values through `lut`: RGBA8 entries, the lowest value's first (see `paletteLut`). */
  setPalette(lut: Uint8Array): void {
    this.palette = lut;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lut.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  /** A texture for `layout`, zero-filled (WebGL initialises storage). */
  allocate(layout: RingLayout): void {
    const gl = this.gl;
    if (this.texture) {
      gl.deleteTexture(this.texture);
    }
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.drainErrors();
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R16UI, layout.width, layout.layerRows, layout.layers);
    if (gl.getError() === gl.OUT_OF_MEMORY) {
      gl.deleteTexture(this.texture);
      this.texture = null;
      // Less than the probe found (other pages and tabs share the card): ask for half next time.
      const bytes = layout.width * layout.layerRows * layout.layers * 2;
      this.limits.maxBytes = Math.max(PROBE_MIN_BYTES, Math.min(this.limits.maxBytes, bytes) / 2);
      throw new GpuMemoryError(this.limits.maxBytes);
    }
  }

  /**
   * The largest profile store the card takes, halving from `PROBE_MAX_BYTES`: a browser or
   * card short of memory refuses large textures with `OUT_OF_MEMORY` rather than a limit it
   * reports up front.
   */
  private probeStore(): number {
    const gl = this.gl;
    const width = Math.min(4096, this.limits.maxTextureSize);
    for (let bytes = PROBE_MAX_BYTES; bytes > PROBE_MIN_BYTES; bytes /= 2) {
      let layout: RingLayout;
      try {
        layout = ringLayout(width, Math.floor(bytes / (2 * width)), this.limits.maxTextureSize, this.limits.maxLayers);
      } catch {
        continue;
      }
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      this.drainErrors();
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R16UI, layout.width, layout.layerRows, layout.layers);
      const failed = gl.getError() !== gl.NO_ERROR;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      gl.deleteTexture(texture);
      if (!failed) {
        return bytes;
      }
    }
    return PROBE_MIN_BYTES;
  }

  /** `getError` reports the oldest error: clear any left over so the next check is about the next call. */
  private drainErrors(): void {
    const gl = this.gl;
    for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++) {
      // Cleared.
    }
  }

  /** Copy the `segments` of `mirror` (slot after slot, `width` values each) to the texture. */
  upload(segments: RowSegment[], mirror: Uint16Array, width: number): void {
    if (!this.texture || segments.length === 0) {
      return;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    // Rows of 16-bit values: an odd width isn't 4-byte aligned.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    for (const s of segments) {
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY, 0, 0, s.y, s.layer, width, s.rows, 1,
        gl.RED_INTEGER, gl.UNSIGNED_SHORT, mirror, s.slot * width,
      );
    }
  }

  /** Release the stored profiles (nothing is drawn until the next `allocate`). */
  release(): void {
    if (this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
  }

  clear(width: number, height: number): void {
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  draw(width: number, height: number, d: CloudDraw): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    const shadow = d.light?.shadow ?? null;
    const drawable = !!this.texture && d.filled > 0;
    if (drawable && shadow) {
      this.drawShadowMap(d, shadow);
    }

    this.clear(width, height);
    if (d.box) {
      // Behind everything, so the points are never hidden by their own frame.
      gl.disable(gl.DEPTH_TEST);
      const u = this.box.uniforms;
      gl.useProgram(this.box.program);
      gl.uniformMatrix4fv(u['uMvp'], false, d.mvp);
      gl.uniform3fv(u['uMin'], d.box.min);
      gl.uniform3fv(u['uMax'], d.box.max);
      gl.uniform3fv(u['uColor'], d.boxColor);
      gl.drawArrays(gl.LINES, 0, 24);
    }

    const vertices = this.vertexCount(d.mode, d.grid);
    if (drawable && vertices > 0) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      const p = d.mode === 'surface' ? this.surface : this.points;
      gl.useProgram(p.program);
      this.setGrid(p, d, d.grid, d.mvp, !!d.light);
      const u = p.uniforms;
      gl.uniform1f(u['uPointSize'], d.pointSize);
      gl.uniform1f(u['uJump'], d.jump);
      gl.activeTexture(gl.TEXTURE0 + PALETTE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
      gl.uniform1i(u['uPalette'], PALETTE_UNIT);
      gl.uniform1i(u['uPaletteSize'], this.palette.length / 4);
      gl.activeTexture(gl.TEXTURE0 + SHADOW_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
      gl.uniform1i(u['uShadowMap'], SHADOW_UNIT);
      gl.uniform3fv(u['uEye'], d.eye);
      const light = d.light;
      if (light) {
        gl.uniform3fv(u['uLightDir'], light.dir);
        gl.uniform1f(u['uAmbient'], light.ambient);
        gl.uniform1f(u['uIntensity'], light.intensity);
        gl.uniform1f(u['uSpecular'], light.specular);
        gl.uniform1f(u['uShininess'], light.shininess);
      }
      gl.uniform1i(u['uShadows'], shadow ? 1 : 0);
      if (shadow && d.box) {
        const texelWorld = (2 * radius(d.box)) / shadow.size;
        gl.uniformMatrix4fv(u['uLightMvp'], false, shadow.mvp);
        gl.uniform1f(u['uShadowTexel'], 1 / shadow.size);
        gl.uniform1f(u['uNormalBias'], NORMAL_BIAS_TEXELS * texelWorld);
      }
      this.drawSplit(p, d.mode === 'surface' ? gl.TRIANGLES : gl.POINTS, vertices);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    this.release();
    gl.deleteTexture(this.paletteTexture);
    gl.deleteTexture(this.shadowTexture);
    gl.deleteFramebuffer(this.shadowFbo);
    for (const p of [this.points, this.surface, this.depth, this.box]) {
      gl.deleteProgram(p.program);
    }
    gl.deleteVertexArray(this.vao);
    // Hand the context back now rather than at garbage collection: each one holds memory on the
    // card, and the tab makes a new one every time it is opened.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** The surface as the light sees it, into the depth map. */
  private drawShadowMap(d: CloudDraw, shadow: NonNullable<DrawLight['shadow']>): void {
    const vertices = this.vertexCount('surface', shadow.grid);
    if (vertices === 0) {
      return;
    }
    const gl = this.gl;
    this.sizeShadowMap(shadow.size);
    // The map must not be bound for sampling while it is drawn to.
    gl.activeTexture(gl.TEXTURE0 + SHADOW_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, shadow.size, shadow.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // Slope-scaled bias against acne on surfaces the light grazes.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2, 4);
    gl.useProgram(this.depth.program);
    this.setGrid(this.depth, d, shadow.grid, shadow.mvp, false);
    gl.uniform1f(this.depth.uniforms['uJump'], d.jump);
    this.drawSplit(this.depth, gl.TRIANGLES, vertices);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * `vertices` of the grid in draws of at most `MAX_DRAW_VERTICES`: some drivers drop a single
   * draw of about 2^25 vertices or more without an error, which erased dense clouds. Each draw
   * tells the shader where it starts (`uFirst`) rather than relying on `first` reaching
   * `gl_VertexID`.
   */
  private drawSplit(p: Program, mode: GLenum, vertices: number): void {
    const gl = this.gl;
    for (let first = 0; first < vertices; first += MAX_DRAW_VERTICES) {
      gl.uniform1i(p.uniforms['uFirst'], first);
      gl.drawArrays(mode, 0, Math.min(MAX_DRAW_VERTICES, vertices - first));
    }
  }

  private vertexCount(mode: RenderMode, g: DrawGrid): number {
    if (g.cols <= 0 || g.count <= 0) {
      return 0;
    }
    return mode === 'surface' ? Math.max(0, g.cols - 1) * Math.max(0, g.count - 1) * 6 : g.cols * g.count;
  }

  /** The uniforms every grid program shares. */
  private setGrid(p: Program, d: CloudDraw, g: DrawGrid, mvp: Mat4, lit: boolean): void {
    const gl = this.gl;
    const u = p.uniforms;
    gl.activeTexture(gl.TEXTURE0 + RING_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.uniform1i(u['uRing'], RING_UNIT);
    gl.uniform1i(u['uCols'], g.cols);
    gl.uniform1i(u['uColStride'], g.colStride);
    gl.uniform1i(u['uRowStride'], g.rowStride);
    gl.uniform1i(u['uKStart'], g.kStart);
    gl.uniform1i(u['uOldest'], d.oldestSlot);
    gl.uniform1i(u['uCapacity'], d.layout.capacity);
    gl.uniform1i(u['uLayerRows'], d.layout.layerRows);
    gl.uniform1i(u['uWidth'], d.width);
    gl.uniform1i(u['uFilled'], d.filled);
    gl.uniform1ui(u['uInvalid'], 0);
    gl.uniform3fv(u['uScale'], d.scale);
    gl.uniform3fv(u['uOffset'], d.offset);
    gl.uniformMatrix4fv(u['uMvp'], false, mvp);
    gl.uniform2f(u['uWindow'], d.window[0], d.window[1]);
    gl.uniform1i(u['uLit'], lit ? 1 : 0);
  }

  /** A depth map `size` texels square, filtered by comparison (so the shader's look-ups are PCF). */
  private sizeShadowMap(size: number): void {
    if (this.shadowSize === size) {
      return;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.shadowSize = size;
  }

  private build(): void {
    const gl = this.gl;
    this.points = program(gl, POINTS_VS, SHADE_FS);
    this.surface = program(gl, SURFACE_VS, SHADE_FS);
    this.depth = program(gl, SURFACE_VS, DEPTH_FS);
    this.box = program(gl, BOX_VS, BOX_FS);
    // Points, triangles and box come from gl_VertexID alone; an empty VAO is all a draw needs.
    this.vao = gl.createVertexArray()!;
    this.paletteTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.setPalette(this.palette);

    this.shadowTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowSize = 0;
    this.sizeShadowMap(1);
    this.shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}

/** A linked program and the locations of all its active uniforms. */
function program(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`point cloud shaders: ${gl.getProgramInfoLog(p)}`);
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  const count = (gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number | null) ?? 0;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    if (info) {
      const name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = gl.getUniformLocation(p, name);
    }
  }
  return { program: p, uniforms };
}

function shader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`point cloud shader: ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}
