import { AlertTriangle, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { FailureConsequenceResult, FailureCutawayTerrain, ImpactedFeature } from "./failureConsequence";

type Props = {
  result: FailureConsequenceResult | null;
  basemapTextureUrl: string | null;
  flashedFeatureId: string | null;
  flashToken: number;
};

type ProjectedPoint = { x: number; z: number };
type AssetCenterline = {
  curve: THREE.CatmullRomCurve3;
  points: THREE.Vector3[];
  projected: ProjectedPoint[];
};
type AssetAnchor = {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
};
type PipeSizing = {
  diameterFeet: number;
  radiusFeet: number;
  schematic: boolean;
};
type SurfaceMode = "landscape" | "technical" | "xray";
type SceneTooltip = { x: number; y: number; title: string; detail: string };

const FEET_PER_DEGREE_LATITUDE = 364_000;
const CUTAWAY_CUBE_COLOR = 0x8a7968;
const CUTAWAY_EDGE_COLOR = 0x4f453c;
const FEATURE_FLASH_DURATION_MS = 2_600;
// A pipe with no recorded diameter is drawn at 15 inch, the network's most common size.
const SCHEMATIC_PIPE_DIAMETER_FEET = 1.25;
const ONE_LEVEL_BUILDING_HEIGHT_FEET = 12;
const ONE_LEVEL_ACCESSORY_HEIGHT_FEET = 10;
const CONSEQUENCE_SURFACE_OFFSET_FEET = 0.9;
const IMPACT_COLORS: Record<string, number> = {
  building: 0xe75f28,
  accessory_structure: 0xf08c38,
  roadway: 0x737d87,
  city_row: 0xa7b0b8,
  driveway: 0xb78b63,
  paved_surface: 0x8a949d,
  impervious_surface: 0x9c7bb3,
  stormwater_easement: 0x8a5fb0,
};

export default function FailureConsequenceScene3D({ result, basemapTextureUrl, flashedFeatureId, flashToken }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const impactObjectsRef = useRef<Map<string, THREE.Mesh[]>>(new Map());
  const flashRequestRef = useRef({ featureId: flashedFeatureId, token: flashToken, startedAt: 0 });
  const [verticalExaggeration, setVerticalExaggeration] = useState(1.5);
  const [surfaceOpacity, setSurfaceOpacity] = useState(0.82);
  const [cubeOpacity, setCubeOpacity] = useState(0.22);
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>("landscape");
  const [resetToken, setResetToken] = useState(0);
  const [tooltip, setTooltip] = useState<SceneTooltip | null>(null);
  const cutaway = result?.cutaway ?? null;
  const active = useMemo(
    () => result?.defects.find((defect) => defect.id === result.active_defect_id) ?? null,
    [result],
  );
  const pipeSizing = result?.asset.asset_type === "pipe" ? resolvePipeSizing(result.asset) : null;

  useEffect(() => {
    const previousFeatureId = flashRequestRef.current.featureId;
    if (previousFeatureId) setImpactedFeatureFlash(impactObjectsRef.current.get(previousFeatureId) ?? [], null);
    flashRequestRef.current = { featureId: flashedFeatureId, token: flashToken, startedAt: performance.now() };
  }, [flashedFeatureId, flashToken]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !cutaway || !result?.analysis) return;

    const horizontalSpan = Math.max(cutaway.width_feet, cutaway.height_feet);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeaf1f5);
    scene.fog = new THREE.Fog(0xeaf1f5, horizontalSpan * 1.5, horizontalSpan * 4.4);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.5, horizontalSpan * 12);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.replaceChildren(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.screenSpacePanning = true;
    controls.minPolarAngle = 0.15;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = horizontalSpan * 0.28;
    controls.maxDistance = horizontalSpan * 4.2;

    const terrain = createTerrainContext(cutaway, verticalExaggeration);
    const blockDepth = calculateSubsurfaceBlockDepth(result, cutaway, verticalExaggeration);
    addSoilBlock(scene, cutaway, terrain, blockDepth, cubeOpacity);
    addTerrainSurface(scene, result, cutaway, terrain, surfaceOpacity, basemapTextureUrl, surfaceMode);
    if (surfaceMode === "landscape") addSurfaceVegetation(scene, result, cutaway, terrain);
    addSelectedAsset(scene, result, cutaway, terrain);
    addDefectsAndZoi(scene, result, cutaway, terrain);
    const impactObjects = new Map<string, THREE.Mesh[]>();
    const influenceColor = active?.source === "simulated" ? 0xb444d2 : 0xef6c28;
    if (result.analysis.influence_footprint_geometry) {
      addInfluenceFootprint(scene, result.analysis.influence_footprint_geometry, terrain, influenceColor);
    }
    const prioritizedFeatures = result.analysis.impacted_features.toSorted(
      (left, right) => Number(right.is_influenced) - Number(left.is_influenced),
    );
    for (const feature of prioritizedFeatures.slice(0, 350)) {
      addImpactedFeature(scene, feature, terrain, impactObjects, influenceColor);
    }
    impactObjectsRef.current = impactObjects;
    flashRequestRef.current = { ...flashRequestRef.current, startedAt: performance.now() };

    const ambient = new THREE.HemisphereLight(0xf5fbff, 0x6f5138, 2.3);
    scene.add(ambient);
    const sunlight = new THREE.DirectionalLight(0xfff4da, 3.2);
    sunlight.position.set(horizontalSpan * 0.65, horizontalSpan * 1.1, horizontalSpan * 0.45);
    sunlight.castShadow = true;
    const shadowExtent = horizontalSpan * 0.72;
    sunlight.shadow.camera.left = -shadowExtent;
    sunlight.shadow.camera.right = shadowExtent;
    sunlight.shadow.camera.top = shadowExtent;
    sunlight.shadow.camera.bottom = -shadowExtent;
    sunlight.shadow.mapSize.set(1536, 1536);
    scene.add(sunlight);

    const baseY = -blockDepth;
    const contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(cutaway.width_feet * 1.16, cutaway.height_feet * 1.16),
      new THREE.ShadowMaterial({ color: 0x193042, opacity: 0.24 }),
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.y = baseY - 3;
    contactShadow.receiveShadow = true;
    scene.add(contactShadow);

    const targetY = Math.max(8, (terrain.maximumY - blockDepth) * 0.34);
    controls.target.set(0, targetY, 0);
    camera.position.set(horizontalSpan * 0.84, horizontalSpan * 0.66, horizontalSpan * 0.9);
    camera.lookAt(controls.target);
    controls.update();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const handlePointerMove = (event: PointerEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(scene.children, true).find((item) => item.object.userData.tooltipTitle);
      if (!hit) {
        setTooltip(null);
        renderer.domElement.style.cursor = "grab";
        return;
      }
      renderer.domElement.style.cursor = "pointer";
      setTooltip({
        x: event.clientX - bounds.left + 12,
        y: event.clientY - bounds.top + 12,
        title: String(hit.object.userData.tooltipTitle),
        detail: String(hit.object.userData.tooltipDetail ?? ""),
      });
    };
    const handlePointerLeave = () => {
      setTooltip(null);
      renderer.domElement.style.cursor = "grab";
    };
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    let animationFrame = 0;
    const render = () => {
      const flashRequest = flashRequestRef.current;
      if (flashRequest.featureId) {
        const elapsed = performance.now() - flashRequest.startedAt;
        if (elapsed < FEATURE_FLASH_DURATION_MS) {
          const pulse = (Math.sin((elapsed / 340) * Math.PI * 2) + 1) / 2;
          setImpactedFeatureFlash(impactObjects.get(flashRequest.featureId) ?? [], pulse);
        } else {
          setImpactedFeatureFlash(impactObjects.get(flashRequest.featureId) ?? [], null);
          flashRequestRef.current = { ...flashRequest, featureId: null };
        }
      }
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(render);
    };
    render();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      controls.dispose();
      impactObjectsRef.current = new Map();
      disposeScene(scene);
      renderer.dispose();
      renderer.domElement.remove();
      setTooltip(null);
    };
  }, [active, basemapTextureUrl, cubeOpacity, cutaway, resetToken, result, surfaceMode, surfaceOpacity, verticalExaggeration]);

  if (!cutaway || !result?.analysis) {
    return (
      <div className="failure-cutaway-unavailable">
        <AlertTriangle size={24} />
        <strong>3D cutaway unavailable</strong>
        <span>The DEM cutaway could not be generated for this asset-wide screening extent.</span>
      </div>
    );
  }

  return (
    <div className="failure-cutaway-scene">
      <div ref={hostRef} className="failure-cutaway-canvas" />
      <div className="failure-cutaway-toolbar">
        <div className="failure-cutaway-control failure-cutaway-mode-control">
          <span>Display</span>
          <div role="group" aria-label="Surface display mode">
            {([
              ["landscape", "Landscape"],
              ["technical", "Technical"],
              ["xray", "X-ray"],
            ] as const).map(([value, label]) => (
              <button type="button" key={value} className={surfaceMode === value ? "active" : ""} onClick={() => setSurfaceMode(value)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="failure-cutaway-control">
          <span>Vertical</span>
          <div role="group" aria-label="Vertical exaggeration">
            {[1, 1.5, 2].map((value) => (
              <button type="button" key={value} className={verticalExaggeration === value ? "active" : ""} onClick={() => setVerticalExaggeration(value)}>{value}×</button>
            ))}
          </div>
        </div>
        <label className="failure-cutaway-opacity">
          <span>Terrain</span>
          <input
            type="range"
            min={surfaceMode === "xray" ? "0.08" : "0.35"}
            max="1"
            step="0.05"
            value={surfaceMode === "xray" ? Math.min(surfaceOpacity, 0.22) : surfaceOpacity}
            disabled={surfaceMode === "xray"}
            title={surfaceMode === "xray" ? "X-ray mode fixes terrain at a low opacity." : "Adjust terrain opacity."}
            onChange={(event) => setSurfaceOpacity(Number(event.target.value))}
          />
          <strong>{Math.round((surfaceMode === "xray" ? Math.min(surfaceOpacity, 0.22) : surfaceOpacity) * 100)}%</strong>
        </label>
        <label className="failure-cutaway-opacity">
          <span>Cube</span>
          <input type="range" min="0.08" max="0.4" step="0.02" value={cubeOpacity} onChange={(event) => setCubeOpacity(Number(event.target.value))} />
          <strong>{Math.round(cubeOpacity * 100)}%</strong>
        </label>
        <button type="button" className="failure-cutaway-reset" onClick={() => setResetToken((value) => value + 1)}><RotateCcw size={15} />Reset</button>
      </div>
      <div className="failure-cutaway-data-note">
        {surfaceMode === "landscape"
          ? "Basemap-draped DEM · illustrative vegetation · transparent inspection corridor"
          : surfaceMode === "technical"
            ? "DEM engineering view · transparent inspection corridor"
            : "X-ray terrain · schematic transparent subsurface"}
        {pipeSizing
          ? pipeSizing.schematic
            ? ` · diameter unavailable; ${formatPipeDiameter(pipeSizing.diameterFeet)} ft schematic pipe`
            : ` · ${formatPipeDiameter(pipeSizing.diameterFeet)} ft pipe diameter at true scale${verticalExaggeration === 1 ? "" : `; terrain ${verticalExaggeration}×`}`
          : null}
      </div>
      <div className="failure-cutaway-legend" aria-label="3D cutaway legend">
        <span><i className="terrain" />DEM surface</span>
        {surfaceMode === "landscape" ? <span><i className="vegetation" />Illustrative vegetation</span> : null}
        <span><i className="cube" />Subsurface cutaway</span>
        <span><i className="asset" />Selected asset</span>
        <span><i className="zoi" />Zone of influence</span>
        <span><i className="impact" />Affected feature</span>
        {active ? <span><i className={`defect ${active.source}`} />{active.source === "simulated" ? "Simulated defect" : active.source === "inventory" ? "Structure invert" : "Observed defect"}</span> : null}
      </div>
      {tooltip ? <div className="failure-cutaway-tooltip" style={{ left: tooltip.x, top: tooltip.y }}><strong>{tooltip.title}</strong><span>{tooltip.detail}</span></div> : null}
    </div>
  );
}

type TerrainContext = {
  minimum: number;
  maximumY: number;
  verticalScale: number;
  elevationToY: (elevation: number) => number;
  groundY: (x: number, z: number) => number;
  project: (coordinate: number[]) => ProjectedPoint;
};

function calculateSubsurfaceBlockDepth(
  result: FailureConsequenceResult,
  cutaway: FailureCutawayTerrain,
  verticalExaggeration: number,
): number {
  const featureElevations = [
    recordNumber(result.asset, "US_INVERT", "UPSTREAM_INVERT", "USINVERT"),
    recordNumber(result.asset, "DS_INVERT", "DOWNSTREAM_INVERT", "DSINVERT"),
    recordNumber(result.asset, "INVERT", "INV_ELEV", "INVERT_ELEV"),
    ...result.defects.flatMap((defect) => [
      recordNumber(defect.metadata, "interpolated_invert_elevation", "invert_elevation"),
    ]),
  ].filter((value): value is number => (
    value != null
    && Number.isFinite(value)
    && value > 0
    && value <= cutaway.maximum_elevation + 100
  ));
  const lowestFeatureElevation = featureElevations.length ? Math.min(...featureElevations) : null;
  const depthBelowLowestDem = lowestFeatureElevation == null
    ? 0
    : Math.max(0, cutaway.minimum_elevation - lowestFeatureElevation);
  const deepestKnownCover = Math.max(
    0,
    ...result.defects
      .filter((defect) => defect.located)
      .map((defect) => defect.relative_depth ?? 0)
      .filter((depth) => Number.isFinite(depth) && depth > 0 && depth <= cutaway.maximum_elevation),
  );
  const requiredDepthFeet = Math.max(depthBelowLowestDem, deepestKnownCover);
  return requiredDepthFeet > 0
    ? requiredDepthFeet * 1.5 * verticalExaggeration
    : 8 * verticalExaggeration;
}

function createTerrainContext(cutaway: FailureCutawayTerrain, exaggeration: number): TerrainContext {
  const latitudeRadians = cutaway.center[1] * Math.PI / 180;
  const feetPerDegreeLongitude = FEET_PER_DEGREE_LATITUDE * Math.cos(latitudeRadians);
  const project = (coordinate: number[]): ProjectedPoint => ({
    x: (Number(coordinate[0]) - cutaway.center[0]) * feetPerDegreeLongitude,
    z: -(Number(coordinate[1]) - cutaway.center[1]) * FEET_PER_DEGREE_LATITUDE,
  });
  const elevationToY = (elevation: number) => (elevation - cutaway.minimum_elevation) * exaggeration;
  const groundY = (x: number, z: number) => {
    const column = clamp((x / cutaway.width_feet + 0.5) * (cutaway.columns - 1), 0, cutaway.columns - 1);
    const row = clamp((z / cutaway.height_feet + 0.5) * (cutaway.rows - 1), 0, cutaway.rows - 1);
    const column0 = Math.floor(column);
    const column1 = Math.min(cutaway.columns - 1, column0 + 1);
    const row0 = Math.floor(row);
    const row1 = Math.min(cutaway.rows - 1, row0 + 1);
    const xFraction = column - column0;
    const yFraction = row - row0;
    const at = (gridRow: number, gridColumn: number) => cutaway.elevations[(gridRow * cutaway.columns) + gridColumn] ?? cutaway.minimum_elevation;
    const north = at(row0, column0) * (1 - xFraction) + at(row0, column1) * xFraction;
    const south = at(row1, column0) * (1 - xFraction) + at(row1, column1) * xFraction;
    return elevationToY(north * (1 - yFraction) + south * yFraction);
  };
  return {
    minimum: cutaway.minimum_elevation,
    maximumY: elevationToY(cutaway.maximum_elevation),
    verticalScale: exaggeration,
    elevationToY,
    groundY,
    project,
  };
}

function addTerrainSurface(
  scene: THREE.Scene,
  result: FailureConsequenceResult,
  cutaway: FailureCutawayTerrain,
  terrain: TerrainContext,
  opacity: number,
  basemapTextureUrl: string | null,
  surfaceMode: SurfaceMode,
) {
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const outerIndices: number[] = [];
  const corridorIndices: number[] = [];
  const projectedLines = geometryLineStrings(cutaway.asset_geometry).map((line) => line.map(terrain.project));
  const projectedPoints = geometryPoints(cutaway.asset_geometry).map(terrain.project);
  const corridorFeet = result.asset.asset_type === "structure" ? 18 : 24;
  const halfCellDiagonal = Math.hypot(
    cutaway.width_feet / Math.max(1, cutaway.columns - 1),
    cutaway.height_feet / Math.max(1, cutaway.rows - 1),
  ) / 2;
  const low = new THREE.Color(basemapTextureUrl ? 0xc1d1b6 : surfaceMode === "xray" ? 0xb8ced2 : 0x4f7f3c);
  const high = new THREE.Color(basemapTextureUrl ? 0xe4dcc5 : surfaceMode === "xray" ? 0xdce7e7 : 0xa4bd69);
  const relief = Math.max(1, cutaway.maximum_elevation - cutaway.minimum_elevation);
  for (let row = 0; row < cutaway.rows; row += 1) {
    for (let column = 0; column < cutaway.columns; column += 1) {
      const index = (row * cutaway.columns) + column;
      const elevation = cutaway.elevations[index] ?? cutaway.minimum_elevation;
      const x = -cutaway.width_feet / 2 + (cutaway.width_feet * column / (cutaway.columns - 1));
      const z = -cutaway.height_feet / 2 + (cutaway.height_feet * row / (cutaway.rows - 1));
      positions.push(x, terrain.elevationToY(elevation) + 0.25, z);
      const color = low.clone().lerp(high, clamp((elevation - cutaway.minimum_elevation) / relief, 0, 1));
      colors.push(color.r, color.g, color.b);
      uvs.push(column / (cutaway.columns - 1), 1 - (row / (cutaway.rows - 1)));
    }
  }
  for (let row = 0; row < cutaway.rows - 1; row += 1) {
    for (let column = 0; column < cutaway.columns - 1; column += 1) {
      const topLeft = row * cutaway.columns + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + cutaway.columns;
      const bottomRight = bottomLeft + 1;
      const x = -cutaway.width_feet / 2 + (cutaway.width_feet * (column + 0.5) / (cutaway.columns - 1));
      const z = -cutaway.height_feet / 2 + (cutaway.height_feet * (row + 0.5) / (cutaway.rows - 1));
      const target = distanceToProjectedAsset({ x, z }, projectedLines, projectedPoints) <= corridorFeet + halfCellDiagonal
        ? corridorIndices
        : outerIndices;
      target.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([...outerIndices, ...corridorIndices]);
  geometry.addGroup(0, outerIndices.length, 0);
  geometry.addGroup(outerIndices.length, corridorIndices.length, 1);
  geometry.computeVertexNormals();
  const texture = basemapTextureUrl ? new THREE.TextureLoader().load(basemapTextureUrl) : null;
  if (texture) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  const outerOpacity = surfaceMode === "xray" ? Math.min(opacity, 0.22) : opacity;
  const corridorOpacity = surfaceMode === "xray"
    ? Math.min(outerOpacity, 0.1)
    : Math.min(outerOpacity, surfaceMode === "technical" ? 0.2 : 0.26);
  const outerMaterial = new THREE.MeshStandardMaterial({
    color: texture ? (surfaceMode === "technical" ? 0xe3e7df : surfaceMode === "xray" ? 0xd7e7ed : 0xffffff) : 0xffffff,
    map: texture,
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    transparent: outerOpacity < 1,
    opacity: outerOpacity,
    depthWrite: outerOpacity >= 0.98,
    side: THREE.DoubleSide,
  });
  const corridorMaterial = outerMaterial.clone();
  corridorMaterial.color.set(surfaceMode === "xray" ? 0xcce1e7 : 0xdce7d5);
  corridorMaterial.transparent = true;
  corridorMaterial.opacity = corridorOpacity;
  corridorMaterial.depthWrite = false;
  const mesh = new THREE.Mesh(geometry, [outerMaterial, corridorMaterial]);
  mesh.receiveShadow = true;
  mesh.userData.tooltipTitle = "DEM terrain surface";
  mesh.userData.tooltipDetail = `${cutaway.dem_file} · elevations ${cutaway.minimum_elevation.toFixed(1)}–${cutaway.maximum_elevation.toFixed(1)} ft`;
  scene.add(mesh);
}

function addSurfaceVegetation(
  scene: THREE.Scene,
  result: FailureConsequenceResult,
  cutaway: FailureCutawayTerrain,
  terrain: TerrainContext,
) {
  const projectedLines = geometryLineStrings(cutaway.asset_geometry).map((line) => line.map(terrain.project));
  const projectedPoints = geometryPoints(cutaway.asset_geometry).map(terrain.project);
  const corridorFeet = result.asset.asset_type === "structure" ? 24 : 32;
  const random = seededRandom(String(result.asset.asset_id));
  const area = cutaway.width_feet * cutaway.height_feet;
  const grassTarget = Math.round(clamp(area / 180, 140, 800));
  const grassGeometry = new THREE.ConeGeometry(0.22, 1, 4);
  const grassMaterial = new THREE.MeshStandardMaterial({ color: 0x4f823e, roughness: 1, metalness: 0 });
  const grass = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassTarget);
  const transform = new THREE.Object3D();
  let grassCount = 0;
  for (let attempt = 0; attempt < grassTarget * 5 && grassCount < grassTarget; attempt += 1) {
    const x = (random() - 0.5) * Math.max(1, cutaway.width_feet - 12);
    const z = (random() - 0.5) * Math.max(1, cutaway.height_feet - 12);
    if (!vegetationLocationIsValid({ x, z }, corridorFeet, projectedLines, projectedPoints, terrain)) continue;
    const height = 0.55 + random() * 0.75;
    const width = 0.65 + random() * 0.8;
    transform.position.set(x, terrain.groundY(x, z) + height / 2 + 0.35, z);
    transform.rotation.set(0, random() * Math.PI, 0);
    transform.scale.set(width, height, width);
    transform.updateMatrix();
    grass.setMatrixAt(grassCount, transform.matrix);
    grassCount += 1;
  }
  grass.count = grassCount;
  grass.instanceMatrix.needsUpdate = true;
  grass.renderOrder = 2;
  grass.receiveShadow = true;
  grass.computeBoundingSphere();
  scene.add(grass);

  const treeTarget = Math.round(clamp(area / 38_000, 3, 14));
  const trunkGeometry = new THREE.CylinderGeometry(0.42, 0.58, 1, 7);
  const canopyGeometry = new THREE.IcosahedronGeometry(1, 1);
  const trunks = new THREE.InstancedMesh(
    trunkGeometry,
    new THREE.MeshStandardMaterial({ color: 0x6a4f38, roughness: 1 }),
    treeTarget,
  );
  const canopies = new THREE.InstancedMesh(
    canopyGeometry,
    new THREE.MeshStandardMaterial({ color: 0x477a3c, roughness: 0.95 }),
    treeTarget,
  );
  let treeCount = 0;
  for (let attempt = 0; attempt < treeTarget * 12 && treeCount < treeTarget; attempt += 1) {
    const x = (random() - 0.5) * Math.max(1, cutaway.width_feet - 28);
    const z = (random() - 0.5) * Math.max(1, cutaway.height_feet - 28);
    if (!vegetationLocationIsValid({ x, z }, corridorFeet * 1.45, projectedLines, projectedPoints, terrain)) continue;
    const ground = terrain.groundY(x, z) + 0.4;
    const totalHeight = 11 + random() * 10;
    const trunkHeight = totalHeight * 0.43;
    const canopyRadius = totalHeight * (0.19 + random() * 0.035);
    transform.position.set(x, ground + trunkHeight / 2, z);
    transform.rotation.set(0, random() * Math.PI, 0);
    transform.scale.set(1, trunkHeight, 1);
    transform.updateMatrix();
    trunks.setMatrixAt(treeCount, transform.matrix);
    transform.position.set(x, ground + trunkHeight + canopyRadius * 0.66, z);
    transform.rotation.set(random() * 0.08, random() * Math.PI, random() * 0.08);
    transform.scale.set(canopyRadius, canopyRadius * 1.15, canopyRadius);
    transform.updateMatrix();
    canopies.setMatrixAt(treeCount, transform.matrix);
    treeCount += 1;
  }
  trunks.count = treeCount;
  canopies.count = treeCount;
  trunks.instanceMatrix.needsUpdate = true;
  canopies.instanceMatrix.needsUpdate = true;
  trunks.castShadow = true;
  canopies.castShadow = true;
  trunks.renderOrder = 2;
  canopies.renderOrder = 2;
  trunks.computeBoundingSphere();
  canopies.computeBoundingSphere();
  scene.add(trunks, canopies);
}

function vegetationLocationIsValid(
  point: ProjectedPoint,
  corridorFeet: number,
  lines: ProjectedPoint[][],
  points: ProjectedPoint[],
  terrain: TerrainContext,
): boolean {
  if (distanceToProjectedAsset(point, lines, points) <= corridorFeet) return false;
  const step = 2.5;
  const ground = terrain.groundY(point.x, point.z);
  const slopeDelta = Math.max(
    Math.abs(terrain.groundY(point.x + step, point.z) - ground),
    Math.abs(terrain.groundY(point.x - step, point.z) - ground),
    Math.abs(terrain.groundY(point.x, point.z + step) - ground),
    Math.abs(terrain.groundY(point.x, point.z - step) - ground),
  );
  return slopeDelta <= 2.8;
}

function distanceToProjectedAsset(
  point: ProjectedPoint,
  lines: ProjectedPoint[][],
  points: ProjectedPoint[],
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.length === 1) minimum = Math.min(minimum, Math.hypot(point.x - line[0].x, point.z - line[0].z));
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      const lengthSquared = dx * dx + dz * dz;
      const fraction = lengthSquared > 0
        ? clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared, 0, 1)
        : 0;
      minimum = Math.min(minimum, Math.hypot(point.x - (start.x + dx * fraction), point.z - (start.z + dz * fraction)));
    }
  }
  for (const assetPoint of points) minimum = Math.min(minimum, Math.hypot(point.x - assetPoint.x, point.z - assetPoint.z));
  return minimum;
}

