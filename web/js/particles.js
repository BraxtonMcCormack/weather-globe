// Wind-flow particles advected on the sphere in 3-D (stable at the poles),
// drawn as fading trails. Each particle owns TRAIL ring-buffer slots; the
// segment joining the newest and oldest slot is collapsed in the shader.
import * as THREE from 'three';

const TRAIL = 24;
const R_EARTH = 6371000;
const RADIUS = 1.0025;

const vert = /* glsl */`
  attribute float slot;
  attribute float seg;
  attribute float speed;
  uniform float head;
  uniform float trail;
  uniform float maxSpeed;
  varying float vAlpha;
  varying float vSpeed;
  void main() {
    float age = mod(head - slot + trail, trail);
    vAlpha = seg == head ? 0.0 : pow(1.0 - age / (trail - 1.0), 1.4);
    vSpeed = clamp(speed / maxSpeed, 0.0, 1.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    if (seg == head) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const frag = /* glsl */`
  varying float vAlpha;
  varying float vSpeed;
  uniform float brightness;
  void main() {
    vec3 slow = vec3(0.75, 0.85, 1.0);
    vec3 fast = vec3(1.0, 1.0, 1.0);
    float a = vAlpha * mix(0.45, 1.0, vSpeed) * brightness;
    gl_FragColor = vec4(mix(slow, fast, vSpeed), a);
  }
