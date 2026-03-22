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
type SnapType = "endpoint" | "midpoint" | "center" | "quadrant" | "nearest" | "perpendicular";
interface SnapCandidate { pt: Pt; type: SnapType }
interface SnapResult    { pt: Pt; type: SnapType }

// ─── world ref  (WORLD = raw_DXF − bbox_center) ──────────────────────────
const worldRef = { cx: 0, cy: 0, spanX: 1, spanY: 1 };

// ═══════════════════════════════════════════════════════════════════════════
//  COORDINATE HELPERS  — everything in WORLD space
// ═══════════════════════════════════════════════════════════════════════════

/** Screen CSS px → WORLD */
function screenToWorld(
  clientX: number, clientY: number,
  canvas: HTMLCanvasElement,
  camera: THREE.OrthographicCamera,
): Pt {
  const r    = canvas.getBoundingClientRect();
  const halfW = (camera.right - camera.left) / 2;
  const halfH = (camera.top   - camera.bottom) / 2;
  const ndcX =  (clientX - r.left) / r.width  * 2 - 1;
  const ndcY = -((clientY - r.top)  / r.height * 2 - 1);
  return {
    x: ndcX * halfW / camera.zoom + camera.position.x,
    y: ndcY * halfH / camera.zoom + camera.position.y,
  };
}