function seededRandom(seedText: string): () => number {
  let seed = 2_166_136_261;
  for (let index = 0; index < seedText.length; index += 1) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16_777_619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function addSoilBlock(
  scene: THREE.Scene,
  cutaway: FailureCutawayTerrain,
  terrain: TerrainContext,
  blockDepth: number,
  opacity: number,
) {
  const material = new THREE.MeshStandardMaterial({
    color: CUTAWAY_CUBE_COLOR,
    roughness: 0.96,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const bodyGeometry = new THREE.BoxGeometry(cutaway.width_feet, blockDepth, cutaway.height_feet);
  const body = new THREE.Mesh(bodyGeometry, material);
  body.position.y = -blockDepth / 2;
  body.receiveShadow = true;
  body.userData.tooltipTitle = "Transparent subsurface cutaway";
  body.userData.tooltipDetail = "Schematic display volume; no geological layer data is implied.";
  scene.add(body);
  const bodyEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(bodyGeometry),
    new THREE.LineBasicMaterial({ color: CUTAWAY_EDGE_COLOR, transparent: true, opacity: 0.76 }),
  );
  bodyEdges.position.copy(body.position);
  scene.add(bodyEdges);

  const boundary = terrainBoundary(cutaway, terrain);
  const positions: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < boundary.length; index += 1) {
    const current = boundary[index];
    const next = boundary[(index + 1) % boundary.length];
    const offset = positions.length / 3;
    positions.push(current.x, current.y, current.z, next.x, next.y, next.z, current.x, 0, current.z, next.x, 0, next.z);
    indices.push(offset, offset + 2, offset + 1, offset + 1, offset + 2, offset + 3);
  }
  const skirtGeometry = new THREE.BufferGeometry();
  skirtGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  skirtGeometry.setIndex(indices);
  skirtGeometry.computeVertexNormals();
  const skirt = new THREE.Mesh(skirtGeometry, material.clone());
  skirt.receiveShadow = true;
  scene.add(skirt);
  const topEdge = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(boundary.map((point) => point.clone().add(new THREE.Vector3(0, 0.35, 0)))),
    new THREE.LineBasicMaterial({ color: CUTAWAY_EDGE_COLOR, transparent: true, opacity: 0.84 }),
  );
  scene.add(topEdge);
}