`;

export class Particles {
  constructor(scene, camera, count = 15000) {
    this.camera = camera;
    this.count = count;
    this.u = this.v = null;
    this.nx = this.ny = 0;
    this.secondsPerFrame = 1500;
    this.speedMul = 1;
    this.head = 0;

    const nVerts = count * TRAIL * 2;
    this.pos = new Float32Array(nVerts * 3);
    this.spd = new Float32Array(nVerts);
    const slot = new Float32Array(nVerts), seg = new Float32Array(nVerts);
    for (let p = 0; p < count; p++) {
      for (let s = 0; s < TRAIL; s++) {
        const i = (p * TRAIL + s) * 2;
        seg[i] = seg[i + 1] = s;
        slot[i] = s;
        slot[i + 1] = (s + 1) % TRAIL;
      }
    }
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.spdAttr = new THREE.BufferAttribute(this.spd, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('speed', this.spdAttr);
    g.setAttribute('slot', new THREE.BufferAttribute(slot, 1));
    g.setAttribute('seg', new THREE.BufferAttribute(seg, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.1);

    this.uniforms = {
      head: { value: 0 }, trail: { value: TRAIL }, maxSpeed: { value: 30 }, brightness: { value: 1.7 },
    };
    this.mesh = new THREE.LineSegments(g, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vert, fragmentShader: frag,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    // Particle state: unit-sphere position + remaining life.
    this.p = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    for (let i = 0; i < count; i++) this.respawn(i, true);
  }

  setField(u, v, nx, ny, level) {
    this.u = u; this.v = v; this.nx = nx; this.ny = ny;
    this.secondsPerFrame = level.secondsPerFrame;
    this.uniforms.maxSpeed.value = level.maxSpeed;
  }

  set visible(b) { this.mesh.visible = b; }
  get visible() { return this.mesh.visible; }

  respawn(i, initial = false) {
    // Mostly spawn inside the spherical cap visible from the camera, so the
    // density stays high when zoomed in; the rest go anywhere on the globe.
    const cam = this.camera.position;
    const cl = cam.length() || 3;
    const cx = cam.x / cl, cy = cam.y / cl, cz = cam.z / cl;
    const capCos = Math.random() < 0.85 ? 1 / cl : -1;
    const z0 = capCos + Math.random() * (1 - capCos);   // uniform in the cap
    const t = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z0 * z0);
    // Build a basis around the camera direction.
    let ax = Math.abs(cy) < 0.9 ? 0 : 1, ay = Math.abs(cy) < 0.9 ? 1 : 0;
    let ux = ay * cz, uy = -ax * cz, uz = ax * cy - ay * cx;
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const vx = cy * uz - cz * uy, vy = cz * ux - cx * uz, vz = cx * uy - cy * ux;
    const a = r * Math.cos(t), b = r * Math.sin(t);
    const x = cx * z0 + ux * a + vx * b, y = cy * z0 + uy * a + vy * b, z = cz * z0 + uz * a + vz * b;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.life[i] = initial ? Math.random() * 200 : 90 + Math.random() * 110;
    // Collapse the whole trail onto the new point.
    const base = i * TRAIL * 2 * 3;
    for (let k = 0; k < TRAIL * 2; k++) {
      this.pos[base + k * 3] = x * RADIUS;
      this.pos[base + k * 3 + 1] = y * RADIUS;
      this.pos[base + k * 3 + 2] = z * RADIUS;
      this.spd[i * TRAIL * 2 + k] = 0;
    }
  }

  sample(lat, lon) {
    // Bilinear sample of u/v on the 0.5° grid (row 0 = 90N, col 0 = 0E).
    const nx = this.nx, ny = this.ny, res = 180 / (ny - 1);
    const y = Math.min(ny - 1.0001, Math.max(0, (90 - lat) / res));
    const x = ((lon % 360) + 360) % 360 / res;
    const x0 = Math.floor(x) % nx, y0 = Math.floor(y), fx = x - Math.floor(x), fy = y - y0;
    const x1 = (x0 + 1) % nx;
    const i00 = y0 * nx + x0, i01 = y0 * nx + x1, i10 = i00 + nx, i11 = i01 + nx;
    const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
    const u = this.u, v = this.v;
    return [u[i00] * w00 + u[i01] * w01 + u[i10] * w10 + u[i11] * w11,
            v[i00] * w00 + v[i01] * w01 + v[i10] * w10 + v[i11] * w11];
  }

  step() {
    if (!this.u || !this.mesh.visible) return;
    const h = (this.head + 1) % TRAIL;
    this.head = h;
    const prevSeg = (h - 1 + TRAIL) % TRAIL;
    // Scale with zoom so the flow moves at a steady on-screen speed.
    const zoom = Math.min(1.4, Math.max(0.06, (this.camera.position.length() - 1) / 2.4));
    const dt = this.secondsPerFrame * this.speedMul * zoom / R_EARTH;
    const RAD = 180 / Math.PI;
    const p = this.p;
    for (let i = 0; i < this.count; i++) {
      let x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      if (--this.life[i] <= 0) { this.respawn(i); continue; }
      const lat = Math.asin(Math.max(-1, Math.min(1, y))) * RAD;
      const lonr = Math.atan2(-z, x);
      const [u, v] = this.sample(lat, lonr * RAD);
      // Local east / north unit vectors.
      const sl = Math.sin(lonr), cl = Math.cos(lonr);
      const sp = y, cp = Math.sqrt(Math.max(0, 1 - y * y));
      const ex = -sl, ez = -cl;
      const nx_ = -sp * cl, ny_ = cp, nz_ = sp * sl;
      x += (u * ex + v * nx_) * dt;
      y += (v * ny_) * dt;
      z += (u * ez + v * nz_) * dt;
      const inv = 1 / Math.hypot(x, y, z);
      x *= inv; y *= inv; z *= inv;
      p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
      const s = Math.hypot(u, v);
      // New head point is the start of segment h and the end of segment h-1.
      const a = ((i * TRAIL + h) * 2) , b = ((i * TRAIL + prevSeg) * 2 + 1);
      this.pos[a * 3] = this.pos[b * 3] = x * RADIUS;
      this.pos[a * 3 + 1] = this.pos[b * 3 + 1] = y * RADIUS;
      this.pos[a * 3 + 2] = this.pos[b * 3 + 2] = z * RADIUS;
      this.spd[a] = this.spd[b] = s;
    }
    this.uniforms.head.value = h;
    this.posAttr.needsUpdate = true;
    this.spdAttr.needsUpdate = true;
  }
}