/** WORLD → canvas CSS px */
function worldToScreen(
  wx: number, wy: number,
  canvas: HTMLCanvasElement,
  camera: THREE.OrthographicCamera,
): { sx: number; sy: number } {
  const r    = canvas.getBoundingClientRect();
  const halfW = (camera.right - camera.left) / 2;
  const halfH = (camera.top   - camera.bottom) / 2;
  const ndcX =  (wx - camera.position.x) * camera.zoom / halfW;
  const ndcY =  (wy - camera.position.y) * camera.zoom / halfH;
  return {
    sx: ( ndcX + 1) / 2 * r.width,
    sy: (-ndcY + 1) / 2 * r.height,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SNAP CANDIDATES — stored in WORLD coords
// ═══════════════════════════════════════════════════════════════════════════
function collectSnapCandidates(entities: any[], cx: number, cy: number): SnapCandidate[] {
  const out: SnapCandidate[] = [];
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
      const { x, y } = e.center, r = e.radius;
      add(x, y, "center");
      add(x + r, y, "quadrant"); add(x - r, y, "quadrant");
      add(x, y + r, "quadrant"); add(x, y - r, "quadrant");
    }
    if (e.type === "ARC") {
      const { x, y } = e.center, r = e.radius;
      const sa = THREE.MathUtils.degToRad(e.startAngle);
      const ea = THREE.MathUtils.degToRad(e.endAngle);
      add(x, y, "center");
      add(x + Math.cos(sa) * r, y + Math.sin(sa) * r, "endpoint");
      add(x + Math.cos(ea) * r, y + Math.sin(ea) * r, "endpoint");
      let span = ea - sa; if (span < 0) span += Math.PI * 2;
      add(x + Math.cos(sa + span / 2) * r, y + Math.sin(sa + span / 2) * r, "midpoint");
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

// ═══════════════════════════════════════════════════════════════════════════
//  NEAREST SNAP — closest point ON geometry (not pre-computed candidates)
//  Returns the foot of perpendicular from cursor onto each entity.
// ═══════════════════════════════════════════════════════════════════════════

/** Closest point on segment [a,b] to p */
function closestPtOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return { ...a };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return { x: a.x + t * abx, y: a.y + t * aby };
}

/** Closest point on arc/circle perimeter to p */
function closestPtOnArc(p: Pt, cx: number, cy: number, r: number, sa?: number, ea?: number): Pt {
  const angle = Math.atan2(p.y - cy, p.x - cx);
  if (sa !== undefined && ea !== undefined) {
    // clamp to arc span
    let span = ea - sa; if (span < 0) span += Math.PI * 2;
    let t = angle - sa; if (t < 0) t += Math.PI * 2;
    const clamped = t <= span ? angle : (t - span / 2 < Math.PI ? ea : sa);
    return { x: cx + Math.cos(clamped) * r, y: cy + Math.sin(clamped) * r };
  }
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

function findNearest(
  cursor: Pt,
  entities: any[],
  cx: number, cy: number,
  camera: THREE.OrthographicCamera,
  threshPx = 24,
): SnapResult | null {
  const tw = threshPx / camera.zoom;
  const W = (x: number) => x - cx;
  const H = (y: number) => y - cy;

  let best: Pt | null = null;
  let bestDist = Infinity;

  entities.forEach((e) => {
    // LINE
    if (e.type === "LINE") {
      const a = { x: W(e.vertices[0].x), y: H(e.vertices[0].y) };
      const b = { x: W(e.vertices[1].x), y: H(e.vertices[1].y) };
      const foot = closestPtOnSegment(cursor, a, b);
      const d = Math.hypot(foot.x - cursor.x, foot.y - cursor.y);
      if (d < tw && d < bestDist) { bestDist = d; best = foot; }
    }

    // LWPOLYLINE / POLYLINE
    if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
      const verts: any[] = e.vertices;
      for (let i = 0; i < verts.length - 1; i++) {
        const a = { x: W(verts[i].x), y: H(verts[i].y) };
        const b = { x: W(verts[i+1].x), y: H(verts[i+1].y) };
        const foot = closestPtOnSegment(cursor, a, b);
        const d = Math.hypot(foot.x - cursor.x, foot.y - cursor.y);
        if (d < tw && d < bestDist) { bestDist = d; best = foot; }
      }
      if (e.shape && verts.length > 1) {
        const a = { x: W(verts[verts.length-1].x), y: H(verts[verts.length-1].y) };
        const b = { x: W(verts[0].x), y: H(verts[0].y) };
        const foot = closestPtOnSegment(cursor, a, b);
        const d = Math.hypot(foot.x - cursor.x, foot.y - cursor.y);
        if (d < tw && d < bestDist) { bestDist = d; best = foot; }
      }
    }

    // CIRCLE
    if (e.type === "CIRCLE") {
      const foot = closestPtOnArc(cursor, W(e.center.x), H(e.center.y), e.radius);
      const d = Math.hypot(foot.x - cursor.x, foot.y - cursor.y);
      if (d < tw && d < bestDist) { bestDist = d; best = foot; }
    }

    // ARC
    if (e.type === "ARC") {
      const sa = THREE.MathUtils.degToRad(e.startAngle);
      let ea   = THREE.MathUtils.degToRad(e.endAngle);
      if (ea < sa) ea += Math.PI * 2;
      const foot = closestPtOnArc(cursor, W(e.center.x), H(e.center.y), e.radius, sa, ea);
      const d = Math.hypot(foot.x - cursor.x, foot.y - cursor.y);
      if (d < tw && d < bestDist) { bestDist = d; best = foot; }
    }

    // SPLINE (approximate with segments)
    if (e.type === "SPLINE" && e.controlPoints?.length >= 2) {
      const cp = e.controlPoints.map((p: any) => new THREE.Vector3(W(p.x), H(p.y), 0));
      const curve = new THREE.CatmullRomCurve3(cp);
      const pts = curve.getPoints(128);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = { x: pts[i].x,   y: pts[i].y };
        const b = { x: pts[i+1].x, y: pts[i+1].y };
        const foot = closestPtOnSegment(cursor, a, b);
        const d = Math.hypot(foot.x - cursor.x, foot.y - cursor.y);
        if (d < tw && d < bestDist) { bestDist = d; best = foot; }
      }
    }
  });

  if (!best) return null;
  return { pt: best, type: "nearest" };
}

const SNAP_PRIORITY: SnapType[] = ["endpoint", "center", "midpoint", "quadrant", "perpendicular", "nearest"];

// ═══════════════════════════════════════════════════════════════════════════
//  PERPENDICULAR SNAP
//  Given a "from" point (last placed measure point), find the point on each
//  entity where a line from "from" meets the entity at 90°.
//  • Line/segment: foot of perpendicular from "from" onto the infinite line,
//    then clamp to segment bounds.
//  • Circle/Arc:   the point on the perimeter that lies on the line through
//    center and "from" (two candidates — pick the closer one to cursor).
//  • Spline: approximate as segments.
// ═══════════════════════════════════════════════════════════════════════════

/** Foot of perpendicular from point p onto INFINITE line through a→b */
function perpFootOnLine(p: Pt, a: Pt, b: Pt): Pt | null {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return null;
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  return { x: a.x + t * abx, y: a.y + t * aby };
}

function findPerpendicular(
  from: Pt,                          // last placed measure point (WORLD)
  cursor: Pt,                        // current cursor (WORLD) — for distance check
  entities: any[],
  cx: number, cy: number,
  camera: THREE.OrthographicCamera,
  threshPx = 20,
): SnapResult | null {
  const tw = threshPx / camera.zoom;
  const W = (x: number) => x - cx;
  const H = (y: number) => y - cy;

  let best: Pt | null = null;
  let bestDist = Infinity;

  entities.forEach((e) => {

    // ── LINE ────────────────────────────────────────────────────────────
    if (e.type === "LINE") {
      const a = { x: W(e.vertices[0].x), y: H(e.vertices[0].y) };
      const b = { x: W(e.vertices[1].x), y: H(e.vertices[1].y) };
      const foot = perpFootOnLine(from, a, b);
      if (!foot) return;
      // measure distance from cursor (not from "from") — user moves cursor near the foot
      const d = Math.hypot(foot.x - cursor.x, foot.y - cursor.y);
      if (d < tw && d < bestDist) { bestDist = d; best = foot; }
    }

    // ── LWPOLYLINE / POLYLINE ────────────────────────────────────────────
    if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
      const verts: any[] = e.vertices;
      const segs = [...verts.map((v: any, i: number) => [verts[i], verts[i+1]]).slice(0, verts.length - 1)];
      if (e.shape) segs.push([verts[verts.length - 1], verts[0]]);
      segs.forEach(([v0, v1]) => {
        const a = { x: W(v0.x), y: H(v0.y) };
        const b = { x: W(v1.x), y: H(v1.y) };
        const foot = perpFootOnLine(from, a, b);
        if (!foot) return;
        const d = Math.hypot(foot.x - cursor.x, foot.y - cursor.y);
        if (d < tw && d < bestDist) { bestDist = d; best = foot; }
      });
    }

    // ── CIRCLE ──────────────────────────────────────────────────────────
    if (e.type === "CIRCLE") {
      const ocx = W(e.center.x), ocy = H(e.center.y), r = e.radius;
      // the perpendicular from "from" to the circle passes through the center
      // the two candidate points are on the line center→from at distance r
      const dx = from.x - ocx, dy = from.y - ocy;
      const len = Math.hypot(dx, dy);
      if (len === 0) return;
      const ux = dx / len, uy = dy / len;
      [1, -1].forEach((sign) => {
        const pt = { x: ocx + ux * r * sign, y: ocy + uy * r * sign };
        const d = Math.hypot(pt.x - cursor.x, pt.y - cursor.y);
        if (d < tw && d < bestDist) { bestDist = d; best = pt; }
      });
    }

    // ── ARC ─────────────────────────────────────────────────────────────
    if (e.type === "ARC") {
      const ocx = W(e.center.x), ocy = H(e.center.y), r = e.radius;
      const sa = THREE.MathUtils.degToRad(e.startAngle);
      let   ea = THREE.MathUtils.degToRad(e.endAngle);
      if (ea < sa) ea += Math.PI * 2;
      const span = ea - sa;
      const dx = from.x - ocx, dy = from.y - ocy;
      const len = Math.hypot(dx, dy);
      if (len === 0) return;
      const ux = dx / len, uy = dy / len;
      [1, -1].forEach((sign) => {
        const angle = Math.atan2(uy * sign, ux * sign);
        // check if this angle is within the arc span
        let t = angle - sa; if (t < 0) t += Math.PI * 2;
        if (t > span) return;
        const pt = { x: ocx + Math.cos(angle) * r, y: ocy + Math.sin(angle) * r };
        const d = Math.hypot(pt.x - cursor.x, pt.y - cursor.y);
        if (d < tw && d < bestDist) { bestDist = d; best = pt; }
      });
    }

    // ── SPLINE (approximate as segments) ────────────────────────────────
    if (e.type === "SPLINE" && e.controlPoints?.length >= 2) {
      const cp = e.controlPoints.map((p: any) => new THREE.Vector3(W(p.x), H(p.y), 0));
      const curve = new THREE.CatmullRomCurve3(cp);
      const pts = curve.getPoints(128);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = { x: pts[i].x,   y: pts[i].y };
        const b = { x: pts[i+1].x, y: pts[i+1].y };
        const foot = perpFootOnLine(from, a, b);
        if (!foot) continue;
        const d = Math.hypot(foot.x - cursor.x, foot.y - cursor.y);
        if (d < tw && d < bestDist) { bestDist = d; best = foot; }
      }
    }
  });

  if (!best) return null;
  return { pt: best, type: "perpendicular" };
}