function terrainBoundary(cutaway: FailureCutawayTerrain, terrain: TerrainContext): THREE.Vector3[] {
  const result: THREE.Vector3[] = [];
  const push = (row: number, column: number) => {
    const x = -cutaway.width_feet / 2 + (cutaway.width_feet * column / (cutaway.columns - 1));
    const z = -cutaway.height_feet / 2 + (cutaway.height_feet * row / (cutaway.rows - 1));
    result.push(new THREE.Vector3(x, terrain.groundY(x, z), z));
  };
  for (let column = 0; column < cutaway.columns; column += 1) push(0, column);
  for (let row = 1; row < cutaway.rows; row += 1) push(row, cutaway.columns - 1);
  for (let column = cutaway.columns - 2; column >= 0; column -= 1) push(cutaway.rows - 1, column);
  for (let row = cutaway.rows - 2; row > 0; row -= 1) push(row, 0);
  return result;
}

function buildAssetCenterlines(
  result: FailureConsequenceResult,
  cutaway: FailureCutawayTerrain,
  terrain: TerrainContext,
): AssetCenterline[] {
  const assetType = result.asset.asset_type;
  const usInvert = recordNumber(result.asset, "US_INVERT", "UPSTREAM_INVERT", "USINVERT");
  const dsInvert = recordNumber(result.asset, "DS_INVERT", "DOWNSTREAM_INVERT", "DSINVERT");
  const pipeRadius = assetType === "pipe" ? resolvePipeSizing(result.asset).radiusFeet : 0;
  return geometryLineStrings(cutaway.asset_geometry).flatMap((coordinates) => {
    const projected = coordinates.map(terrain.project);
    const cumulative = cumulativeDistances(projected);
    const total = cumulative.at(-1) ?? 1;
    const points = projected.map((point, index) => {
      const fraction = total > 0 ? cumulative[index] / total : 0;
      const elevation = usInvert != null && dsInvert != null
        ? usInvert + (dsInvert - usInvert) * fraction
        : null;
      const y = elevation != null
        ? terrain.elevationToY(elevation) + pipeRadius
        : assetType === "channel"
          ? terrain.groundY(point.x, point.z) + 0.8
          : terrain.groundY(point.x, point.z) - 7;
      return new THREE.Vector3(point.x, y, point.z);
    });
    if (points.length < 2) return [];
    return [{
      curve: new THREE.CatmullRomCurve3(points, false, "centripetal"),
      points,
      projected,
    }];
  });
}

