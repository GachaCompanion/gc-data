// Headless anime-face detection for Live2D (Spine) characters.
// Copied from electron/live2dFaceDetect.js in the main app — keep in sync manually.

'use strict';

const fs    = require('fs');
const path  = require('path');
const sharp = require('sharp');
const ort   = require('onnxruntime-node');

let _scPromise = null;
function loadSpineCanvas() {
  if (!_scPromise) _scPromise = import('@esotericsoftware/spine-canvas');
  return _scPromise;
}

let _napi = null;
function napi() { if (!_napi) _napi = require('@napi-rs/canvas'); return _napi; }

let _session = null, _sessionPath = null, _sessionPromise = null;
async function getSession(modelPath) {
  if (_session && _sessionPath === modelPath) return _session;
  if (!modelPath || !fs.existsSync(modelPath)) return null;
  if (!_sessionPromise) {
    _sessionPromise = ort.InferenceSession.create(modelPath)
      .then((s) => { _session = s; _sessionPath = modelPath; return s; })
      .catch(() => { _sessionPromise = null; return null; });
  }
  return _sessionPromise;
}

const INPUT  = 1280;
const PAD    = 20;
const TARGET = 1024;
const CONF   = 0.25;

function pickAnimation(skeletonData) {
  const names = skeletonData.animations.map((a) => a.name);
  return names.find((n) => /idle|standby|talk|loop|大招/i.test(n)) ?? names[0] ?? null;
}

function computeBoneAnchor(skeleton) {
  const bones = skeleton.bones;
  if (!bones || bones.length < 2) return null;
  const idx   = new Map(bones.map((b, i) => [b, i]));
  const chain = new Float64Array(bones.length);
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    if (!b.parent) { chain[i] = 0; continue; }
    const pi = idx.get(b.parent) ?? 0;
    const dx = b.worldX - b.parent.worldX, dy = b.worldY - b.parent.worldY;
    chain[i] = chain[pi] + Math.sqrt(dx * dx + dy * dy);
  }
  const ys = bones.map((b) => b.worldY);
  const minY = Math.min(...ys), maxY = Math.max(...ys), H = maxY - minY || 1;
  const thr  = minY + H * 0.70;
  const cand = bones.filter((b, i) => b.worldY >= thr && chain[i] > 0);
  if (!cand.length) return null;
  const xs   = bones.map((b) => b.worldX).sort((a, b) => a - b);
  const medX = xs[Math.floor(xs.length / 2)];
  const score = (b) => chain[idx.get(b)] + Math.abs(b.worldX - medX) * 0.5;
  cand.sort((a, b) => score(a) - score(b));
  return { x: cand[0].worldX, y: cand[0].worldY };
}

async function buildSkeleton(sc, dir, base) {
  const { loadImage } = napi();
  const atlas = new sc.TextureAtlas(fs.readFileSync(path.join(dir, `${base}.atlas`), 'utf8'));
  for (const page of atlas.pages) {
    page.texture = new sc.CanvasTexture(await loadImage(path.join(dir, page.name)));
  }
  for (const region of atlas.regions) if (!region.texture) region.texture = region.page.texture;
  const skelBuf  = new Uint8Array(fs.readFileSync(path.join(dir, `${base}.skel`)));
  const skelData = new sc.SkeletonBinary(new sc.AtlasAttachmentLoader(atlas)).readSkeletonData(skelBuf);
  const skeleton = new sc.Skeleton(skelData);
  skeleton.setToSetupPose();
  const anim = pickAnimation(skelData);
  if (anim) {
    const state = new sc.AnimationState(new sc.AnimationStateData(skelData));
    state.setAnimation(0, anim, true);
    const dur = skelData.animations.find((a) => a.name === anim)?.duration || 0;
    state.update(dur * 0.5);
    state.apply(skeleton);
  }
  skeleton.updateWorldTransform();
  return skeleton;
}

async function renderPose(sc, dir, bases) {
  const { createCanvas } = napi();
  const skels = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let mainSk = null;
  for (const base of bases) {
    const sk = await buildSkeleton(sc, dir, base);
    const off = new sc.Vector2(), size = new sc.Vector2();
    sk.getBounds(off, size, []);
    minX = Math.min(minX, off.x); minY = Math.min(minY, off.y);
    maxX = Math.max(maxX, off.x + size.x); maxY = Math.max(maxY, off.y + size.y);
    skels.push(sk);
    if (!mainSk || sk.bones.length > mainSk.bones.length) mainSk = sk;
  }
  if (!isFinite(minX)) return null;
  const w = maxX - minX, h = maxY - minY;
  const scale = (TARGET - 2 * PAD) / Math.max(w, h);
  const cw = Math.ceil(w * scale + 2 * PAD), ch = Math.ceil(h * scale + 2 * PAD);
  const canvas = createCanvas(cw, ch);
  const ctx    = canvas.getContext('2d');
  ctx.save();
  ctx.translate(PAD - minX * scale, ch - PAD + minY * scale);
  ctx.scale(scale, -scale);
  const renderer = new sc.SkeletonRenderer(ctx);
  renderer.triangleRendering = true;
  for (const sk of skels) renderer.draw(sk);
  ctx.restore();
  return { png: canvas.toBuffer('image/png'), cw, ch, scale, minX, minY, boneAnchor: computeBoneAnchor(mainSk) };
}

