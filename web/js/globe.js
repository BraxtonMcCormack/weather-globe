// Three.js globe: base imagery, data overlay shader, coastlines, atmosphere, stars.
//
// Coordinate convention (matches THREE.SphereGeometry's UVs):
//   x = cos(lat) cos(lon), y = sin(lat), z = -cos(lat) sin(lon)
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

const DEG = Math.PI / 180;

export function latLonToVec3(lat, lon, r = 1, out = new THREE.Vector3()) {
  const la = lat * DEG, lo = lon * DEG, c = Math.cos(la);
  return out.set(r * c * Math.cos(lo), r * Math.sin(la), -r * c * Math.sin(lo));
}

export function vec3ToLatLon(v) {
  const n = v.clone().normalize();
  return { lat: Math.asin(Math.max(-1, Math.min(1, n.y))) / DEG, lon: Math.atan2(-n.z, n.x) / DEG };
}

const globeVert = /* glsl */`
  varying vec2 vUv;
  varying vec3 vPos;
  varying vec3 vViewNormal;
  void main() {
    vUv = uv;
    vPos = position;
    vViewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const globeFrag = /* glsl */`
  precision highp float;
  #define PI 3.141592653589793
  varying vec2 vUv;
  varying vec3 vPos;
  varying vec3 vViewNormal;

  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform int baseMode;           // 0 satellite, 1 dark
  uniform bool daylight;
  uniform vec3 sunDir;

  uniform sampler2D dataTex;
  uniform vec2 dataSize;
  uniform float hasData;
  uniform sampler2D cmap;
  uniform sampler2D cmapAux;
  uniform bool useAuxCmap;
  uniform vec2 range;
  uniform float gamma;
  uniform float opacity;
  uniform float contourInterval;
  uniform bool edgeOn;
  uniform float edgeN;
  uniform float edgeS;
  uniform bool graticule;

  float gridLine(float v, float interval, float width) {
    float f = v / interval;
    float d = abs(fract(f + 0.5) - 0.5) / max(fwidth(f), 1e-6);
    return 1.0 - smoothstep(width * 0.5, width * 0.5 + 1.0, d);
  }

  void main() {
    vec3 n = normalize(vPos);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lon = atan(-n.z, n.x);
    float lon01 = fract(lon / (2.0 * PI) + 1.0);

    // Base map
    vec3 day = texture2D(dayMap, vUv).rgb;
    vec3 base = day;
    if (baseMode == 1) {
      float l = dot(day, vec3(0.299, 0.587, 0.114));
      base = mix(vec3(0.035, 0.05, 0.08), vec3(0.16, 0.19, 0.24), smoothstep(0.05, 0.6, l));
    }
    if (daylight) {
      vec3 night = texture2D(nightMap, vUv).rgb;
      float s = dot(n, sunDir);
      float k = smoothstep(-0.10, 0.10, s);
      vec3 nightCol = base * 0.10 + night * vec3(1.0, 0.85, 0.6) * 0.9;
      base = mix(nightCol, base, k);
    }

    // Data overlay, sampled with exact grid-cell centres (row 0 = 90N, col 0 = 0E).
    vec2 duv = vec2(lon01 + 0.5 / dataSize.x,
                    ((0.5 * PI - lat) / PI * (dataSize.y - 1.0) + 0.5) / dataSize.y);
    vec4 d = texture2D(dataTex, duv);
    vec3 col = base;
    if (hasData > 0.5) {
      float t = pow(clamp((d.r - range.x) / (range.y - range.x), 0.0, 1.0), gamma);
      vec4 c = (useAuxCmap && d.g > 0.5) ? texture2D(cmapAux, vec2(t, 0.5)) : texture2D(cmap, vec2(t, 0.5));
      col = mix(base, c.rgb, c.a * opacity);
      if (contourInterval > 0.0) {
        col = mix(col, vec3(1.0), gridLine(d.r, contourInterval, 1.0) * 0.38);
      }
      if (edgeOn && abs(lat) > 30.0 * PI / 180.0) {
        float e = lat > 0.0 ? edgeN : edgeS;
        float dist = abs(d.g - e) / max(fwidth(d.g), 1e-6);
        col = mix(col, vec3(0.02, 0.0, 0.08), (1.0 - smoothstep(2.0, 4.5, dist)) * 0.55);
        col = mix(col, vec3(1.0, 0.97, 0.9), 1.0 - smoothstep(1.0, 2.2, dist));
      }
    }

    if (graticule) {
      float latDeg = lat * 180.0 / PI, lonDeg = lon01 * 360.0;
      float g = max(gridLine(latDeg, 15.0, 0.8), gridLine(lonDeg, 15.0, 0.8));
      col = mix(col, vec3(0.75, 0.85, 1.0), g * 0.22);
      float p60 = gridLine(abs(latDeg) - 60.0 + 1000.0, 1000.0, 1.4);
      col = mix(col, vec3(1.0, 0.8, 0.4), p60 * 0.5);
    }

    // Gentle limb darkening for depth.
    float rim = clamp(vViewNormal.z, 0.0, 1.0);
    col *= mix(0.72, 1.0, pow(rim, 0.6));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const atmoVert = /* glsl */`
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const atmoFrag = /* glsl */`
  varying vec3 vNormal;
  void main() {
    float i = pow(0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 4.0);
    gl_FragColor = vec4(0.35, 0.62, 1.0, 1.0) * i * 1.6;
  }
`;

export class Globe {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.camera.position.copy(latLonToVec3(48, -60, 3.4));

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.08;
    this.controls.maxDistance = 8;
    this.controls.zoomSpeed = 0.8;

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const loader = new THREE.TextureLoader();
    const loadTex = url => loader.load(url, t => {
      t.anisotropy = maxAniso;
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
    });

    this.floatLinear = !!this.renderer.extensions.get('OES_texture_float_linear');
    const emptyData = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGFormat, THREE.FloatType);
    this.uniforms = {
      dayMap: { value: loadTex('assets/bluemarble_8k.jpg') },
      nightMap: { value: loadTex('assets/blackmarble_8k.jpg') },
      baseMode: { value: 0 },
      daylight: { value: false },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      dataTex: { value: emptyData },
      dataSize: { value: new THREE.Vector2(1, 1) },
      hasData: { value: 0 },
      cmap: { value: null },
      cmapAux: { value: null },
      useAuxCmap: { value: false },
      range: { value: new THREE.Vector2(0, 1) },
      gamma: { value: 1 },
      opacity: { value: 0.85 },
      contourInterval: { value: 0 },
      edgeOn: { value: false },
      edgeN: { value: 0 },
      edgeS: { value: 0 },
      graticule: { value: false },
    };
    const sphere = new THREE.SphereGeometry(1, 360, 180);
    this.globe = new THREE.Mesh(sphere, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: globeVert, fragmentShader: globeFrag,
    }));
    this.scene.add(this.globe);

    const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.07, 96, 48), new THREE.ShaderMaterial({
      vertexShader: atmoVert, fragmentShader: atmoFrag, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    this.scene.add(atmo);
    this.addStars();

    this.borders = new THREE.Group();
    this.scene.add(this.borders);
    this.loadBorders();

    this.markerGroup = new THREE.Group();
    this.scene.add(this.markerGroup);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  addStars() {
    const n = 4000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 20);
      pos.set([v.x, v.y, v.z], i * 3);
      const b = 0.35 + Math.random() ** 3 * 0.65;
      col.set([b * 0.9, b * 0.95, b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true })));
  }

  async loadBorders() {
    const [land, countries] = await Promise.all([
      fetch('assets/land-50m.json').then(r => r.json()),
      fetch('assets/countries-50m.json').then(r => r.json()),
    ]);
    const coast = topojson.mesh(land, land.objects.land);
    const borders = topojson.mesh(countries, countries.objects.countries, (a, b) => a !== b);
    this.borders.add(this.lineMesh(coast, 1.0006, 0xffffff, 0.55));
    this.borders.add(this.lineMesh(borders, 1.0006, 0xffffff, 0.22));
  }

  lineMesh(mls, r, color, opacity) {
    const pts = [];
    const v = new THREE.Vector3();
    for (const line of mls.coordinates) {
      for (let i = 0; i < line.length - 1; i++) {
        const [lo0, la0] = line[i], [lo1, la1] = line[i + 1];
        if (Math.abs(lo1 - lo0) > 180) continue;
        latLonToVec3(la0, lo0, r, v); pts.push(v.x, v.y, v.z);
        latLonToVec3(la1, lo1, r, v); pts.push(v.x, v.y, v.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  }

  /** Upload a scalar (and optional auxiliary) grid as an RG float texture. */
  setData(values, aux, nx, ny) {
    const rg = new Float32Array(nx * ny * 2);
    for (let i = 0; i < nx * ny; i++) {
      rg[i * 2] = values[i];
      rg[i * 2 + 1] = aux ? aux[i] : 0;
    }
    const prev = this.uniforms.dataTex.value;
    const tex = new THREE.DataTexture(rg, nx, ny, THREE.RGFormat, THREE.FloatType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = tex.minFilter = this.floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.uniforms.dataTex.value = tex;
    this.uniforms.dataSize.value.set(nx, ny);
    this.uniforms.hasData.value = 1;
    prev?.dispose();
  }

  setColormap(slot, rgba) {
    const tex = new THREE.DataTexture(rgba, rgba.length / 4, 1, THREE.RGBAFormat);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.uniforms[slot].value?.dispose?.();
    this.uniforms[slot].value = tex;
  }

  setSun(date) {
    // Low-precision solar position (accurate to ~0.01 deg; plenty for a terminator).
    const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
    const g = (357.529 + 0.98560028 * d) * DEG;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const e = (23.439 - 0.00000036 * d) * DEG;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / DEG;
    const dec = Math.asin(Math.sin(e) * Math.sin(L)) / DEG;
    let eqt = (q - ra) % 360; if (eqt > 180) eqt -= 360; if (eqt < -180) eqt += 360;
    const utcH = date.getUTCHours() + date.getUTCMinutes() / 60;
    const lon = -15 * (utcH - 12) - eqt;
    latLonToVec3(dec, lon, 1, this.uniforms.sunDir.value);
  }

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, dir = ray.ray.direction;
    const b = o.dot(dir), c = o.dot(o) - 1, disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    return vec3ToLatLon(o.clone().addScaledVector(dir, t));
  }

  flyTo(lat, lon, dist, ms = 1600) {
    const start = this.camera.position.clone();
    const startDist = start.length();
    const target = latLonToVec3(Math.max(-89.6, Math.min(89.6, lat)), lon, 1);
    const from = start.clone().normalize();
    const t0 = performance.now();
    this.flight = now => {
      let k = Math.min(1, (now - t0) / ms);
      k = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const dirv = from.clone().lerp(target, k).normalize();
      this.camera.position.copy(dirv.multiplyScalar(startDist + (dist - startDist) * k));
      if (k >= 1) this.flight = null;
    };
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(now) {
    if (this.flight) this.flight(now);
    const dist = this.camera.position.length();
    this.controls.rotateSpeed = Math.min(1, 0.35 * (dist - 1) + 0.05);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