function addSelectedAsset(scene: THREE.Scene, result: FailureConsequenceResult, cutaway: FailureCutawayTerrain, terrain: TerrainContext) {
  const geometry = cutaway.asset_geometry;
  const assetType = result.asset.asset_type;
  const centerlines = buildAssetCenterlines(result, cutaway, terrain);
  const usInvert = recordNumber(result.asset, "US_INVERT", "UPSTREAM_INVERT", "USINVERT");
  const dsInvert = recordNumber(result.asset, "DS_INVERT", "DOWNSTREAM_INVERT", "DSINVERT");
  const pipeSizing = resolvePipeSizing(result.asset);
  const drainageWidth = recordNumber(result.asset, "WIDTH") ?? 24;
  const tubeRadius = assetType === "pipe" ? pipeSizing.radiusFeet : clamp(drainageWidth / 24, 1.2, 4.2);

  if (centerlines.length) {
    for (const { curve, points, projected } of centerlines) {
      const schematicPipe = assetType === "pipe" && pipeSizing.schematic;
      const schematicElevation = assetType === "pipe" && (usInvert == null || dsInvert == null);
      const material = new THREE.MeshStandardMaterial({
        color: assetType === "channel" ? 0x139cc4 : 0x087fbd,
        roughness: 0.45,
        metalness: 0.08,
        transparent: schematicPipe || schematicElevation,
        opacity: schematicElevation ? 0.58 : schematicPipe ? 0.74 : 1,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, points.length * 5), tubeRadius, 12, false), material);
      mesh.renderOrder = 8;
      mesh.castShadow = true;
      mesh.userData.tooltipTitle = `${assetType === "channel" ? "Drainage" : "Pipe"} ${result.asset.asset_id}`;
      const elevationDetail = usInvert != null && dsInvert != null
        ? `Invert ${usInvert.toFixed(1)}–${dsInvert.toFixed(1)} ft`
        : "Depth is schematic because endpoint elevations are unavailable.";
      const diameterDetail = assetType !== "pipe"
        ? ""
        : pipeSizing.schematic
          ? ` · diameter unavailable; ${formatPipeDiameter(pipeSizing.diameterFeet)} ft schematic display`
          : ` · diameter ${formatPipeDiameter(pipeSizing.diameterFeet)} ft at true scale`;
      mesh.userData.tooltipDetail = `${elevationDetail}${diameterDetail}`;
      scene.add(mesh);

      if (assetType === "pipe") {
        const upstreamInvertPoint = points[0].clone().add(new THREE.Vector3(0, -pipeSizing.radiusFeet, 0));
        const downstreamInvertPoint = points.at(-1)!.clone().add(new THREE.Vector3(0, -pipeSizing.radiusFeet, 0));
        addStructure(scene, upstreamInvertPoint, projected[0], terrain, recordText(result.asset, "US_ASSETID", "US_ID") || "Upstream");
        addStructure(scene, downstreamInvertPoint, projected.at(-1)!, terrain, recordText(result.asset, "DS_ASSETID", "DS_ID") || "Downstream");
      }
    }
  } else {
    for (const coordinate of geometryPoints(geometry)) {
      const projected = terrain.project(coordinate);
      const ground = terrain.groundY(projected.x, projected.z);
      const invert = recordNumber(result.asset, "INVERT", "INV_ELEV", "INVERT_ELEV");
      const bottom = invert == null ? ground - 8 : terrain.elevationToY(invert);
      addStructure(scene, new THREE.Vector3(projected.x, bottom, projected.z), projected, terrain, String(result.asset.asset_id));
    }
  }
}

