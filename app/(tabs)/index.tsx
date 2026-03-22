import React, { useState, useRef, useCallback } from "react";
import { View, Button, Text, StyleSheet } from "react-native";
import { GLView } from "expo-gl";
import * as THREE from "three";
import { Renderer } from "expo-three";
import DxfParser from "dxf-parser";

// ─── bbox ref ────────────────────────────────────────────────────────────
const bboxRef = { cx: 0, cy: 0, spanX: 1, spanY: 1 };

// ─── build THREE scene ───────────────────────────────────────────────────
function buildScene(entities: any[]): THREE.Scene {
  const scene = new THREE.Scene();
  if (entities.length === 0) return scene;

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  const touch = (x: number, y: number) => {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };

  entities.forEach((e) => {
    if (e.vertices)    e.vertices.forEach((v: any) => touch(v.x, v.y));
    if (e.center)      touch(e.center.x, e.center.y);
    if (e.position)    touch(e.position.x, e.position.y);
    if (e.startPoint)  touch(e.startPoint.x, e.startPoint.y);
  });

  const cx    = (minX + maxX) / 2;
  const cy    = (minY + maxY) / 2;
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  bboxRef.cx    = cx;
  bboxRef.cy    = cy;
  bboxRef.spanX = spanX;
  bboxRef.spanY = spanY;

  const toX = (x: number) => x - cx;
  const toY = (y: number) => y - cy;

  const black = new THREE.LineBasicMaterial({ color: 0x000000 });

  entities.forEach((e) => {

    // LINE
    if (e.type === "LINE") {
      const pts = new Float32Array([
        toX(e.vertices[0].x), toY(e.vertices[0].y), 0,
        toX(e.vertices[1].x), toY(e.vertices[1].y), 0,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
      scene.add(new THREE.Line(geo, black));
    }

    // LWPOLYLINE / POLYLINE
    if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
      const pts: number[] = [];
      e.vertices.forEach((v: any) => pts.push(toX(v.x), toY(v.y), 0));
      if (e.shape && pts.length >= 6) pts.push(pts[0], pts[1], pts[2]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.Line(geo, black));
    }

    // CIRCLE
    if (e.type === "CIRCLE") {
      const curve = new THREE.EllipseCurve(
        toX(e.center.x), toY(e.center.y),
        e.radius, e.radius, 0, Math.PI * 2, false, 0
      );
      const pts = curve.getPoints(128).flatMap(p => [p.x, p.y, 0]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.Line(geo, black));
    }

    // ARC
    if (e.type === "ARC") {
      let startAngle = THREE.MathUtils.degToRad(e.startAngle);
      let endAngle   = THREE.MathUtils.degToRad(e.endAngle);
      if (endAngle < startAngle) endAngle += Math.PI * 2;
      const curve = new THREE.EllipseCurve(
        toX(e.center.x), toY(e.center.y),
        e.radius, e.radius, startAngle, endAngle, false, 0
      );
      const pts = curve.getPoints(128).flatMap(p => [p.x, p.y, 0]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.Line(geo, black));
    }

    // SPLINE
    if (e.type === "SPLINE" && e.controlPoints?.length >= 2) {
      const cp = e.controlPoints.map(
        (p: any) => new THREE.Vector3(toX(p.x), toY(p.y), 0)
      );
      const curve = new THREE.CatmullRomCurve3(cp);
      const pts = curve.getPoints(256).flatMap(p => [p.x, p.y, p.z]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.Line(geo, black));
    }

  });

  return scene;
}

// ─── draw TEXT / MTEXT on HTML canvas overlay ────────────────────────────
function drawTexts(
  entities: any[],
  camera: THREE.OrthographicCamera,
  canvas: HTMLCanvasElement,
  cx: number,
  cy: number
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle    = "#000000";
  ctx.textBaseline = "alphabetic";

  // DXF world coords → screen pixels
  const toScreen = (wx: number, wy: number) => ({
    sx:  (wx - cx - camera.position.x) * camera.zoom + w / 2,
    sy: -(wy - cy - camera.position.y) * camera.zoom + h / 2,
  });

  entities.forEach((e) => {

    // ── TEXT ────────────────────────────────────────────────────────────
    if (e.type === "TEXT" && e.text) {
      const pos = e.startPoint ?? e.insertionPoint ?? e.position;
      if (!pos) return;

      const sizePx = (e.textHeight ?? 2.5) * camera.zoom;
      if (sizePx < 2) return;

      const { sx, sy } = toScreen(pos.x, pos.y);

      ctx.save();
      ctx.font = `${Math.max(sizePx, 8)}px sans-serif`;
      if (e.rotation) {
        ctx.translate(sx, sy);
        ctx.rotate(-THREE.MathUtils.degToRad(e.rotation));
        ctx.fillText(e.text, 0, 0);
      } else {
        ctx.fillText(e.text, sx, sy);
      }
      ctx.restore();
    }

    // ── MTEXT ───────────────────────────────────────────────────────────
    if (e.type === "MTEXT" && e.text) {
      const pos = e.position ?? e.insertionPoint;
      if (!pos) return;

      const sizePx = (e.height ?? 2.5) * camera.zoom;
      if (sizePx < 2) return;

      // strip AutoCAD inline formatting codes
      const clean = e.text
        .replace(/\\P/g, "\n")                        // paragraph break → newline
        .replace(/\\[lLkKoO]/g, "")                   // underline, strikethrough
        .replace(/\\f[^;]*;/gi, "")                   // font changes  \fArial|...;
        .replace(/\\[hHwWqQaAbBcCiI][^;]*;/g, "")    // height, width, oblique etc.
        .replace(/\{|\}/g, "")
        .trim();

      const { sx, sy } = toScreen(pos.x, pos.y);
      const lineH = sizePx * 1.2;

      ctx.save();
      ctx.font = `${Math.max(sizePx, 8)}px sans-serif`;
      if (e.rotation) {
        ctx.translate(sx, sy);
        ctx.rotate(-THREE.MathUtils.degToRad(e.rotation));
        clean.split("\n").forEach((line: string, i: number) => {
          ctx.fillText(line, 0, i * lineH);
        });
      } else {
        clean.split("\n").forEach((line: string, i: number) => {
          ctx.fillText(line, sx, sy + i * lineH);
        });
      }
      ctx.restore();
    }

  });
}

// ─── fit camera ──────────────────────────────────────────────────────────
function fitCamera(
  camera: THREE.OrthographicCamera,
  spanX: number,
  spanY: number,
  w: number,
  h: number
) {
  const aspect = w / h;
  const padded = Math.max(spanX / aspect, spanY) * 0.6;
  camera.zoom  = (h / 2) / padded;
  camera.position.set(0, 0, 10);
  camera.updateProjectionMatrix();
}

// ─── component ───────────────────────────────────────────────────────────
export default function App() {
  const [status, setStatus] = useState("No file loaded");

  const entitiesRef   = useRef<any[]>([]);
  const sceneRef      = useRef<THREE.Scene | null>(null);
  const cameraRef     = useRef<THREE.OrthographicCamera | null>(null);
  const rendererRef   = useRef<any>(null);
  const glRef         = useRef<any>(null);
  const textCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── pick & parse ─────────────────────────────────────────────────────
  const pickFile = () => {
    return new Promise<void>((resolve) => {
      const input = document.createElement("input");
      input.type   = "file";
      input.accept = ".dxf";

      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve();

        const reader = new FileReader();

        reader.onload = () => {
          try {
            const content = reader.result as string;
            const dxf = new DxfParser().parseSync(content);

            if (!dxf || !dxf.entities) {
              setStatus("Failed to parse DXF — invalid file");
              return resolve();
            }

            setStatus(`Loaded ${dxf.entities.length} entities`);
            entitiesRef.current = dxf.entities;
            sceneRef.current    = buildScene(dxf.entities);

            if (cameraRef.current && glRef.current) {
              const { drawingBufferWidth: w, drawingBufferHeight: h } = glRef.current;
              fitCamera(cameraRef.current, bboxRef.spanX, bboxRef.spanY, w, h);
            }
          } catch (err) {
            console.error("DXF parse error:", err);
            setStatus("Parse error — check console");
          }
          resolve();
        };

        reader.onerror = () => { setStatus("File read error"); resolve(); };
        reader.readAsText(file);
      };

      input.click();
    });
  };

  // ── GL init ──────────────────────────────────────────────────────────
  const onContextCreate = useCallback(async (gl: any) => {
    glRef.current = gl;
    const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;

    const renderer: any = new Renderer({ gl });
    renderer.setSize(w, h);
    renderer.setClearColor(0xffffff, 1);
    rendererRef.current = renderer;

    const camera = new THREE.OrthographicCamera(-w/2, w/2, h/2, -h/2, 1, 1000);
    camera.position.z = 10;
    cameraRef.current = camera;

    sceneRef.current = buildScene(entitiesRef.current);
    fitCamera(camera, bboxRef.spanX, bboxRef.spanY, w, h);

    const animate = () => {
      requestAnimationFrame(animate);
      renderer.render(sceneRef.current!, camera);
      gl.endFrameEXP();

      // redraw text overlay in sync with GL frame
      if (textCanvasRef.current && entitiesRef.current.length > 0) {
        drawTexts(
          entitiesRef.current,
          camera,
          textCanvasRef.current,
          bboxRef.cx,
          bboxRef.cy
        );
      }
    };
    animate();

    const canvas = gl.canvas as HTMLCanvasElement;

    // zoom
    canvas.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      camera.zoom *= e.deltaY > 0 ? 0.9 : 1.1;
      camera.updateProjectionMatrix();
    }, { passive: false });

    // pan
    let isDragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener("mousedown", (e) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
    canvas.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      camera.position.x -= (e.clientX - lastX) / camera.zoom;
      camera.position.y += (e.clientY - lastY) / camera.zoom;
      lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener("mouseup",    () => { isDragging = false; });
    canvas.addEventListener("mouseleave", () => { isDragging = false; });

    // pinch zoom
    let lastDist = 0;
    canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastDist = Math.sqrt(dx*dx + dy*dy);
      }
    });
    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx*dx + dy*dy);
        camera.zoom *= dist / lastDist;
        camera.updateProjectionMatrix();
        lastDist = dist;
      }
    }, { passive: false });

  }, []);

  // ── UI ───────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <Text style={styles.title}>DXF Viewer</Text>
      <Text style={styles.status}>{status}</Text>
      <Button title="Chọn file DXF" onPress={pickFile} />

      <View style={styles.gl}>
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
        <canvas
          ref={textCanvasRef}
          style={{
            position: "absolute",
            top: 0, left: 0,
            width: "100%", height: "100%",
            pointerEvents: "none",
            backgroundColor: "transparent",
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 48 },
  title:     { fontSize: 20, fontWeight: "bold", textAlign: "center" },
  status:    { fontSize: 12, color: "#666", textAlign: "center", marginVertical: 4 },
  gl:        { flex: 1 },
});
