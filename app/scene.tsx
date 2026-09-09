import { useEffect, useRef } from "react";
import * as T from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createExplosionLayout } from "./explosion-layout";
import { decodeModelResponse } from "./model-download";
import { PointerTap } from "./pointer-tap";
import {
  SYSTEMS,
  bodyBounds,
  partInArea,
  partIsVisible,
  partRegion,
  type Atlas,
  type Part,
  type SceneState,
} from "./anatomy";
interface Props {
  atlas: Atlas;
  state: SceneState;
  onSelect: (id: string) => void;
  onProgress: (n: number) => void;
  onError: (s: string) => void;
}
export default function AnatomyScene({ atlas, state, onSelect, onProgress, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(state);
  const select = useRef(onSelect);
  latest.current = state;
  select.current = onSelect;
  useEffect(() => {
    const el = host.current!;
    let disposed = false;
    let frame = 0;
    let dirty = true;
    let ready = false;
    let lastView = "";
    let lastReset = -1;
    let lastIsolate = "";
    let lastRegion: SceneState["region"] | undefined;
    let lastArea: SceneState["area"] | undefined;
    let layoutKey = "";
    let amount = 0;
    let lastState: SceneState | null = null;
    let wasMoving = false;
    let preCameraPosition: T.Vector3 | null = null;
    let preCameraTarget: T.Vector3 | null = null;
    let preCameraMaxDistance = 40;
    const abort = new AbortController();
    let renderer: T.WebGLRenderer;
    try {
      renderer = new T.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      onError(
        "This browser could not start the 3D viewer. Please try a browser with WebGL enabled."
      );
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 768 ? 1.5 : 2));
    renderer.setClearColor("#f2f3f3");
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute(
      "aria-label",
      "Interactive human anatomy. Drag to orbit, pinch or scroll to zoom, and tap a structure to inspect it."
    );
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(34, 1, 0.005, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    camera.position.set(1.4, 1.05, 3.6);
    controls.target.set(0, 0.85, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.zoomToCursor = true;
    controls.minDistance = 0.07;
    controls.maxDistance = 40;
    controls.maxPolarAngle = Math.PI * 0.96;
    controls.addEventListener("change", () => {
      dirty = true;
    });
    const heldKeys = new Set<string>();
    const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
    window.addEventListener("keydown", (e) => {
      if (!ARROW_KEYS.has(e.key)) return;
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) return;
      e.preventDefault();
      heldKeys.add(e.key);
    }, { signal: abort.signal });
    window.addEventListener("keyup", (e) => { heldKeys.delete(e.key); }, { signal: abort.signal });
    const pmrem = new T.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04);
    scene.environment = env.texture;
    room.dispose();
    pmrem.dispose();
    scene.add(new T.HemisphereLight(0xffffff, 0xa7acb2, 1.05));
    const key = new T.DirectionalLight(0xfffaf4, 2.3);
    key.position.set(-2, 4, 3);
    scene.add(key);
    const rim = new T.DirectionalLight(0xe9f0ff, 1.8);
    rim.position.set(2, 2, -3);
    scene.add(rim);

    const width = T.MathUtils.ceilPowerOfTwo(atlas.parts.length);
    const data = new Float32Array(width * 4);
    const partTexture = new T.DataTexture(data, width, 1, T.RGBAFormat, T.FloatType);
    partTexture.needsUpdate = true;
    const selectedData = new Uint8Array(width * 4);
    const selectionTexture = new T.DataTexture(selectedData, width, 1);
    selectionTexture.needsUpdate = true;
    const materials: T.Material[] = [];
    const geometries: T.BufferGeometry[] = [];
    const pickers: (T.Mesh | undefined)[] = [];
    const centers = atlas.parts.map((p) =>
      new T.Vector3()
        .fromArray(p.bounds[0])
        .add(new T.Vector3().fromArray(p.bounds[1]))
        .multiplyScalar(0.5)
    );
    const offsets: T.Vector3[] = [];
    const bounds = atlas.parts.map(
      (p) =>
        new T.Box3(new T.Vector3().fromArray(p.bounds[0]), new T.Vector3().fromArray(p.bounds[1]))
    );
    let packingWidth = 1;
    let packingHeight = 1;
    const markerPositions = new Float32Array(atlas.parts.length * 3);
    const markerGeometry = new T.BufferGeometry();
    markerGeometry.setAttribute("position", new T.BufferAttribute(markerPositions, 3));
    const markerMaterial = new T.PointsMaterial({
      color: 0x64748b,
      size: 5,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
    });
    markerMaterial.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <clipping_planes_fragment>",
        "#include <clipping_planes_fragment>\nif (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;"
      );
    };
    const markers = new T.Points(markerGeometry, markerMaterial);
    markers.frustumCulled = false;
    markers.renderOrder = 10;
    markers.visible = false;
    scene.add(markers);
    const hover = document.createElement("div");
    hover.className = "part-hover";
    hover.setAttribute("role", "tooltip");
    hover.hidden = true;
    el.appendChild(hover);
    type Target = {
      index: number;
      x: number;
      y: number;
      left: number;
      right: number;
      top: number;
      bottom: number;
    };
    let targets: Target[] = [];
    const projected = new T.Vector3();
    const findTarget = (x: number, y: number, radius: number) => {
      let best = -1;
      let score = Infinity;
      for (const t of targets) {
        const dx = Math.max(t.left - x, 0, x - t.right);
        const dy = Math.max(t.top - y, 0, y - t.bottom);
        const distance = Math.hypot(dx, dy);
        if (distance > radius) continue;
        const candidate = distance + Math.hypot(t.x - x, t.y - y) * 0.025;
        if (candidate < score) {
          score = candidate;
          best = t.index;
        }
      }
      return best;
    };
    const isBreastTissue = (p: Part) =>
      p.system === "integumentary" && p.id.startsWith("VH_F_") && p.id !== "VH_F_skin";
    const isBodySurface = (p: Part) => p.system === "integumentary" && !isBreastTissue(p);
    // Lobulated adipose/connective detail, not a skeletal-muscle fiber map.
    // The illustration changes shading only; source tissue geometry stays intact.
    const createTissueMaps = () => {
      const tissueCanvas = document.createElement("canvas");
      tissueCanvas.width = tissueCanvas.height = 512;
      const tissueContext = tissueCanvas.getContext("2d")!;
      const tissuePixels = tissueContext.createImageData(512, 512);
      const heightCanvas = document.createElement("canvas");
      heightCanvas.width = heightCanvas.height = 512;
      const heightContext = heightCanvas.getContext("2d")!;
      const heightPixels = heightContext.createImageData(512, 512);
      const hash = (x: number, y: number) => {
        const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        return n - Math.floor(n);
      };
      for (let y = 0; y < 512; y++)
        for (let x = 0; x < 512; x++) {
          const u = x / 512;
          const v = y / 512;
          // Slightly elongated, irregular lobules separated by pale connective septa.
          const px = u * 12 + 0.45 * Math.sin(v * 18);
          const py = v * 10 + 0.3 * Math.sin(u * 21);
          const ix = Math.floor(px);
          const iy = Math.floor(py);
          let first = Infinity;
          let second = Infinity;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const cx = ix + dx;
              const cy = iy + dy;
              const dist = Math.hypot(
                px - cx - 0.15 - 0.7 * hash(cx, cy),
                py - cy - 0.15 - 0.7 * hash(cx + 39, cy + 11)
              );
              if (dist < first) {
                second = first;
                first = dist;
              } else if (dist < second) second = dist;
            }
          const separation = second - first;
          const septa = Math.exp((-separation * separation) / 0.009);
          const dome = Math.max(0, 1 - first * first);
          const grain = hash(x, y) - 0.5;
          const tone = 0.78 + 0.22 * dome - 0.06 * septa + grain * 0.012;
          const offset = (y * 512 + x) * 4;
          tissuePixels.data.set(
            [213 * tone + septa * 32, 174 * tone + septa * 44, 101 * tone + septa * 60, 255],
            offset
          );
          const h = Math.round(255 * (0.35 + 0.45 * dome - 0.14 * septa));
          heightPixels.data.set([h, h, h, 255], offset);
        }
      tissueContext.putImageData(tissuePixels, 0, 0);
      heightContext.putImageData(heightPixels, 0, 0);
      const tissueMap = new T.CanvasTexture(tissueCanvas);
      const tissueBump = new T.CanvasTexture(heightCanvas);
      tissueMap.colorSpace = T.SRGBColorSpace;
      tissueMap.anisotropy = tissueBump.anisotropy = Math.min(
        4,
        renderer.capabilities.getMaxAnisotropy()
      );
      return { map: tissueMap, bump: tissueBump };
    };
    const tissueMaps = atlas.parts.some((p) => /^VH_F_fat_[LR]$/.test(p.id))
      ? createTissueMaps()
      : null;
    const materialFor = (system: string, surface = system === "integumentary") => {
      const adipose = system === "adipose";
      const areola = system === "areola";
      const VERTEX_HEADER = `attribute float partIndex;
uniform sampler2D partState;
uniform sampler2D selectionState;
uniform float stateWidth;
varying float partVisible;
varying float partSelected;`;
      const VERTEX_STATE_INJECT = `#include <begin_vertex>
vec2 stateUv = vec2((partIndex + 0.5) / stateWidth, 0.5);
vec4 state = texture2D(partState, stateUv);
transformed += state.xyz;
partVisible = state.w;
partSelected = texture2D(selectionState, stateUv).r;`;
      const FRAGMENT_COLOR_INJECT = `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.85, 0.78), partSelected * 0.75);`;
      const m = new T.MeshStandardMaterial({
        color: adipose
          ? "#ffffff"
          : areola
            ? "#c4867a"
            : system === "mammary"
              ? "#c7a4b7"
              : (SYSTEMS.find((s) => s.id === system)?.color ?? "#aebbb8"),
        metalness: adipose || system === "mammary" ? 0 : 0.08,
        roughness: adipose || system === "mammary" ? 0.8 : 0.53,
        side: T.DoubleSide,
        transparent: surface,
        opacity: surface ? 0.1 : 1,
        depthWrite: !surface,
      });
      if (adipose && tissueMaps) {
        m.map = tissueMaps.map;
        m.bumpMap = tissueMaps.bump;
        m.bumpScale = 0.65;
      }
      m.customProgramCacheKey = () => "atlas-standard-v2";
      m.onBeforeCompile = (shader) => {
        shader.uniforms.partState = { value: partTexture };
        shader.uniforms.selectionState = { value: selectionTexture };
        shader.uniforms.stateWidth = { value: width };
        shader.vertexShader = `${VERTEX_HEADER}
${shader.vertexShader}`;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          VERTEX_STATE_INJECT
        );
        shader.fragmentShader = `varying float partVisible;
varying float partSelected;
${shader.fragmentShader}`;
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <clipping_planes_fragment>",
          "#include <clipping_planes_fragment>\nif (partVisible < 0.5) discard;"
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          FRAGMENT_COLOR_INJECT
        );
      };
      materials.push(m);
      return m;
    };
    const mats = new Map<string, T.Material>(SYSTEMS.map((s) => [s.id, materialFor(s.id)]));
    mats.set("breast", materialFor("integumentary", false));
    mats.set("adipose", materialFor("adipose", false));
    mats.set("areola", materialFor("areola", false));
    const loadedChunks = new Set<number>();
    const pendingChunks = new Map<number, Promise<void>>();
    let requiredChunks = new Set<number>();
    const report = () => {
      let done = 0;
      for (const ci of requiredChunks) if (loadedChunks.has(ci)) done++;
      onProgress(requiredChunks.size ? Math.round((done / requiredChunks.size) * 100) : 100);
    };
    const buildChunk = (ci: number, buffer: ArrayBuffer) => {
      const groups = new Map<string, T.BufferGeometry[]>();
      atlas.parts.forEach((p, i) => {
        if (p.chunk !== ci) return;
        const g = new T.BufferGeometry();
        g.setAttribute(
          "position",
          new T.BufferAttribute(new Float32Array(buffer, p.positions, p.vertexCount * 3), 3)
        );
        // GPU normalized signed-short normals keep the complete atlas compact in memory.
        g.setAttribute(
          "normal",
          new T.BufferAttribute(new Int16Array(buffer, p.normals, p.vertexCount * 3), 3, true)
        );
        g.setIndex(new T.BufferAttribute(new Uint32Array(buffer, p.indices, p.indexCount), 1));
        g.boundingBox = bounds[i].clone();
        g.computeBoundingSphere();
        const pick = new T.Mesh(g);
        pick.matrixAutoUpdate = false;
        pickers[i] = pick;
        geometries.push(g);
        g.setAttribute(
          "partIndex",
          new T.BufferAttribute(new Float32Array(p.vertexCount).fill(i), 1)
        );
        if (/^VH_F_fat_[LR]$/.test(p.id)) {
          const uv = new Float32Array(p.vertexCount * 2),
            position = g.getAttribute("position"),
            [lo, hi] = p.bounds;
          for (let v = 0; v < p.vertexCount; v++) {
            uv[v * 2] = (position.getX(v) - lo[0]) / (hi[0] - lo[0]);
            uv[v * 2 + 1] = (position.getY(v) - lo[1]) / (hi[1] - lo[1]);
          }
          g.setAttribute("uv", new T.BufferAttribute(uv, 2));
        }
        const category =
          p.system === "mammary" && /suspensory_ligaments/.test(p.id)
            ? "connective"
            : p.system === "mammary" && /^VH_F_fat_[LR]$/.test(p.id)
              ? "adipose"
              : p.system === "mammary" && /nipple|areola/.test(p.id)
                ? "areola"
                : isBreastTissue(p)
                  ? "breast"
                  : p.system;
        const list = groups.get(category) ?? [];
        list.push(g);
        groups.set(category, list);
      });
      groups.forEach((gs, system) => {
        const geometry = mergeGeometries(gs, false);
        if (!geometry) throw new Error("Could not assemble anatomy geometry.");
        geometries.push(geometry);
        const mesh = new T.Mesh(geometry, mats.get(system));
        mesh.frustumCulled = false;
        scene.add(mesh);
      });
    };
    const loadChunk = (ci: number) => {
      const existing = pendingChunks.get(ci);
      if (existing) return existing;
      const task = (async () => {
        const chunk = atlas.chunks[ci];
        const compressed = !!chunk.gzip && typeof DecompressionStream !== "undefined";
        const response = await fetch(compressed ? chunk.gzip! : chunk.url, {
          signal: abort.signal,
        });
        const buffer = await decodeModelResponse(response, chunk.bytes, compressed);
        if (disposed) return;
        buildChunk(ci, buffer);
        loadedChunks.add(ci);
        lastState = null;
        dirty = true;
        report();
      })();
      pendingChunks.set(ci, task);
      // A failed chunk must not stay cached as pending, or its system can never load.
      task.catch(() => pendingChunks.delete(ci));
      return task;
    };
    const chunksFor = (s: SceneState) => {
      const visible = new Set(s.visible);
      const selection = new Set(s.selected);
      const isolation = new Set(s.isolated);
      const need = new Set<number>();
      atlas.chunks.forEach((c, ci) => {
        if (!c.system || visible.has(c.system)) need.add(ci);
      });
      if (selection.size || isolation.size)
        atlas.parts.forEach((p) => {
          if (selection.has(p.id) || isolation.has(p.id)) need.add(p.chunk);
        });
      return need;
    };
    const ensureChunks = (s: SceneState) => {
      requiredChunks = chunksFor(s);
      report();
      const queue = [...requiredChunks].filter((ci) => !loadedChunks.has(ci));
      if (!queue.length) {
        ready = true;
        return;
      }
      ready = false;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (cursor < queue.length) {
          const ci = queue[cursor++];
          await loadChunk(ci);
        }
      });
      Promise.all(workers)
        .then(() => {
          if (!disposed && [...requiredChunks].every((ci) => loadedChunks.has(ci))) {
            ready = true;
            dirty = true;
          }
        })
        .catch((e) => {
          if (!disposed) onError(e instanceof Error ? e.message : "Could not load the anatomy.");
        });
    };
    ensureChunks(latest.current);
    const body = bodyBounds(atlas.parts);
    const regions = atlas.parts.map((p) => partRegion(p, body));
    const visibleBox = () => {
      const s = latest.current,
        visible = new Set(s.visible),
        selection = new Set(s.selected),
        box = new T.Box3();
      let count = 0;
      atlas.parts.forEach((p, i) => {
        if (s.isolate ? selection.has(p.id) : visible.has(p.system) || selection.has(p.id)) {
          box.union(bounds[i]);
          count++;
        }
      });
      return count && !box.isEmpty() ? box : null;
    };
    const fit = (view: string, extent = 0) => {
      const region = latest.current.region;
      const area = latest.current.area;
      const visibleSystems = new Set(latest.current.visible);
      if ((area || region) && extent < 0.1) {
        const dir =
          view === "front"
            ? new T.Vector3(0, 0.02, 1)
            : view === "back"
              ? new T.Vector3(0, 0.02, -1)
              : view === "side"
                ? new T.Vector3(1, 0.02, 0)
                : new T.Vector3(0.35, 0.06, 1).normalize();
        const box = new T.Box3();
        atlas.parts.forEach((p, i) => {
          if (!visibleSystems.has(p.system)) return;
          if (area ? partInArea(p, area, body) : regions[i] === region) box.union(bounds[i]);
        });
        if (!box.isEmpty()) {
          const center = box.getCenter(new T.Vector3());
          const size = box.getSize(new T.Vector3());
          const mobile = el.clientWidth < 768;
          const reservedHeight = mobile ? 350 : 270;
          const availableHeight = Math.max(160, el.clientHeight - reservedHeight);
          const availableWidth = Math.max(160, el.clientWidth - (mobile ? 40 : 340));
          const distance = Math.max(
            0.2,
            (Math.max(
              (size.y * el.clientHeight) / availableHeight,
              (size.x * el.clientWidth) / availableWidth / camera.aspect,
              size.z
            ) /
              (2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)))) *
              1.45
          );
          controls.target.copy(center);
          camera.position.copy(center).addScaledVector(dir, distance);
          controls.update();
          dirty = true;
          return;
        }
      }
      const mobile = el.clientWidth < 768;
      const portrait = mobile && el.clientHeight >= el.clientWidth;
      const normalDistance = mobile
        ? Math.max(
            4.5,
            (1.8 * el.clientHeight) /
              Math.max(160, el.clientHeight - (portrait ? 440 : 350)) /
              (2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)))
          )
        : 4;
      const reservedHeight = portrait ? 440 : mobile ? 350 : 270;
      const availableAspect = Math.max(
        0.35,
        (el.clientWidth - (mobile ? 40 : 340)) / Math.max(160, el.clientHeight - reservedHeight)
      );
      const atlasDistance =
        (Math.max(packingHeight, packingWidth / availableAspect) /
          (2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)))) *
        (el.clientHeight / Math.max(160, el.clientHeight - reservedHeight)) *
        1.08;
      if (portrait && !latest.current.isolate)
        camera.setViewOffset(
          el.clientWidth,
          el.clientHeight,
          0,
          -40,
          el.clientWidth,
          el.clientHeight
        );
      else if (!latest.current.isolate) camera.clearViewOffset();
      const distance = T.MathUtils.lerp(normalDistance, Math.max(0.2, atlasDistance), extent);
      if (extent > 0.8) view = "front";
      const direction =
        view === "front"
          ? new T.Vector3(0, 0.02, 1)
          : view === "back"
            ? new T.Vector3(0, 0.02, -1)
            : view === "side"
              ? new T.Vector3(1, 0.02, 0)
              : new T.Vector3(0.35, 0.06, 1).normalize();
      const subset = extent <= 0.1 && !latest.current.isolate ? visibleBox() : null;
      if (subset) {
        const size = subset.getSize(new T.Vector3());
        const center = subset.getCenter(new T.Vector3());
        const heightScale = el.clientHeight / Math.max(160, el.clientHeight - reservedHeight);
        const widthScale = el.clientWidth / Math.max(150, el.clientWidth - (mobile ? 40 : 340));
        const framed =
          (Math.max(size.y * heightScale, (size.x * widthScale) / camera.aspect, size.z) /
            (2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)))) *
          1.1;
        if (!mobile) {
          const halfFov = T.MathUtils.degToRad(camera.fov / 2);
          const worldHeightAtFramed = 2 * Math.max(0.12, framed) * Math.tan(halfFov);
          const yShift = (70 / (2 * el.clientHeight)) * worldHeightAtFramed;
          center.y -= yShift;
        }
        controls.target.copy(center);
        camera.position.copy(center).addScaledVector(direction, Math.max(0.12, framed));
        controls.update();
        dirty = true;
        return;
      }
      controls.target.set(0, extent > 0.1 || mobile ? 0.85 : 0.68, 0);
      camera.position.copy(controls.target).addScaledVector(direction, distance);
      controls.update();
      dirty = true;
    };
    const resize = () => {
      layoutKey = "";
      lastState = null;
      renderer.setPixelRatio(
        Math.min(devicePixelRatio, el.clientWidth < 768 || el.clientHeight < 600 ? 1.5 : 2)
      );
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
      fit(latest.current.view, amount);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    const raycaster = new T.Raycaster();
    const pointer = new T.Vector2();
    const tap = new PointerTap();
    const worldBox = new T.Box3();
    const hitPoint = new T.Vector3();
    const down = (e: PointerEvent) => {
      hover.hidden = true;
      tap.down(e.pointerId, e.clientX, e.clientY, e.pointerType === "touch" ? 12 : 5);
    };
    const move = (e: PointerEvent) => {
      tap.move(e.pointerId, e.clientX, e.clientY);
      if (e.buttons || amount < 0.5 || e.pointerType === "touch") {
        hover.hidden = true;
        return;
      }
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const index = findTarget(x, y, 12);
      hover.hidden = index < 0;
      renderer.domElement.style.cursor = index < 0 ? "grab" : "pointer";
      if (index >= 0) {
        hover.textContent = atlas.parts[index].name;
        hover.style.left = `${Math.max(8, Math.min(x + 14, el.clientWidth - 260))}px`;
        hover.style.top = `${Math.max(8, Math.min(y + 18, el.clientHeight - 55))}px`;
      }
    };
    const cancel = (e: PointerEvent) => tap.cancel(e.pointerId);
    const up = (e: PointerEvent) => {
      const validTap = tap.up(e.pointerId, e.clientX, e.clientY);
      if (!validTap || !ready) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(pointer, camera);
      let nearest = Infinity;
      let found = -1;
      const hasSolid = atlas.parts.some((p, i) => !isBodySurface(p) && data[i * 4 + 3] > 0.5);
      pickers.forEach((mesh, i) => {
        if (!mesh || data[i * 4 + 3] < 0.5 || (hasSolid && isBodySurface(atlas.parts[i]))) return;
        worldBox.copy(bounds[i]).translate(mesh.position);
        if (!raycaster.ray.intersectBox(worldBox, hitPoint)) return;
        const hits = raycaster.intersectObject(mesh, false);
        if (hits[0] && hits[0].distance < nearest) {
          nearest = hits[0].distance;
          found = i;
        }
      });
      if (found < 0 && amount > 0.45)
        found = findTarget(
          e.clientX - rect.left,
          e.clientY - rect.top,
          e.pointerType === "touch" ? 24 : 16
        );
      if (found >= 0) {
        hover.hidden = true;
        select.current(atlas.parts[found].id);
      }
    };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerup", up);
    renderer.domElement.addEventListener("pointercancel", cancel);
    const clock = new T.Clock();
    let lastExtent = -1;
    const animate = () => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (heldKeys.size > 0) {
        const speed = Math.PI / 2;
        const offset = camera.position.clone().sub(controls.target);
        const spherical = new T.Spherical().setFromVector3(offset);
        if (heldKeys.has("ArrowLeft")) spherical.theta -= speed * dt;
        if (heldKeys.has("ArrowRight")) spherical.theta += speed * dt;
        if (heldKeys.has("ArrowUp")) spherical.phi -= speed * dt;
        if (heldKeys.has("ArrowDown")) spherical.phi += speed * dt;
        spherical.phi = Math.max(0.01, Math.min(controls.maxPolarAngle, spherical.phi));
        spherical.makeSafe();
        offset.setFromSpherical(spherical);
        camera.position.copy(controls.target).add(offset);
        controls.update();
        dirty = true;
      }
      const s = latest.current;
      const changed =
        lastState?.visible !== s.visible ||
        lastState?.selected !== s.selected ||
        lastState?.isolate !== s.isolate ||
        lastState?.isolated !== s.isolated ||
        lastState?.breastView !== s.breastView ||
        lastState?.region !== s.region ||
        lastState?.area !== s.area;
      if (changed) ensureChunks(s);
      if (lastState?.isolate !== s.isolate) {
        amount = s.explode;
        dirty = true;
      }
      const moving = Math.abs(amount - s.explode) > 0.0001;
      if (moving) {
        amount = T.MathUtils.damp(amount, s.explode, 8, dt);
        dirty = true;
      }
      if (changed || moving || lastExtent < 0) {
        const visible = new Set(s.visible);
        const selection = new Set(s.selected);
        const isolation = new Set(s.isolated);
        const visibilityLookups = { visible, selected: selection, isolated: isolation };
        const suppressHighlight =
          s.isolate &&
          s.isolated.length === s.selected.length &&
          s.selected.every((id) => isolation.has(id));
        const shown = (p: Part, i: number) => {
          if (!partIsVisible(p, s, visibilityLookups)) return false;
          if (s.isolate) return true;
          if (visibilityLookups.selected.has(p.id)) return true;
          if (s.area) return partInArea(p, s.area, body);
          if (s.region && regions[i] !== s.region) return false;
          return true;
        };
        const visibleParts = atlas.parts.filter((p, i) => shown(p, i));
        const nextLayoutKey =
          visibleParts.map((p) => p.id).join(",") + ":" + camera.aspect.toFixed(3);
        if (nextLayoutKey !== layoutKey) {
          const layout = createExplosionLayout(visibleParts, camera.aspect);
          packingWidth = layout.width;
          packingHeight = layout.height;
          atlas.parts.forEach((p, i) => {
            const cell = layout.cells.get(p.id);
            offsets[i] = cell ? new T.Vector3(cell.x, cell.y + 0.85, 0) : centers[i].clone();
          });
          layoutKey = nextLayoutKey;
          if (!s.isolate) fit(s.view, Math.max(0, (amount - 0.3) / 0.7));
        }

        atlas.parts.forEach((p, i) => {
          const c = centers[i];
          const destination = offsets[i];
          let dx = 0;
          let dy = 0;
          let dz = 0;
          if (amount <= 0.45) {
            const t = amount / 0.45;
            const group = SYSTEMS.findIndex((sys) => sys.id === p.system);
            const angle = (group / SYSTEMS.length) * Math.PI * 2;
            dx = Math.sin(angle) * t * 0.48;
            dy = (c.y - 0.85) * t * 0.28;
            dz = Math.cos(angle) * t * 0.48;
          } else {
            const t = (amount - 0.45) / 0.55;
            const group = SYSTEMS.findIndex((sys) => sys.id === p.system);
            const angle = (group / SYSTEMS.length) * Math.PI * 2;
            dx = T.MathUtils.lerp(Math.sin(angle) * 0.48, destination.x - c.x, t);
            dy = T.MathUtils.lerp((c.y - 0.85) * 0.28, destination.y - c.y, t);
            dz = T.MathUtils.lerp(Math.cos(angle) * 0.48, -c.z, t);
          }
          const selected = !suppressHighlight && selection.has(p.id);
          data.set([dx, dy, dz, shown(p, i) ? 1 : 0], i * 4);
          selectedData[i * 4] = selected ? 255 : 0;
          markerPositions.set(
            data[i * 4 + 3] > 0.5 ? [c.x + dx, c.y + dy, c.z + dz] : [10000, 10000, 10000],
            i * 3
          );
          const mesh = pickers[i];
          if (mesh) {
            mesh.position.set(dx, dy, dz);
            mesh.updateMatrix();
            mesh.updateMatrixWorld(true);
          }
        });
        partTexture.needsUpdate = true;
        selectionTexture.needsUpdate = true;
        markerGeometry.attributes.position.needsUpdate = true;
        lastState = s;
        lastExtent = amount;
        dirty = true;
      }
      if (
        s.view !== lastView ||
        s.reset !== lastReset ||
        s.region !== lastRegion ||
        s.area !== lastArea
      ) {
        fit(s.view, amount);
        lastView = s.view;
        lastReset = s.reset;
        lastRegion = s.region;
        lastArea = s.area;
      }
      if (wasMoving && !moving && !s.isolate && amount > 0.45)
        fit(amount > 0.5 ? "front" : s.view, Math.max(0, (amount - 0.3) / 0.7));
      wasMoving = moving;
      const isolateKey = s.isolate
        ? (s.isolated.length ? s.isolated : s.selected).join(",") +
          ":" +
          s.reset +
          ":" +
          s.inspectorOpen +
          ":" +
          camera.aspect
        : "";
      if (isolateKey !== lastIsolate || (s.isolate && moving)) {
        if (s.isolate) {
          if (!lastIsolate) {
            preCameraPosition = camera.position.clone();
            preCameraTarget = controls.target.clone();
            preCameraMaxDistance = controls.maxDistance;
          }
          const boundary = s.isolated.length ? s.isolated : s.selected;
          const box = new T.Box3();
          atlas.parts.forEach((p, i) => {
            if (boundary.includes(p.id))
              box.union(
                bounds[i]
                  .clone()
                  .translate(new T.Vector3(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]))
              );
          });
          if (!box.isEmpty()) {
            const center = box.getCenter(new T.Vector3());
            const size = box.getSize(new T.Vector3());
            const w = el.clientWidth;
            const h = el.clientHeight;
            const mobile = w < 768;
            const landscape = w > h && h <= 600;
            let left = 20;
            let right = w - 20;
            let top = mobile ? 250 : 110;
            let bottom = h - 170;
            if (s.inspectorOpen) {
              if (landscape) {
                right = w - 335;
                top = 100;
                bottom = h - 125;
              } else if (mobile) {
                const sheet = document.querySelector(".detail-sheet")?.getBoundingClientRect();
                const header = document.querySelector(".identity")?.getBoundingClientRect();
                top = (header?.bottom ?? 94) + 16;
                bottom = (sheet?.top ?? h * 0.58 - 139) - 16;
              } else {
                right = w - 370;
                left = w > 1100 ? 285 : 25;
              }
            }
            const availableWidth = Math.max(150, right - left);
            const availableHeight = Math.max(40, bottom - top);
            camera.setViewOffset(
              w,
              h,
              w / 2 - (left + right) / 2,
              h / 2 - (top + bottom) / 2,
              w,
              h
            );
            const distance = Math.max(
              0.07,
              (Math.max(
                (size.y * h) / availableHeight,
                (size.x * w) / availableWidth / camera.aspect,
                size.z
              ) /
                (2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)))) *
                1.35
            );
            controls.maxDistance = Math.max(40, distance * 2);
            const dir = camera.position.clone().sub(controls.target).normalize();
            controls.target.copy(center);
            camera.position.copy(center).addScaledVector(dir, distance);
            controls.update();
            dirty = true;
          }
        } else if (lastIsolate) {
          camera.clearViewOffset();
          if (preCameraPosition && preCameraTarget) {
            controls.target.copy(preCameraTarget);
            camera.position.copy(preCameraPosition);
            controls.maxDistance = preCameraMaxDistance;
            controls.update();
            dirty = true;
            preCameraPosition = null;
            preCameraTarget = null;
          } else {
            fit(s.view, amount);
          }
        }
        lastIsolate = isolateKey;
      }
      controls.enableRotate = amount < 0.8;
      controls.mouseButtons.LEFT = amount < 0.8 ? T.MOUSE.ROTATE : T.MOUSE.PAN;
      controls.touches.ONE = amount < 0.8 ? T.TOUCH.ROTATE : T.TOUCH.PAN;

      markers.visible = amount > 0.75;
      controls.autoRotate = s.rotate && !s.isolate && amount < 0.4;
      controls.autoRotateSpeed = 0.65;
      controls.update();
      if (controls.autoRotate) dirty = true;
      if (dirty) {
        renderer.render(scene, camera);
        targets = [];
        if (amount > 0.45) {
          const hasSolid = atlas.parts.some((p, i) => !isBodySurface(p) && data[i * 4 + 3] > 0.5);
          atlas.parts.forEach((p, i) => {
            if (data[i * 4 + 3] < 0.5 || (hasSolid && isBodySurface(p))) return;
            let left = Infinity;
            let right = -Infinity;
            let top = Infinity;
            let bottom = -Infinity;
            for (let corner = 0; corner < 8; corner++) {
              projected
                .set(
                  p.bounds[corner & 1 ? 1 : 0][0] + data[i * 4],
                  p.bounds[corner & 2 ? 1 : 0][1] + data[i * 4 + 1],
                  p.bounds[corner & 4 ? 1 : 0][2] + data[i * 4 + 2]
                )
                .project(camera);
              const x = ((projected.x + 1) * el.clientWidth) / 2;
              const y = ((1 - projected.y) * el.clientHeight) / 2;
              left = Math.min(left, x);
              right = Math.max(right, x);
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
            }
            projected
              .copy(centers[i])
              .add(new T.Vector3(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]))
              .project(camera);
            if (projected.z < -1 || projected.z > 1) return;
            targets.push({
              index: i,
              x: ((projected.x + 1) * el.clientWidth) / 2,
              y: ((1 - projected.y) * el.clientHeight) / 2,
              left,
              right,
              top,
              bottom,
            });
          });
        }
        dirty = false;
      }
    };
    animate();
    const contextLost = (e: Event) => {
      e.preventDefault();
      onError("The 3D session was paused by your device. Reload to continue.");
    };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    return () => {
      disposed = true;
      abort.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      geometries.forEach((g) => g.dispose());
      tissueMaps?.map.dispose();
      tissueMaps?.bump.dispose();
      materials.forEach((m) => m.dispose());
      scene.traverse((o) => {
        if (o instanceof T.Mesh && !geometries.includes(o.geometry)) {
          o.geometry.dispose();
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          ms.forEach((m) => m.dispose());
        }
      });
      env.dispose();
      partTexture.dispose();
      selectionTexture.dispose();
      markerGeometry.dispose();
      markerMaterial.dispose();
      hover.remove();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [atlas]);
  return <div className="scene" ref={host} />;
}