function addStructure(scene: THREE.Scene, assetPoint: THREE.Vector3, projected: ProjectedPoint, terrain: TerrainContext, label: string) {
  const ground = terrain.groundY(projected.x, projected.z) + 1.5;
  const bottom = Math.min(assetPoint.y, ground - 3);
  const height = Math.max(4, ground - bottom);
  const material = new THREE.MeshStandardMaterial({ color: 0x3d5363, roughness: 0.58, metalness: 0.2, depthTest: false, depthWrite: false });
  const chamber = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.5, height, 16, 1, true), material);
  chamber.renderOrder = 8;
  chamber.position.set(projected.x, bottom + height / 2, projected.z);
  chamber.castShadow = true;
  chamber.userData.tooltipTitle = `Structure ${label}`;
  chamber.userData.tooltipDetail = `Ground to connection: ${height.toFixed(1)} ft`;
  scene.add(chamber);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(4.1, 4.1, 1.4, 20), new THREE.MeshStandardMaterial({ color: 0x273947, metalness: 0.35, roughness: 0.45, depthTest: false, depthWrite: false }));
  rim.renderOrder = 8;
  rim.position.set(projected.x, ground, projected.z);
  rim.castShadow = true;
  scene.add(rim);
}

function addDefectsAndZoi(scene: THREE.Scene, result: FailureConsequenceResult, cutaway: FailureCutawayTerrain, terrain: TerrainContext) {
  const active = result.defects.find((defect) => defect.id === result.active_defect_id);
  if (!result.analysis) return;
  addAssetWideZoiOutline(scene, result.analysis.zoi_geometry, terrain);
  if (result.analysis.scenario_zoi_geometry) {
    addScenarioZoiOutline(
      scene,
      result.analysis.scenario_zoi_geometry,
      terrain,
      active?.source === "simulated" ? 0xb444d2 : 0xef6c28,
    );
  }
  const assetCenterlines = buildAssetCenterlines(result, cutaway, terrain);
  for (const defect of result.defects.filter((item) => item.located && item.geometry)) {
    for (const coordinate of geometryPoints(defect.geometry!)) {
      const projected = terrain.project(coordinate);
      const snappedAssetAnchor = nearestAssetCenterlinePoint(projected, assetCenterlines);
      const anchored = snappedAssetAnchor?.position.clone() ?? new THREE.Vector3(projected.x, terrain.groundY(projected.x, projected.z), projected.z);
      const ground = terrain.groundY(anchored.x, anchored.z);
      const depth = defect.relative_depth ?? 0;
      if (!snappedAssetAnchor) anchored.y = ground - Math.max(1.5, depth);
      const isActive = defect.id === active?.id;
      const color = defect.source === "simulated" ? 0xb444d2 : defect.source === "cityworks" ? 0xe08314 : defect.source === "inventory" ? 0x087fbd : 0xef5a31;
      const marker = createDefectMarker(result, anchored, snappedAssetAnchor?.tangent ?? null, color, isActive);
      marker.renderOrder = 10;
      marker.castShadow = true;
      marker.userData.tooltipTitle = defect.label;
      marker.userData.tooltipDetail = `${defect.source === "simulated" ? "Simulated" : "Observed"} defect${defect.condition_risk == null ? "" : ` · condition risk ${defect.condition_risk.toFixed(1)}`}`;
      scene.add(marker);

      if (isActive) {
        const coneHeight = Math.max(5, ground - anchored.y);
        const radius = defect.zoi_radius_feet ?? result.analysis.maximum_zoi_radius_feet;
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(radius, coneHeight, 48, 1, true),
          new THREE.MeshPhysicalMaterial({
            color: defect.source === "simulated" ? 0xa93bd0 : 0x15a7c9,
            transparent: true,
            opacity: 0.012,
            roughness: 0.3,
            metalness: 0,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
          }),
        );
        cone.rotation.z = Math.PI;
        cone.position.set(anchored.x, anchored.y + coneHeight / 2, anchored.z);
        cone.renderOrder = 7;
        cone.userData.tooltipTitle = "Zone of influence";
        cone.userData.tooltipDetail = `${radius.toFixed(1)} ft ground radius · ${coneHeight.toFixed(1)} ft depth`;
        scene.add(cone);
        const wire = new THREE.Mesh(
          cone.geometry.clone(),
          new THREE.MeshBasicMaterial({
            color: defect.source === "simulated" ? 0x9b34c0 : 0x078eaa,
            transparent: true,
            opacity: 0.2,
            wireframe: true,
            depthTest: false,
            depthWrite: false,
          }),
        );
        wire.rotation.copy(cone.rotation);
        wire.position.copy(cone.position);
        wire.renderOrder = 8;
        scene.add(wire);
        const ringColor = defect.source === "simulated" ? 0xa93bd0 : 0x0799bd;
        for (const fraction of [0.25, 0.5, 0.75]) {
          addGroundRing(
            scene,
            { x: anchored.x, z: anchored.z },
            anchored.y + coneHeight * fraction,
            radius * fraction,
            ringColor,
            0.38,
          );
        }
        addGroundRing(scene, { x: anchored.x, z: anchored.z }, ground + 0.8, radius, ringColor, 0.72);
      }
    }
  }
}