function findSnap(
  cursor: Pt,
  cands: SnapCandidate[],
  entities: any[],
  cx: number, cy: number,
  camera: THREE.OrthographicCamera,
  threshPx = 16,
  from?: Pt,   // last placed measure point — enables perpendicular snap
): SnapResult | null {
  const tw = threshPx / camera.zoom;

  // 1. discrete snaps (endpoint / center / midpoint / quadrant)
  const hits: (SnapCandidate & { dist: number })[] = [];
  cands.forEach((c) => {
    const d = Math.hypot(c.pt.x - cursor.x, c.pt.y - cursor.y);
    if (d <= tw) hits.push({ ...c, dist: d });
  });
  if (hits.length) {
    hits.sort((a, b) => {
      const dp = SNAP_PRIORITY.indexOf(a.type) - SNAP_PRIORITY.indexOf(b.type);
      return dp !== 0 ? dp : a.dist - b.dist;
    });
    return { pt: hits[0].pt, type: hits[0].type };
  }

  // 2. perpendicular — only when we have a "from" point (mid-measure)
  if (from) {
    const perp = findPerpendicular(from, cursor, entities, cx, cy, camera, threshPx + 8);
    if (perp) return perp;
  }

  // 3. nearest fallback
  return findNearest(cursor, entities, cx, cy, camera, threshPx + 8);
}

