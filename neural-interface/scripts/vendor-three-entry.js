// Vendor bundle entry — only the parts of three.js the memory map uses, plus
// OrbitControls, as one tree-shaken ESM file. Built by scripts/build-vendor.mjs
// into public/vendor/three/ and mapped to the bare specifier `three` by the
// import map in public/index.html.
export {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineSegments,
  Matrix4,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