function createDefectMarker(
  result: FailureConsequenceResult,
  anchored: THREE.Vector3,
  tangent: THREE.Vector3 | null,
  color: number,
  isActive: boolean,
): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: isActive ? 0.48 : 0.14,
    roughness: 0.4,
    depthTest: false,
    depthWrite: false,
  });
  if (result.asset.asset_type === "pipe" && tangent && tangent.lengthSq() > 0) {
    const pipeRadius = resolvePipeSizing(result.asset).radiusFeet;
    const marker = new THREE.Mesh(
      new THREE.TorusGeometry(pipeRadius + (isActive ? 0.62 : 0.42), isActive ? 0.46 : 0.3, 10, 30),
      material,
    );
    marker.position.copy(anchored);
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent.clone().normalize());
    return marker;
  }
  const marker = new THREE.Mesh(new THREE.SphereGeometry(isActive ? 1.8 : 1.2, 18, 12), material);
  marker.position.copy(anchored);
  return marker;
}

function resolvePipeSizing(asset: Record<string, unknown>): PipeSizing {
  const diameter = recordNumber(asset, "DIAMETER", "PIPE_DIAMETER");
  const diameterFeet = diameter != null && diameter > 0 ? diameter : SCHEMATIC_PIPE_DIAMETER_FEET;
  return {
    diameterFeet,
    radiusFeet: diameterFeet / 2,
    schematic: diameter == null || diameter <= 0,
  };
}

function formatPipeDiameter(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function addAssetWideZoiOutline(scene: THREE.Scene, geometry: GeoJSON.Geometry, terrain: TerrainContext) {
  for (const polygon of geometryPolygons(geometry)) {
    for (const ring of polygon) {
      const points = ring.map((coordinate) => {
        const projected = terrain.project(coordinate);
        return new THREE.Vector3(projected.x, terrain.groundY(projected.x, projected.z) + 1.4, projected.z);
      });
      if (points.length < 3) continue;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x0799bd, transparent: true, opacity: 0.68, depthTest: false, depthWrite: false }),
      );
      line.renderOrder = 9;
      line.userData.tooltipTitle = "Asset-wide zone of influence";
      line.userData.tooltipDetail = "Conservative envelope assuming a defect may occur anywhere on the selected asset.";
      scene.add(line);
    }
  }
}

function addScenarioZoiOutline(scene: THREE.Scene, geometry: GeoJSON.Geometry, terrain: TerrainContext, color: number) {
  for (const polygon of geometryPolygons(geometry)) {
    for (const ring of polygon) {
      const points = ring.map((coordinate) => {
        const projected = terrain.project(coordinate);
        return new THREE.Vector3(projected.x, terrain.groundY(projected.x, projected.z) + 1.8, projected.z);
      });
      if (points.length < 3) continue;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.96, depthTest: false, depthWrite: false }),
      );
      line.renderOrder = 10;
      line.userData.tooltipTitle = "Active defect zone of influence";
      line.userData.tooltipDetail = "Exact screening boundary used to measure influenced consequence features.";
      scene.add(line);
    }
  }
}

function addGroundRing(scene: THREE.Scene, point: ProjectedPoint, y: number, radius: number, color: number, opacity = 0.9) {
  const curve = new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2, false, 0);
  const points = curve.getPoints(64).map((item) => new THREE.Vector3(point.x + item.x, y, point.z + item.y));
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
  line.renderOrder = 9;
  scene.add(line);
}

function addImpactedFeature(
  scene: THREE.Scene,
  feature: ImpactedFeature,
  terrain: TerrainContext,
  impactObjects: Map<string, THREE.Mesh[]>,
  influenceColor: number,
) {
  const color = IMPACT_COLORS[feature.category] ?? 0xdc7429;
  const polygons = geometryPolygons(feature.geometry);
  for (const polygon of polygons) {
    const isBuilding = feature.category === "building" || feature.category === "accessory_structure";
    const buildingHeight = feature.category === "accessory_structure"
      ? ONE_LEVEL_ACCESSORY_HEIGHT_FEET
      : ONE_LEVEL_BUILDING_HEIGHT_FEET;
    const geometry = isBuilding
      ? createTerrainFootedBuildingGeometry(polygon, terrain, buildingHeight)
      : createTerrainDrapedPolygonGeometry(polygon, terrain, CONSEQUENCE_SURFACE_OFFSET_FEET);
    if (!geometry) continue;
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: isBuilding ? 0.62 : 0.82,
      transparent: true,
      opacity: isBuilding ? 0.42 : 0.045,
      side: THREE.DoubleSide,
      polygonOffset: !isBuilding,
      polygonOffsetFactor: !isBuilding ? -1 : 0,
      polygonOffsetUnits: !isBuilding ? -1 : 0,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = isBuilding ? 5 : 4;
    mesh.castShadow = isBuilding;
    mesh.receiveShadow = true;
    mesh.userData.tooltipTitle = feature.label;
    const relationship = feature.is_influenced ? "Context feature with an influenced portion" : "Context feature";
    mesh.userData.tooltipDetail = isBuilding
      ? `${relationship} · one-story display model · ${buildingHeight.toFixed(0)} ft average height`
      : `${relationship} · draped on the DEM surface`;
    scene.add(mesh);
  }
  for (const line of geometryLineStrings(feature.geometry)) {
    const points = terrainDrapedLinePoints(line, terrain, 1.2);
    if (points.length < 2) continue;
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let index = 1; index < points.length; index += 1) path.add(new THREE.LineCurve3(points[index - 1], points[index]));
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(path, Math.max(8, points.length * 2), 1.2, 8, false),
      new THREE.MeshStandardMaterial({ color, roughness: 0.75, transparent: true, opacity: 0.24, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    );
    mesh.renderOrder = 4;
    mesh.userData.tooltipTitle = feature.label;
    mesh.userData.tooltipDetail = "Context feature";
    scene.add(mesh);
  }
  for (const coordinate of geometryPoints(feature.geometry)) {
    const projected = terrain.project(coordinate);
    const marker = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 5, 12), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.32 }));
    marker.position.set(projected.x, terrain.groundY(projected.x, projected.z) + 4, projected.z);
    marker.userData.tooltipTitle = feature.label;
    marker.userData.tooltipDetail = "Context feature";
    scene.add(marker);
  }
  if (feature.influenced_geometry) {
    addInfluencedFeatureOverlay(scene, feature, feature.influenced_geometry, terrain, impactObjects, influenceColor);
  }
}

