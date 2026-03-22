import React, { useState, useRef, useCallback, useEffect } from "react";
import { View, Button, Text, StyleSheet, TouchableOpacity } from "react-native";
import { GLView } from "expo-gl";
import * as THREE from "three";
import { Renderer } from "expo-three";
import DxfParser from "dxf-parser";

// ─── types ────────────────────────────────────────────────────────────────
interface Pt { x: number; y: number }
interface Segment { from: Pt; to: Pt; dist: number }
interface MeasureState { active: boolean; points: Pt[]; segments: Segment[] }
type SnapType = "endpoint" | "midpoint" | "center" | "quadrant";
interface SnapCandidate { pt: Pt; type: SnapType }
interface SnapResult    { pt: Pt; type: SnapType }

// ─── ONE coordinate space: WORLD = raw_DXF − bbox_center ─────────────────
// Everything — THREE scene, snap candidates, measure points, screen↔world
// conversion — uses WORLD coords. No cx/cy confusion anywhere.
const worldRef = { cx: 0, cy: 0, spanX: 1, spanY: 1 };

// ═══════════════════════════════════════════════════════════════════════════
//  COORDINATE HELPERS  (canvas CSS rect, not drawingBuffer pixels)
// ═══════════════════════════════════════════════════════════════════════════

/** Screen px  →  WORLD coords */
function screenToWorld(
  clientX: number, clientY: number,
  canvas: HTMLCanvasElement,
  camera: THREE.OrthographicCamera,
): Pt {
  const r = canvas.getBoundingClientRect();
  // normalised device [-1,1]
  const ndcX =  (clientX - r.left)  / r.width  * 2 - 1;
  const ndcY = -((clientY - r.top)  / r.height * 2 - 1);
  // orthographic unproject: world = ndc * halfSize / zoom + camPos
  const halfW = (camera.right  - camera.left)   / 2;   // = drawingBufferWidth/2
  const halfH = (camera.top    - camera.bottom) / 2;
  return {
    x: ndcX * halfW / camera.zoom + camera.position.x,
    y: ndcY * halfH / camera.zoom + camera.position.y,
  };
}