// ═══════════════════════════════════════════════════════════════════════════
//  BUILD SCENE
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

function fitCamera(cam: THREE.OrthographicCamera, spanX: number, spanY: number, w: number, h: number) {
  cam.zoom = (h / 2) / (Math.max(spanX / (w / h), spanY) * 0.6);
  cam.position.set(0, 0, 10);
  cam.updateProjectionMatrix();
}

// ═══════════════════════════════════════════════════════════════════════════
//  SNAP GLYPH
// ═══════════════════════════════════════════════════════════════════════════
function drawSnapGlyph(ctx: CanvasRenderingContext2D, sx: number, sy: number, type: SnapType) {
  ctx.save();
  ctx.strokeStyle = "#ffff00";
  ctx.fillStyle   = "rgba(255,255,0,0.15)";
  ctx.lineWidth   = 2;
  const S = 11;
  if (type === "endpoint") {
    ctx.beginPath(); ctx.rect(sx - S, sy - S, S * 2, S * 2); ctx.fill(); ctx.stroke();
  } else if (type === "midpoint") {
    ctx.beginPath(); ctx.moveTo(sx, sy - S); ctx.lineTo(sx + S, sy + S); ctx.lineTo(sx - S, sy + S); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (type === "center") {
    ctx.beginPath(); ctx.arc(sx, sy, S, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx - 6, sy); ctx.lineTo(sx + 6, sy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx, sy - 6); ctx.lineTo(sx, sy + 6); ctx.stroke();
  } else if (type === "quadrant") {
    ctx.beginPath(); ctx.moveTo(sx, sy - S); ctx.lineTo(sx + S, sy); ctx.lineTo(sx, sy + S); ctx.lineTo(sx - S, sy); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (type === "nearest") {
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(sx - S, sy - S); ctx.lineTo(sx + S, sy + S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx + S, sy - S); ctx.lineTo(sx - S, sy + S); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.stroke();
  } else if (type === "perpendicular") {
    // AutoCAD perpendicular: right-angle corner symbol ⌐
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(sx - S, sy + S);   // bottom-left
    ctx.lineTo(sx - S, sy - S);   // top-left (vertical leg)
    ctx.lineTo(sx + S, sy - S);   // top-right (horizontal leg)
    ctx.stroke();
    // small square at the corner to mark 90°
    const sq = 5;
    ctx.beginPath();
    ctx.moveTo(sx - S + sq, sy - S);
    ctx.lineTo(sx - S + sq, sy - S + sq);
    ctx.lineTo(sx - S,      sy - S + sq);
    ctx.stroke();
  }
  // label
  const lbl = type.charAt(0).toUpperCase() + type.slice(1);
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(lbl, sx, sy - S - 3);
  ctx.fillStyle = "#ffff00"; ctx.fillText(lbl, sx, sy - S - 3);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════════════════
//  OVERLAY
// ═══════════════════════════════════════════════════════════════════════════
function drawOverlay(
  entities: any[],
  camera: THREE.OrthographicCamera,
  canvas: HTMLCanvasElement,
  measure: MeasureState,
  snap: SnapResult | null,
  cursor: Pt | null,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // sync canvas pixel size to CSS size
  const cw = canvas.offsetWidth, ch = canvas.offsetHeight;
  if (!cw || !ch) return;
  if (canvas.width !== cw)  canvas.width  = cw;
  if (canvas.height !== ch) canvas.height = ch;

  ctx.clearRect(0, 0, cw, ch);

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

  // ── snap glyph + perpendicular indicator ─────────────────────────────
  if (snap) {
    const { sx, sy } = toS(snap.pt.x, snap.pt.y);
    drawSnapGlyph(ctx, sx, sy, snap.type);

    // for perpendicular: draw dashed line from last measure point to snap point
    if (snap.type === "perpendicular" && measure.points.length > 0) {
      const last = measure.points[measure.points.length - 1];
      const a = toS(last.x, last.y);
      ctx.save();
      ctx.strokeStyle = "#ffff00";
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(sx, sy); ctx.stroke();
      ctx.restore();
    }
  }
}

function drawMeasureLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, dist: number) {
  ctx.save();
  ctx.strokeStyle = "#e63c00"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  const perp = Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2;
  [{ x: x1, y: y1 }, { x: x2, y: y2 }].forEach(({ x, y }) => {
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(perp) * 7, y + Math.sin(perp) * 7);
    ctx.lineTo(x - Math.cos(perp) * 7, y - Math.sin(perp) * 7);
    ctx.stroke();
  });
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const label = dist < 1 ? `${(dist * 1000).toFixed(1)} mm` : `${dist.toFixed(3)} m`;
  ctx.font = "bold 12px monospace";
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillRect(mx - tw / 2 - 4, my - 16, tw + 8, 18);
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

  const measureRef   = useRef<MeasureState>({ active: false, points: [], segments: [] });
  const snapRef      = useRef<SnapResult | null>(null);
  const cursorRef    = useRef<Pt | null>(null);  // WORLD, snapped if snap active
  const measuringRef = useRef(false);
  const snapOnRef    = useRef(true);

  // track pending dblclick — suppress the 2nd click of a double-click
  const clickTimerRef    = useRef<any>(null);
  const pendingClickRef  = useRef<Pt | null>(null);

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
          entitiesRef.current  = dxf.entities;
          sceneRef.current     = buildScene(dxf.entities);  // sets worldRef.cx/cy
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

    // ── zoom ──────────────────────────────────────────────────────────
    canvas.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      camera.zoom *= e.deltaY > 0 ? 0.9 : 1.1;
      camera.updateProjectionMatrix();
    }, { passive: false });

    canvas.addEventListener("mouseenter", () => setShowCoords(true));
    canvas.addEventListener("mouseleave", () => {
      setShowCoords(false);
      snapRef.current = null; cursorRef.current = null; setSnapLabel("");
    });

    let isDragging = false, lastX = 0, lastY = 0, didDrag = false;

    // ── mouse move: snap + coord update + pan ─────────────────────────
    canvas.addEventListener("mousemove", (e: MouseEvent) => {
      const world = screenToWorld(e.clientX, e.clientY, canvas, camera);

      let resolved = world;
      if (snapOnRef.current && snapCandsRef.current.length > 0) {
        const ms = measureRef.current;
        const from = ms.active && ms.points.length > 0
          ? ms.points[ms.points.length - 1]
          : undefined;
        const s = findSnap(world, snapCandsRef.current, entitiesRef.current, worldRef.cx, worldRef.cy, camera, 16, from);
        snapRef.current = s;
        if (s) { resolved = s.pt; setSnapLabel(s.type); }
        else setSnapLabel("");
      } else {
        snapRef.current = null; setSnapLabel("");
      }

      // always update cursor with the snapped point
      cursorRef.current = { ...resolved };

      // display raw DXF coords to user
      setCoords({ x: resolved.x + worldRef.cx, y: resolved.y + worldRef.cy });

      if (isDragging && !measuringRef.current) {
        didDrag = true;
        camera.position.x -= (e.clientX - lastX) / camera.zoom;
        camera.position.y += (e.clientY - lastY) / camera.zoom;
      }
      lastX = e.clientX; lastY = e.clientY;
    });

    // ── mouse down ────────────────────────────────────────────────────
    canvas.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) return;
      isDragging = true; didDrag = false;
      lastX = e.clientX; lastY = e.clientY;
    });

    // ── mouse up — distinguish click vs drag ──────────────────────────
    canvas.addEventListener("mouseup", (e: MouseEvent) => {
      isDragging = false;
      if (e.button !== 0) return;
      if (didDrag || !measuringRef.current) return;

      // capture the snapped point at the moment of click
      const pt = cursorRef.current
        ? { ...cursorRef.current }
        : screenToWorld(e.clientX, e.clientY, canvas, camera);

      // delay adding the point — if dblclick fires we cancel it
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      pendingClickRef.current = pt;
      clickTimerRef.current = setTimeout(() => {
        // single click confirmed — add the point
        const ms = measureRef.current;
        if (!ms.active) return;
        const p = pendingClickRef.current!;
        if (ms.points.length > 0) {
          const last = ms.points[ms.points.length - 1];
          const dist = Math.hypot(p.x - last.x, p.y - last.y);
          if (dist > 0) {
            ms.segments.push({ from: { ...last }, to: { ...p }, dist });
            setTotalDist(ms.segments.reduce((s, seg) => s + seg.dist, 0));
          }
        }
        ms.points.push({ ...p });
        pendingClickRef.current = null;
      }, 220); // 220ms window to catch dblclick
    });

    // ── double click — finish chain ───────────────────────────────────
    canvas.addEventListener("dblclick", () => {
      if (!measuringRef.current) return;
      // cancel the pending single click
      if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null; }
      pendingClickRef.current = null;
      // end the chain — nothing extra added
      setTotalDist((t) => t);  // force re-render with current total
    });

    // ── right click — undo last segment ──────────────────────────────
    canvas.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      if (!measuringRef.current) return;
      const ms = measureRef.current;
      if (ms.points.length > 0) ms.points.pop();
      if (ms.segments.length > 0) ms.segments.pop();
      setTotalDist(ms.segments.length > 0 ? ms.segments.reduce((s, seg) => s + seg.dist, 0) : null);
    });

    // ── pinch zoom ────────────────────────────────────────────────────
    let lastTDist = 0;
    canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2)
        lastTDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    });
    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        camera.zoom *= d / lastTDist; camera.updateProjectionMatrix(); lastTDist = d;
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

      {measuring && <Text style={styles.hint}>Click to place · Double-click to finish · Right-click to undo</Text>}

      <View style={styles.gl}>
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
        <canvas
          ref={overlayRef}
          style={{
            position: "absolute", top: 0, left: 0,
            width: "100%", height: "100%",
            pointerEvents: "none", backgroundColor: "transparent",
          } as any}
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