function addInfluenceFootprint(
  scene: THREE.Scene,
  geometry: GeoJSON.Geometry,
  terrain: TerrainContext,
  color: number,
) {
  for (const polygon of geometryPolygons(geometry)) {
    const footprintGeometry = createTerrainDrapedPolygonGeometry(
      polygon,
      terrain,
      CONSEQUENCE_SURFACE_OFFSET_FEET + 0.75,
    );
    if (!footprintGeometry) continue;
    const footprint = new THREE.Mesh(
      footprintGeometry,
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.035,
        roughness: 0.82,
        transparent: true,
        opacity: 0.27,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    footprint.renderOrder = 8;
    footprint.userData.tooltipTitle = "Combined influenced area";
    footprint.userData.tooltipDetail = "Overlapping polygon impacts are merged so their color is applied only once.";
    scene.add(footprint);
  }
}

function addInfluencedFeatureOverlay(
  scene: THREE.Scene,
  feature: ImpactedFeature,
  geometry: GeoJSON.Geometry,
  terrain: TerrainContext,
  impactObjects: Map<string, THREE.Mesh[]>,
  color: number,
) {
  const detail = influencedFeatureDetail(feature);
  for (const polygon of geometryPolygons(geometry)) {
    const overlayGeometry = createTerrainDrapedPolygonGeometry(polygon, terrain, CONSEQUENCE_SURFACE_OFFSET_FEET + 1.1);
    if (!overlayGeometry) continue;
    const mesh = new THREE.Mesh(
      overlayGeometry,
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.08,
        roughness: 0.68,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    mesh.renderOrder = 10;
    mesh.userData.tooltipTitle = `${feature.label} · influenced portion`;
    mesh.userData.tooltipDetail = detail;
    registerImpactedFeatureObject(impactObjects, feature.id, mesh);
    scene.add(mesh);
    addInfluencedPolygonOutline(
      scene,
      polygon,
      terrain,
      IMPACT_COLORS[feature.category] ?? 0x667788,
      feature.label,
    );
  }
  for (const line of geometryLineStrings(geometry)) {
    const points = terrainDrapedLinePoints(line, terrain, 2.1);
    if (points.length < 2) continue;
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let index = 1; index < points.length; index += 1) path.add(new THREE.LineCurve3(points[index - 1], points[index]));
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(path, Math.max(8, points.length * 2), 1.65, 10, false),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.12, roughness: 0.55, depthTest: false, depthWrite: false }),
    );
    mesh.renderOrder = 10;
    mesh.userData.tooltipTitle = `${feature.label} · influenced portion`;
    mesh.userData.tooltipDetail = detail;
    registerImpactedFeatureObject(impactObjects, feature.id, mesh);
    scene.add(mesh);
  }
  for (const coordinate of geometryPoints(geometry)) {
    const projected = terrain.project(coordinate);
    const marker = new THREE.Mesh(
      new THREE.CylinderGeometry(3.1, 3.1, 8, 16),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.18, depthTest: false, depthWrite: false }),
    );
    marker.position.set(projected.x, terrain.groundY(projected.x, projected.z) + 4.5, projected.z);
    marker.renderOrder = 10;
    marker.userData.tooltipTitle = `${feature.label} · influenced point`;
    marker.userData.tooltipDetail = detail;
    registerImpactedFeatureObject(impactObjects, feature.id, marker);
    scene.add(marker);
  }
}

function addInfluencedPolygonOutline(
  scene: THREE.Scene,
  polygon: number[][][],
  terrain: TerrainContext,
  color: number,
  label: string,
) {
  for (const ring of polygon) {
    const points = terrainDrapedLinePoints(ring, terrain, CONSEQUENCE_SURFACE_OFFSET_FEET + 2.1);
    if (points.length < 3) continue;
    const outline = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.86,
        depthTest: false,
        depthWrite: false,
      }),
    );
    outline.renderOrder = 11;
    outline.userData.tooltipTitle = label;
    outline.userData.tooltipDetail = "Boundary of this feature's influenced portion.";
    scene.add(outline);
  }
}

function influencedFeatureDetail(feature: ImpactedFeature): string {
  const relationship = feature.relationship === "direct" ? "Direct contact" : "Within the active defect ZOI";
  if (feature.measurement_type === "area" && feature.influenced_area_sqft != null) {
    const percentage = feature.influenced_percent == null ? "" : ` · ${feature.influenced_percent.toFixed(1)}%`;
    return `${relationship} · ${feature.influenced_area_sqft.toFixed(1)} sq ft${percentage}`;
  }
  if (feature.measurement_type === "length" && feature.influenced_length_feet != null) {
    return `${relationship} · ${feature.influenced_length_feet.toFixed(1)} ft`;
  }
  return relationship;
}