/** WORLD coords  →  canvas CSS px */
function worldToScreen(
  wx: number, wy: number,
  canvas: HTMLCanvasElement,
  camera: THREE.OrthographicCamera,
): { sx: number; sy: number } {
  const r = canvas.getBoundingClientRect();
  const halfW = (camera.right  - camera.left) / 2;
  const halfH = (camera.top    - camera.bottom) / 2;
  const ndcX =  (wx - camera.position.x) * camera.zoom / halfW;
  const ndcY =  (wy - camera.position.y) * camera.zoom / halfH;
  return {
    sx: ( ndcX + 1) / 2 * r.width,
    sy: (-ndcY + 1) / 2 * r.height,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SNAP CANDIDATES  — stored in WORLD coords (raw − center)
// ═══════════════════════════════════════════════════════════════════════════
function collectSnapCandidates(entities: any[], cx: number, cy: number): SnapCandidate[] {
  const out: SnapCandidate[] = [];

  // convert raw DXF → WORLD once here
  const W = (x: number) => x - cx;
  const H = (y: number) => y - cy;
  const add = (rx: number, ry: number, type: SnapType) => {
    if (isFinite(rx) && isFinite(ry)) out.push({ pt: { x: W(rx), y: H(ry) }, type });
  };

  entities.forEach((e) => {
    if (e.type === "LINE") {
      const [v0, v1] = e.vertices;
      add(v0.x, v0.y, "endpoint");
      add(v1.x, v1.y, "endpoint");
      add((v0.x + v1.x) / 2, (v0.y + v1.y) / 2, "midpoint");
    }

    if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
      const verts: any[] = e.vertices;
      verts.forEach((v, i) => {
        add(v.x, v.y, "endpoint");
        const next = verts[i + 1] ?? (e.shape ? verts[0] : null);
        if (next) add((v.x + next.x) / 2, (v.y + next.y) / 2, "midpoint");
      });
    }

    if (e.type === "CIRCLE") {
      const { x, y } = e.center; const r = e.radius;
      add(x, y, "center");
      add(x + r, y, "quadrant");
      add(x - r, y, "quadrant");
      add(x, y + r, "quadrant");
      add(x, y - r, "quadrant");
    }

    if (e.type === "ARC") {
      const { x, y } = e.center; const r = e.radius;
      const sa = THREE.MathUtils.degToRad(e.startAngle);
      const ea = THREE.MathUtils.degToRad(e.endAngle);
      add(x, y, "center");
      add(x + Math.cos(sa) * r, y + Math.sin(sa) * r, "endpoint");
      add(x + Math.cos(ea) * r, y + Math.sin(ea) * r, "endpoint");
      // mid-arc
      let span = ea - sa; if (span < 0) span += Math.PI * 2;
      const ma = sa + span / 2;
      add(x + Math.cos(ma) * r, y + Math.sin(ma) * r, "midpoint");
      // quadrants inside arc
      [0, Math.PI / 2, Math.PI, Math.PI * 1.5].forEach((qa) => {
        let d = qa - sa; if (d < 0) d += Math.PI * 2;
        if (d <= span) add(x + Math.cos(qa) * r, y + Math.sin(qa) * r, "quadrant");
      });
    }

    if (e.type === "SPLINE" && e.controlPoints?.length >= 2) {
      const cp = e.controlPoints;
      add(cp[0].x, cp[0].y, "endpoint");
      add(cp[cp.length - 1].x, cp[cp.length - 1].y, "endpoint");
    }
  });

  return out;
}

const SNAP_PRIORITY: SnapType[] = ["endpoint", "center", "midpoint", "quadrant"];

/** cursor and candidates both in WORLD coords — guaranteed same space */
function findSnap(cursor: Pt, cands: SnapCandidate[], camera: THREE.OrthographicCamera, threshPx = 16): SnapResult | null {
  // threshold in world units
  const halfW = (camera.right - camera.left) / 2;
  const threshWorld = threshPx * halfW / ((camera.right - camera.left) / 2 * camera.zoom);
  // simpler: px / zoom gives world units for orthographic
  const tw = threshPx / camera.zoom;

  const hits: (SnapCandidate & { dist: number })[] = [];
  cands.forEach((c) => {
    const d = Math.hypot(c.pt.x - cursor.x, c.pt.y - cursor.y);
    if (d <= tw) hits.push({ ...c, dist: d });
  });
  if (!hits.length) return null;

  hits.sort((a, b) => {
    const dp = SNAP_PRIORITY.indexOf(a.type) - SNAP_PRIORITY.indexOf(b.type);
    return dp !== 0 ? dp : a.dist - b.dist;
  });
  return { pt: hits[0].pt, type: hits[0].type };
}

// ═══════════════════════════════════════════════════════════════════════════
//  BUILD THREE SCENE  (WORLD coords)
// ═══════════════════════════════════════════════════════════════════════════
function buildScene(entities: any[]): THREE.Scene {
  const scene = new THREE.Scene();
  if (!entities.length) return scene;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const touch = (x: number, y: number) => {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  entities.forEach((e) => {
    if (e.vertices)   e.vertices.forEach((v: any) => touch(v.x, v.y));
    if (e.center)     touch(e.center.x, e.center.y);
    if (e.position)   touch(e.position.x, e.position.y);
    if (e.startPoint) touch(e.startPoint.x, e.startPoint.y);
  });

  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  worldRef.cx = cx; worldRef.cy = cy;
  worldRef.spanX = maxX - minX || 1;
  worldRef.spanY = maxY - minY || 1;

  const W = (x: number) => x - cx;
  const H = (y: number) => y - cy;
  const black = new THREE.LineBasicMaterial({ color: 0x000000 });

  entities.forEach((e) => {
    if (e.type === "LINE") {
      const pts = new Float32Array([W(e.vertices[0].x), H(e.vertices[0].y), 0, W(e.vertices[1].x), H(e.vertices[1].y), 0]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
      scene.add(new THREE.Line(geo, black));
    }
    if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
      const pts: number[] = [];
      e.vertices.forEach((v: any) => pts.push(W(v.x), H(v.y), 0));
      if (e.shape && pts.length >= 6) pts.push(pts[0], pts[1], pts[2]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.Line(geo, black));
    }
    if (e.type === "CIRCLE") {
      const curve = new THREE.EllipseCurve(W(e.center.x), H(e.center.y), e.radius, e.radius, 0, Math.PI * 2, false, 0);
      const pts = curve.getPoints(128).flatMap(p => [p.x, p.y, 0]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.Line(geo, black));
    }
    if (e.type === "ARC") {
      let sa = THREE.MathUtils.degToRad(e.startAngle), ea = THREE.MathUtils.degToRad(e.endAngle);
      if (ea < sa) ea += Math.PI * 2;
      const curve = new THREE.EllipseCurve(W(e.center.x), H(e.center.y), e.radius, e.radius, sa, ea, false, 0);
      const pts = curve.getPoints(128).flatMap(p => [p.x, p.y, 0]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.Line(geo, black));
    }
    if (e.type === "SPLINE" && e.controlPoints?.length >= 2) {
      const cp = e.controlPoints.map((p: any) => new THREE.Vector3(W(p.x), H(p.y), 0));
      const curve = new THREE.CatmullRomCurve3(cp);
      const pts = curve.getPoints(256).flatMap(p => [p.x, p.y, p.z]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.Line(geo, black));
    }
  });
  return scene;
}

function fitCamera(camera: THREE.OrthographicCamera, spanX: number, spanY: number, w: number, h: number) {
  camera.zoom = (h / 2) / (Math.max(spanX / (w / h), spanY) * 0.6);
  camera.position.set(0, 0, 10);
  camera.updateProjectionMatrix();
}

// ═══════════════════════════════════════════════════════════════════════════
//  SNAP GLYPH  (AutoCAD style, yellow)
// ═══════════════════════════════════════════════════════════════════════════
function drawSnapGlyph(ctx: CanvasRenderingContext2D, sx: number, sy: number, type: SnapType) {
  ctx.save();
  ctx.strokeStyle = "#ffff00";
  ctx.fillStyle   = "rgba(255,255,0,0.15)";
  ctx.lineWidth   = 2;
  const S = 11;

  if (type === "endpoint") {
    ctx.beginPath(); ctx.rect(sx - S, sy - S, S * 2, S * 2);
    ctx.fill(); ctx.stroke();
  }
  if (type === "midpoint") {
    ctx.beginPath(); ctx.moveTo(sx, sy - S); ctx.lineTo(sx + S, sy + S); ctx.lineTo(sx - S, sy + S); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  if (type === "center") {
    ctx.beginPath(); ctx.arc(sx, sy, S, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx - S * 0.55, sy); ctx.lineTo(sx + S * 0.55, sy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx, sy - S * 0.55); ctx.lineTo(sx, sy + S * 0.55); ctx.stroke();
  }
  if (type === "quadrant") {
    ctx.beginPath(); ctx.moveTo(sx, sy - S); ctx.lineTo(sx + S, sy); ctx.lineTo(sx, sy + S); ctx.lineTo(sx - S, sy); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  // label
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(label, sx, sy - S - 3);
  ctx.fillStyle = "#ffff00"; ctx.fillText(label, sx, sy - S - 3);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════════════════
//  OVERLAY  — all coords converted via worldToScreen
// ═══════════════════════════════════════════════════════════════════════════
function drawOverlay(
  entities: any[],
  camera: THREE.OrthographicCamera,
  canvas: HTMLCanvasElement,
  measure: MeasureState,
  snap: SnapResult | null,
  cursor: Pt | null,       // WORLD coords
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // match CSS size (not drawingBuffer) — worldToScreen uses getBoundingClientRect too
  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);

  const toS = (wx: number, wy: number) => worldToScreen(wx, wy, canvas, camera);

  // ── DXF text ──────────────────────────────────────────────────────────
  const cx = worldRef.cx, cy = worldRef.cy;
  ctx.fillStyle = "#000"; ctx.textBaseline = "alphabetic";
  entities.forEach((e) => {
    if (e.type === "TEXT" && e.text) {
      const pos = e.startPoint ?? e.insertionPoint ?? e.position;
      if (!pos) return;
      const sz = (e.textHeight ?? 2.5) * camera.zoom;
      if (sz < 2) return;
      const { sx, sy } = toS(pos.x - cx, pos.y - cy);
      ctx.save(); ctx.font = `${Math.max(sz, 8)}px sans-serif`;
      if (e.rotation) { ctx.translate(sx, sy); ctx.rotate(-THREE.MathUtils.degToRad(e.rotation)); ctx.fillText(e.text, 0, 0); }
      else ctx.fillText(e.text, sx, sy);
      ctx.restore();
    }
    if (e.type === "MTEXT" && e.text) {
      const pos = e.position ?? e.insertionPoint;
      if (!pos) return;
      const sz = (e.height ?? 2.5) * camera.zoom;
      if (sz < 2) return;
      const clean = e.text.replace(/\\P/g, "\n").replace(/\\[lLkKoO]/g, "").replace(/\\f[^;]*;/gi, "").replace(/\\[hHwWqQaAbBcCiI][^;]*;/g, "").replace(/\{|\}/g, "").trim();
      const { sx, sy } = toS(pos.x - cx, pos.y - cy);
      ctx.save(); ctx.font = `${Math.max(sz, 8)}px sans-serif`;
      clean.split("\n").forEach((l: string, i: number) => ctx.fillText(l, sx, sy + i * sz * 1.2));
      ctx.restore();
    }
  });

  // ── completed measure segments ─────────────────────────────────────────
  measure.segments.forEach((seg) => {
    const a = toS(seg.from.x, seg.from.y);
    const b = toS(seg.to.x,   seg.to.y);
    drawMeasureLine(ctx, a.sx, a.sy, b.sx, b.sy, seg.dist);
    drawMeasureDot(ctx, a.sx, a.sy);
    drawMeasureDot(ctx, b.sx, b.sy);
  });

  // ── live dashed preview ───────────────────────────────────────────────
  if (measure.active && measure.points.length > 0 && cursor) {
    const last = measure.points[measure.points.length - 1];
    const a = toS(last.x, last.y);
    const b = toS(cursor.x, cursor.y);
    const dist = Math.hypot(cursor.x - last.x, cursor.y - last.y);
    ctx.save(); ctx.setLineDash([6, 4]);
    drawMeasureLine(ctx, a.sx, a.sy, b.sx, b.sy, dist);
    ctx.restore();
  }

  // ── placed measure points ─────────────────────────────────────────────
  measure.points.forEach((pt) => {
    const { sx, sy } = toS(pt.x, pt.y);
    drawMeasureDot(ctx, sx, sy);
  });

  // ── snap glyph ────────────────────────────────────────────────────────
  if (snap) {
    const { sx, sy } = toS(snap.pt.x, snap.pt.y);
    drawSnapGlyph(ctx, sx, sy, snap.type);
  }
}

function drawMeasureLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, dist: number) {
  ctx.save();
  ctx.strokeStyle = "#e63c00"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  const perp = Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2;
  [{ x: x1, y: y1 }, { x: x2, y: y2 }].forEach(({ x, y }) => {
    ctx.beginPath(); ctx.moveTo(x + Math.cos(perp) * 7, y + Math.sin(perp) * 7);
    ctx.lineTo(x - Math.cos(perp) * 7, y - Math.sin(perp) * 7); ctx.stroke();
  });
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const label = dist < 1 ? `${(dist * 1000).toFixed(1)} mm` : `${dist.toFixed(3)} m`;
  ctx.font = "bold 12px monospace";
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(mx - tw / 2 - 4, my - 16, tw + 8, 18);
  ctx.fillStyle = "#e63c00"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(label, mx, my - 7);
  ctx.restore();
}

function drawMeasureDot(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save(); ctx.fillStyle = "#e63c00";
  ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

// ═══════════════════════════════════════════════════════════════════════════
//  COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [status,     setStatus]     = useState("No file loaded");
  const [coords,     setCoords]     = useState({ x: 0, y: 0 });
  const [showCoords, setShowCoords] = useState(false);
  const [measuring,  setMeasuring]  = useState(false);
  const [snapOn,     setSnapOn]     = useState(true);
  const [snapLabel,  setSnapLabel]  = useState("");
  const [totalDist,  setTotalDist]  = useState<number | null>(null);

  const entitiesRef  = useRef<any[]>([]);
  const snapCandsRef = useRef<SnapCandidate[]>([]);
  const sceneRef     = useRef<THREE.Scene | null>(null);
  const cameraRef    = useRef<THREE.OrthographicCamera | null>(null);
  const rendererRef  = useRef<any>(null);
  const glRef        = useRef<any>(null);
  const overlayRef   = useRef<HTMLCanvasElement | null>(null);

  // live refs — no re-render on every frame
  const measureRef   = useRef<MeasureState>({ active: false, points: [], segments: [] });
  const snapRef      = useRef<SnapResult | null>(null);
  const cursorRef    = useRef<Pt | null>(null);   // WORLD coords
  const measuringRef = useRef(false);
  const snapOnRef    = useRef(true);

  useEffect(() => { measuringRef.current = measuring; }, [measuring]);
  useEffect(() => { snapOnRef.current    = snapOn;    }, [snapOn]);

  // ── pick & parse ──────────────────────────────────────────────────────
  const pickFile = () => new Promise<void>((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".dxf";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve();
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const dxf = new DxfParser().parseSync(reader.result as string);
          if (!dxf || !dxf.entities) { setStatus("Failed to parse DXF"); return resolve(); }
          setStatus(`Loaded ${dxf.entities.length} entities`);
          entitiesRef.current = dxf.entities;
          // build scene first so worldRef.cx/cy is set
          sceneRef.current    = buildScene(dxf.entities);
          // snap candidates in WORLD coords (using the just-computed cx/cy)
          snapCandsRef.current = collectSnapCandidates(dxf.entities, worldRef.cx, worldRef.cy);
          if (cameraRef.current && glRef.current) {
            const { drawingBufferWidth: ww, drawingBufferHeight: hh } = glRef.current;
            fitCamera(cameraRef.current, worldRef.spanX, worldRef.spanY, ww, hh);
          }
        } catch (err) { console.error(err); setStatus("Parse error"); }
        resolve();
      };
      reader.onerror = () => { setStatus("File read error"); resolve(); };
      reader.readAsText(file);
    };
    input.click();
  });

  const toggleMeasure = () => {
    const next = !measuring;
    measureRef.current = { active: next, points: [], segments: [] };
    setMeasuring(next);
    if (!next) { setTotalDist(null); snapRef.current = null; }
  };
  const clearMeasure = () => {
    measureRef.current = { active: true, points: [], segments: [] };
    setTotalDist(null);
  };

  // ── GL init ───────────────────────────────────────────────────────────
  const onContextCreate = useCallback(async (gl: any) => {
    glRef.current = gl;
    const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;

    const renderer: any = new Renderer({ gl });
    renderer.setSize(w, h); renderer.setClearColor(0xffffff, 1);
    rendererRef.current = renderer;

    // camera frustum in world units
    const camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 1, 1000);
    camera.position.z = 10; cameraRef.current = camera;

    sceneRef.current = buildScene(entitiesRef.current);
    fitCamera(camera, worldRef.spanX, worldRef.spanY, w, h);

    const animate = () => {
      requestAnimationFrame(animate);
      renderer.render(sceneRef.current!, camera);
      gl.endFrameEXP();
      if (overlayRef.current)
        drawOverlay(entitiesRef.current, camera, overlayRef.current, measureRef.current, snapRef.current, cursorRef.current);
    };
    animate();

    const canvas = gl.canvas as HTMLCanvasElement;

    // zoom
    canvas.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      camera.zoom *= e.deltaY > 0 ? 0.9 : 1.1;
      camera.updateProjectionMatrix();
    }, { passive: false });

    canvas.addEventListener("mouseenter", () => setShowCoords(true));
    canvas.addEventListener("mouseleave", () => {
      setShowCoords(false); snapRef.current = null; cursorRef.current = null; setSnapLabel("");
    });

    let isDragging = false, lastX = 0, lastY = 0;

    canvas.addEventListener("mousemove", (e: MouseEvent) => {
      // cursor in WORLD coords
      const world = screenToWorld(e.clientX, e.clientY, canvas, camera);

      let resolved = world;
      if (snapOnRef.current && snapCandsRef.current.length > 0) {
        // both cursor and candidates in WORLD coords — guaranteed match ✓
        const s = findSnap(world, snapCandsRef.current, camera);
        snapRef.current = s;
        if (s) { resolved = s.pt; setSnapLabel(s.type); }
        else setSnapLabel("");
      } else {
        snapRef.current = null; setSnapLabel("");
      }

      cursorRef.current = resolved;
      // display in raw DXF coords (add back center) so user sees real coordinates
      setCoords({ x: resolved.x + worldRef.cx, y: resolved.y + worldRef.cy });

      if (isDragging && !measuringRef.current) {
        camera.position.x -= (e.clientX - lastX) / camera.zoom;
        camera.position.y += (e.clientY - lastY) / camera.zoom;
      }
      lastX = e.clientX; lastY = e.clientY;
    });

    canvas.addEventListener("mousedown", (e: MouseEvent) => {
      if (measuringRef.current) {
        const pt = cursorRef.current ?? screenToWorld(e.clientX, e.clientY, canvas, camera);
        const ms = measureRef.current;
        if (ms.points.length > 0) {
          const last = ms.points[ms.points.length - 1];
          const dist = Math.hypot(pt.x - last.x, pt.y - last.y);
          ms.segments.push({ from: { ...last }, to: { ...pt }, dist });
          setTotalDist(ms.segments.reduce((s, seg) => s + seg.dist, 0));
        }
        ms.points.push({ ...pt });
      } else {
        isDragging = true; lastX = e.clientX; lastY = e.clientY;
      }
    });

    canvas.addEventListener("mouseup", () => { isDragging = false; });

    // double-click: finish chain (remove phantom point added by 2nd click)
    canvas.addEventListener("dblclick", () => {
      if (measuringRef.current) {
        const ms = measureRef.current;
        if (ms.points.length > 0) ms.points.pop();
        if (ms.segments.length > 0) ms.segments.pop();
        setTotalDist(ms.segments.length > 0 ? ms.segments.reduce((s, seg) => s + seg.dist, 0) : null);
      }
    });

    // right-click: undo last point
    canvas.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      if (measuringRef.current) {
        const ms = measureRef.current;
        if (ms.points.length > 0) ms.points.pop();
        if (ms.segments.length > 0) ms.segments.pop();
        setTotalDist(ms.segments.length > 0 ? ms.segments.reduce((s, seg) => s + seg.dist, 0) : null);
      }
    });

    // pinch zoom
    let lastDist = 0;
    canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2)
        lastDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    });
    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        camera.zoom *= d / lastDist; camera.updateProjectionMatrix(); lastDist = d;
      }
    }, { passive: false });

  }, []);

  // ── UI ────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <Text style={styles.title}>DXF Viewer</Text>
      <Text style={styles.status}>{status}</Text>

      <View style={styles.toolbar}>
        <Button title="Chọn file DXF" onPress={pickFile} />
        <View style={{ width: 8 }} />
        <TouchableOpacity style={[styles.toolBtn, snapOn && styles.toolBtnActive]} onPress={() => setSnapOn(v => !v)}>
          <Text style={[styles.toolTxt, snapOn && styles.toolTxtActive]}>⊕ Osnap</Text>
        </TouchableOpacity>
        <View style={{ width: 6 }} />
        <TouchableOpacity style={[styles.toolBtn, measuring && styles.toolBtnMeasure]} onPress={toggleMeasure}>
          <Text style={[styles.toolTxt, measuring && styles.toolTxtActive]}>{measuring ? "⏹ Stop" : "📏 Measure"}</Text>
        </TouchableOpacity>
        {measuring && <>
          <View style={{ width: 6 }} />
          <TouchableOpacity style={styles.toolBtn} onPress={clearMeasure}>
            <Text style={styles.toolTxt}>🗑 Clear</Text>
          </TouchableOpacity>
        </>}
      </View>

      {measuring && <Text style={styles.hint}>Click · Double-click to finish · Right-click to undo</Text>}

      <View style={styles.gl}>
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
        <canvas
          ref={overlayRef}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", backgroundColor: "transparent" } as any}
        />

        {showCoords && (
          <View style={styles.coordBox}>
            <Text style={styles.coordText}>X: {coords.x.toFixed(3)}</Text>
            <Text style={styles.coordText}>Y: {coords.y.toFixed(3)}</Text>
            {snapLabel ? <Text style={styles.snapLabel}>⊕ {snapLabel}</Text> : null}
          </View>
        )}

        {totalDist !== null && (
          <View style={styles.distBox}>
            <Text style={styles.distLbl}>Total distance</Text>
            <Text style={styles.distVal}>
              {totalDist < 1 ? `${(totalDist * 1000).toFixed(1)} mm` : `${totalDist.toFixed(3)} m`}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container:      { flex: 1, paddingTop: 48 },
  title:          { fontSize: 20, fontWeight: "bold", textAlign: "center" },
  status:         { fontSize: 12, color: "#666", textAlign: "center", marginVertical: 2 },
  toolbar:        { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, marginBottom: 4, flexWrap: "wrap" },
  hint:           { fontSize: 11, color: "#888", textAlign: "center", fontStyle: "italic", marginBottom: 2 },
  toolBtn:        { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: "#e8e8e8", borderWidth: 1, borderColor: "#ccc" },
  toolBtnActive:  { backgroundColor: "#1a73e8", borderColor: "#1a73e8" },
  toolBtnMeasure: { backgroundColor: "#e63c00", borderColor: "#e63c00" },
  toolTxt:        { fontSize: 13, color: "#333" },
  toolTxtActive:  { color: "#fff", fontWeight: "bold" },
  gl:             { flex: 1 },
  coordBox:       { position: "absolute", bottom: 12, left: 12, backgroundColor: "rgba(0,0,0,0.7)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  coordText:      { color: "#fff", fontSize: 12, fontFamily: "monospace" },
  snapLabel:      { color: "#ffff00", fontSize: 11, fontWeight: "bold", marginTop: 2 },
  distBox:        { position: "absolute", bottom: 12, right: 12, backgroundColor: "rgba(230,60,0,0.92)", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
  distLbl:        { color: "#ffe0d0", fontSize: 10, fontWeight: "bold", letterSpacing: 1 },
  distVal:        { color: "#fff", fontSize: 18, fontWeight: "bold", fontFamily: "monospace" },
});