// Animated-pose vertical extent (world Y, up = positive) across all skeleton
// parts. Cheap — just posing + skeleton.getBounds(), no canvas render/ONNX.
// Used to fit the character's top/bottom exactly between two screen lines
// (ZZZ's 2-TV layout), independent of whichever face-anchor method is used.
async function getAnimatedBounds(dir, bases) {
  const sc = await loadSpineCanvas();
  let minY = Infinity, maxY = -Infinity;
  for (const base of bases) {
    const sk = await buildSkeleton(sc, dir, base);
    const off = new sc.Vector2(), size = new sc.Vector2();
    sk.getBounds(off, size, []);
    minY = Math.min(minY, off.y);
    maxY = Math.max(maxY, off.y + size.y);
  }
  if (!isFinite(minY)) return null;
  return { topY: maxY, bottomY: minY };
}

function iou(a, b) {
  const ax1=a.cx-a.bw/2, ay1=a.cy-a.bh/2, ax2=a.cx+a.bw/2, ay2=a.cy+a.bh/2;
  const bx1=b.cx-b.bw/2, by1=b.cy-b.bh/2, bx2=b.cx+b.bw/2, by2=b.cy+b.bh/2;
  const ix=Math.max(0,Math.min(ax2,bx2)-Math.max(ax1,bx1));
  const iy=Math.max(0,Math.min(ay2,by2)-Math.max(ay1,by1));
  const inter=ix*iy; return inter/(a.bw*a.bh + b.bw*b.bh - inter || 1);
}

// Runs the yolov8 anime-face model on an arbitrary image buffer (any source —
// a rendered Live2D pose, or a plain PNG/webp) and returns face boxes in that
// image's own pixel space (origin top-left, same as cw/ch), sorted by
// confidence, after resize-to-letterbox + NMS. Shared by both detectFaces
// (Live2D — converts these into spine "world" units afterward) and
// detectFaceOnImage (PNG — these ARE the final coordinates, just normalized).
async function detectBoxesInImage(session, imgBuffer, cw, ch) {
  const s2 = Math.min(INPUT / cw, INPUT / ch);
  const nw = Math.round(cw * s2), nh = Math.round(ch * s2);
  const padX = Math.floor((INPUT - nw) / 2), padY = Math.floor((INPUT - nh) / 2);
  const buf = await sharp(imgBuffer).resize(nw, nh).flatten({ background: { r: 0, g: 0, b: 0 } })
    .extend({ top: padY, bottom: INPUT - nh - padY, left: padX, right: INPUT - nw - padX, background: { r: 0, g: 0, b: 0 } })
    .removeAlpha().raw().toBuffer();
  const chw   = new Float32Array(3 * INPUT * INPUT);
  const plane = INPUT * INPUT;
  for (let i = 0; i < plane; i++) {
    chw[i] = buf[i*3] / 255; chw[plane + i] = buf[i*3+1] / 255; chw[2*plane + i] = buf[i*3+2] / 255;
  }

  const out = await session.run({ images: new ort.Tensor('float32', chw, [1, 3, INPUT, INPUT]) });
  const d = out.output0.data, N = out.output0.dims[2];
  let boxes = [];
  for (let i = 0; i < N; i++) {
    const conf = d[4*N + i];
    if (conf < CONF) continue;
    boxes.push({ cx: d[i], cy: d[N+i], bw: d[2*N+i], bh: d[3*N+i], conf });
  }
  boxes.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const b of boxes) if (keep.every((k) => iou(k, b) < 0.45)) keep.push(b);

  return keep.map((b) => {
    const px = (b.cx - padX) / s2, py = (b.cy - padY) / s2;
    return { cx: px, cy: py, h: b.bh / s2, conf: b.conf };
  });
}

async function detectFaces(dir, bases, modelPath) {
  const session = await getSession(modelPath);
  if (!session) return null;
  const sc = await loadSpineCanvas();

  const r = await renderPose(sc, dir, bases).catch(() => null);
  if (!r) return null;
  const { png, cw, ch, scale, minX, minY, boneAnchor } = r;

  const boxes = await detectBoxesInImage(session, png, cw, ch);
  const world = boxes.map((b) => ({
    cx: (b.cx - PAD) / scale + minX,
    cy: (ch - PAD - b.cy) / scale + minY,
    h:   b.h / scale,
    conf: b.conf,
  }));

  if (boneAnchor && world.length > 1) {
    world.sort((a, b) =>
      Math.hypot(a.cx - boneAnchor.x, a.cy - boneAnchor.y) -
      Math.hypot(b.cx - boneAnchor.x, b.cy - boneAnchor.y));
  }
  return world;
}

// Face detection directly on a static PNG/webp — no Spine posing/rendering
// needed, since the image is already the final frame. Returns face boxes as
// fractions of the image's own width/height (0-1), so the result is directly
// usable as CSS object-position/background-position percentages regardless
// of what size the image is ultimately displayed at.
async function detectFaceOnImage(imgBuffer, modelPath) {
  const session = await getSession(modelPath);
  if (!session) return null;

  const meta = await sharp(imgBuffer).metadata();
  const cw = meta.width, ch = meta.height;
  if (!cw || !ch) return null;

  const boxes = await detectBoxesInImage(session, imgBuffer, cw, ch);
  return boxes.map((b) => ({
    cxFrac: b.cx / cw,
    cyFrac: b.cy / ch,
    hFrac:  b.h / ch,
    conf:   b.conf,
  }));
}

module.exports = { detectFaces, detectFaceOnImage, getAnimatedBounds };