function createTerrainDrapedPolygonGeometry(
  polygon: number[][][],
  terrain: TerrainContext,
  verticalOffset: number,
): THREE.BufferGeometry | null {
  const rings = projectedPolygonRings(polygon, terrain);
  if (!rings.length) return null;
  const contour = rings[0].map((point) => new THREE.Vector2(point.x, -point.z));
  const holes = rings.slice(1).map((ring) => ring.map((point) => new THREE.Vector2(point.x, -point.z)));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, holes);
  const points = rings.flat();
  if (!triangles.length || !points.length) return null;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const triangle of triangles) {
    const first = points[triangle[0]];
    const second = points[triangle[1]];
    const third = points[triangle[2]];
    const normalY = (second.z - first.z) * (third.x - first.x) - (second.x - first.x) * (third.z - first.z);
    appendTerrainDrapedTriangle(
      positions,
      indices,
      first,
      normalY >= 0 ? second : third,
      normalY >= 0 ? third : second,
      terrain,
      verticalOffset,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function appendTerrainDrapedTriangle(
  positions: number[],
  indices: number[],
  first: ProjectedPoint,
  second: ProjectedPoint,
  third: ProjectedPoint,
  terrain: TerrainContext,
  verticalOffset: number,
) {
  const longestEdge = Math.max(
    Math.hypot(second.x - first.x, second.z - first.z),
    Math.hypot(third.x - second.x, third.z - second.z),
    Math.hypot(first.x - third.x, first.z - third.z),
  );
  const divisions = Math.round(clamp(Math.ceil(longestEdge / 18), 1, 18));
  const rowOffsets: number[] = [];
  for (let row = 0; row <= divisions; row += 1) {
    rowOffsets.push(positions.length / 3);
    for (let column = 0; column <= divisions - row; column += 1) {
      const secondWeight = row / divisions;
      const thirdWeight = column / divisions;
      const firstWeight = 1 - secondWeight - thirdWeight;
      const x = first.x * firstWeight + second.x * secondWeight + third.x * thirdWeight;
      const z = first.z * firstWeight + second.z * secondWeight + third.z * thirdWeight;
      positions.push(x, terrain.groundY(x, z) + verticalOffset, z);
    }
  }
  for (let row = 0; row < divisions; row += 1) {
    for (let column = 0; column < divisions - row; column += 1) {
      const firstIndex = rowOffsets[row] + column;
      const secondIndex = rowOffsets[row + 1] + column;
      const thirdIndex = rowOffsets[row] + column + 1;
      indices.push(firstIndex, secondIndex, thirdIndex);
      if (column < divisions - row - 1) {
        const fourthIndex = rowOffsets[row + 1] + column + 1;
        indices.push(secondIndex, fourthIndex, thirdIndex);
      }
    }
  }
}

function createTerrainFootedBuildingGeometry(
  polygon: number[][][],
  terrain: TerrainContext,
  height: number,
): THREE.BufferGeometry | null {
  const rings = projectedPolygonRings(polygon, terrain);
  if (!rings.length) return null;
  const contour = rings[0].map((point) => new THREE.Vector2(point.x, -point.z));
  const holes = rings.slice(1).map((ring) => ring.map((point) => new THREE.Vector2(point.x, -point.z)));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, holes);
  const roofPoints = rings.flat();
  if (!triangles.length || !roofPoints.length) return null;
  const highestGround = Math.max(...roofPoints.map((point) => terrain.groundY(point.x, point.z)));
  const roofY = highestGround + height * terrain.verticalScale;
  const positions = roofPoints.flatMap((point) => [point.x, roofY, point.z]);
  const indices: number[] = [];
  for (const triangle of triangles) appendUpwardTriangle(indices, triangle[0], triangle[1], triangle[2], roofPoints);
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index += 1) {
      const start = ring[index];
      const end = ring[(index + 1) % ring.length];
      const offset = positions.length / 3;
      positions.push(
        start.x, terrain.groundY(start.x, start.z) + 0.35, start.z,
        end.x, terrain.groundY(end.x, end.z) + 0.35, end.z,
        start.x, roofY, start.z,
        end.x, roofY, end.z,
      );
      indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function projectedPolygonRings(polygon: number[][][], terrain: TerrainContext): ProjectedPoint[][] {
  const rings: ProjectedPoint[][] = [];
  for (const coordinates of polygon) {
    const projected = coordinates.map(terrain.project);
    if (projected.length > 1) {
      const first = projected[0];
      const last = projected.at(-1)!;
      if (Math.hypot(first.x - last.x, first.z - last.z) < 0.001) projected.pop();
    }
    if (projected.length >= 3) rings.push(projected);
  }
  return rings;
}

function appendUpwardTriangle(
  indices: number[],
  firstIndex: number,
  secondIndex: number,
  thirdIndex: number,
  points: ProjectedPoint[],
) {
  const first = points[firstIndex];
  const second = points[secondIndex];
  const third = points[thirdIndex];
  const normalY = (second.z - first.z) * (third.x - first.x) - (second.x - first.x) * (third.z - first.z);
  if (normalY >= 0) indices.push(firstIndex, secondIndex, thirdIndex);
  else indices.push(firstIndex, thirdIndex, secondIndex);
}

function terrainDrapedLinePoints(line: number[][], terrain: TerrainContext, verticalOffset: number): THREE.Vector3[] {
  const projected = line.map(terrain.project);
  if (projected.length < 2) return [];
  const points: THREE.Vector3[] = [];
  for (let index = 1; index < projected.length; index += 1) {
    const start = projected[index - 1];
    const end = projected[index];
    const distance = Math.hypot(end.x - start.x, end.z - start.z);
    const divisions = Math.max(1, Math.ceil(distance / 8));
    for (let division = index === 1 ? 0 : 1; division <= divisions; division += 1) {
      const fraction = division / divisions;
      const x = start.x + (end.x - start.x) * fraction;
      const z = start.z + (end.z - start.z) * fraction;
      points.push(new THREE.Vector3(x, terrain.groundY(x, z) + verticalOffset, z));
    }
  }
  return points;
}

function registerImpactedFeatureObject(
  impactObjects: Map<string, THREE.Mesh[]>,
  featureId: string,
  object: THREE.Mesh,
): void {
  const objects = impactObjects.get(featureId) ?? [];
  objects.push(object);
  impactObjects.set(featureId, objects);
  object.userData.baseRenderOrder = object.renderOrder;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) {
    if (!(material instanceof THREE.MeshStandardMaterial)) continue;
    material.userData.flashBaseColor = material.color.getHex();
    material.userData.flashBaseEmissive = material.emissive.getHex();
    material.userData.flashBaseEmissiveIntensity = material.emissiveIntensity;
    material.userData.flashBaseOpacity = material.opacity;
    material.userData.flashBaseTransparent = material.transparent;
    material.userData.flashBaseDepthTest = material.depthTest;
    material.userData.flashBaseDepthWrite = material.depthWrite;
  }
}

function setImpactedFeatureFlash(objects: THREE.Mesh[], pulse: number | null): void {
  const highlight = new THREE.Color(0xffc400);
  for (const object of objects) {
    object.renderOrder = pulse == null ? Number(object.userData.baseRenderOrder ?? 0) : 14;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      const baseColor = Number(material.userData.flashBaseColor ?? material.color.getHex());
      const baseEmissive = Number(material.userData.flashBaseEmissive ?? material.emissive.getHex());
      const baseIntensity = Number(material.userData.flashBaseEmissiveIntensity ?? 0);
      const baseOpacity = Number(material.userData.flashBaseOpacity ?? 1);
      if (pulse == null) {
        material.color.setHex(baseColor);
        material.emissive.setHex(baseEmissive);
        material.emissiveIntensity = baseIntensity;
        material.opacity = baseOpacity;
        material.transparent = Boolean(material.userData.flashBaseTransparent);
        material.depthTest = Boolean(material.userData.flashBaseDepthTest);
        material.depthWrite = Boolean(material.userData.flashBaseDepthWrite);
      } else {
        material.color.setHex(baseColor).lerp(highlight, 0.48 + pulse * 0.4);
        material.emissive.setHex(0xffa000);
        material.emissiveIntensity = 0.75 + pulse * 1.25;
        material.opacity = Math.max(baseOpacity, 0.82 + pulse * 0.18);
        material.transparent = true;
        material.depthTest = false;
        material.depthWrite = false;
      }
      material.needsUpdate = true;
    }
  }
}

function nearestAssetCenterlinePoint(
  point: ProjectedPoint,
  centerlines: AssetCenterline[],
): AssetAnchor | null {
  if (!centerlines.length) return null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestAnchor: AssetAnchor | null = null;
  for (const centerline of centerlines) {
    const divisions = Math.max(96, centerline.points.length * 48);
    const samples = centerline.curve.getSpacedPoints(divisions);
    for (let index = 1; index < samples.length; index += 1) {
      const start = samples[index - 1];
      const end = samples[index];
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      const lengthSquared = dx * dx + dz * dz;
      const along = lengthSquared > 0 ? clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared, 0, 1) : 0;
      const x = start.x + dx * along;
      const z = start.z + dz * along;
      const distance = Math.hypot(point.x - x, point.z - z);
      if (distance < bestDistance) {
        bestDistance = distance;
        const fraction = ((index - 1) + along) / divisions;
        bestAnchor = {
          position: centerline.curve.getPointAt(fraction),
          tangent: centerline.curve.getTangentAt(fraction).normalize(),
        };
      }
    }
  }
  return bestAnchor;
}

function geometryPoints(geometry: GeoJSON.Geometry): number[][] {
  if (geometry.type === "Point") return [geometry.coordinates as number[]];
  if (geometry.type === "MultiPoint") return geometry.coordinates as number[][];
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(geometryPoints);
  return [];
}

function geometryLineStrings(geometry: GeoJSON.Geometry): number[][][] {
  if (geometry.type === "LineString") return [geometry.coordinates as number[][]];
  if (geometry.type === "MultiLineString") return geometry.coordinates as number[][][];
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(geometryLineStrings);
  return [];
}

function geometryPolygons(geometry: GeoJSON.Geometry): number[][][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates as number[][][]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as number[][][][];
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(geometryPolygons);
  return [];
}

function cumulativeDistances(points: ProjectedPoint[]): number[] {
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances.push(distances[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z));
  }
  return distances;
}

function recordNumber(record: Record<string, unknown>, ...fields: string[]): number | null {
  const byName = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
  for (const field of fields) {
    const raw = byName.get(field.toLowerCase());
    if (raw == null || String(raw).trim() === "") continue;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function recordText(record: Record<string, unknown>, ...fields: string[]): string {
  const byName = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
  for (const field of fields) {
    const value = String(byName.get(field.toLowerCase()) ?? "").trim();
    if (value) return value;
  }
  return "";
}

function disposeScene(scene: THREE.Scene) {
  const disposedTextures = new Set<THREE.Texture>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite)) return;
    if (object.geometry && !disposedGeometries.has(object.geometry)) {
      object.geometry.dispose();
      disposedGeometries.add(object.geometry);
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (disposedMaterials.has(material)) continue;
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !disposedTextures.has(value)) {
          value.dispose();
          disposedTextures.add(value);
        }
      }
      material.dispose();
      disposedMaterials.add(material);
    }
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
