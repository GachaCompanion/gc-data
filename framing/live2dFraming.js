// Headless framing for Live2D (Spine) characters.
// Copied from electron/live2dFraming.js in the main app — keep in sync manually.

'use strict';

const fs   = require('fs');
const path = require('path');
const { detectFaces, getAnimatedBounds } = require('./live2dFaceDetect');

const HEAD_TOKENS = new Set(['face', 'lian', 'mian', 'tou', 'kao', 'head', 'atama', '脸', '面', '头', '颜', '颊']);
const HAIR_RE = /发|髮|hair|刘海/i;

const EYE_RE   = /youyan|zuoyan|[lr]yan\d|eyeball|eye[lr]\b|\b[lr]eye\b|eye_[lr]|\b[lr]_eye\b|眼|瞳/i;
const EYE_EXCL = /brow|lash|mei|shadow|highlight|ying|gaoguang|biyan|xian/i;

function isEyeAttachment(name) {
  return EYE_RE.test(name) && !EYE_EXCL.test(name);
}

function headTier(name) {
  if (HAIR_RE.test(name)) return null;
  const segs = name.toLowerCase().split(/[^a-z一-鿿]+/).filter(Boolean);
  if (segs.some((s) => HEAD_TOKENS.has(s))) return 'head';
  return null;
}

let _corePromise = null;
function loadCore() {
  if (!_corePromise) _corePromise = import('@esotericsoftware/spine-core');
  return _corePromise;
}

const STUB_TEXTURE = { getImage: () => ({ width: 2, height: 2 }), setFilters() {}, setWraps() {}, dispose() {} };

function attachmentCenter(core, slot, attachment) {
  let verts;
  if (attachment instanceof core.RegionAttachment) {
    verts = new Float32Array(8);
    attachment.computeWorldVertices(slot, verts, 0, 2);
  } else if (attachment instanceof core.MeshAttachment) {
    verts = new Float32Array(attachment.worldVerticesLength);
    attachment.computeWorldVertices(slot, 0, attachment.worldVerticesLength, verts, 0, 2);
  } else {
    return null;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < verts.length; i += 2) {
    minX = Math.min(minX, verts[i]);     maxX = Math.max(maxX, verts[i]);
    minY = Math.min(minY, verts[i + 1]); maxY = Math.max(maxY, verts[i + 1]);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function findHeadBone(skeleton) {
  const bones = skeleton.bones;
  if (!bones || bones.length < 2) return null;

  const ys = bones.map(b => b.worldY);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const height = maxY - minY || 1;

  const upperThreshold = minY + height * 0.60;
  const upperSet = new Set(bones.filter(b => b.worldY >= upperThreshold));
  if (!upperSet.size) return null;

  const children = new Map(bones.map(b => [b, []]));
  for (const bone of bones) {
    if (bone.parent && children.has(bone.parent)) children.get(bone.parent).push(bone);
  }

  function countUpperDesc(bone) {
    let count = 0;
    const stack = [...children.get(bone)];
    const seen = new Set();
    while (stack.length) {
      const b = stack.pop();
      if (seen.has(b)) continue;
      seen.add(b);
      if (upperSet.has(b)) count++;
      stack.push(...children.get(b));
    }
    return count;
  }

  let best = null, bestCount = -1, bestY = Infinity;
  for (const bone of upperSet) {
    const count = countUpperDesc(bone);
    if (count > bestCount || (count === bestCount && bone.worldY < bestY)) {
      best = bone; bestCount = count; bestY = bone.worldY;
    }
  }

  if (!best) return null;

  let faceH = null;
  if (best.parent) {
    const dx = best.worldX - best.parent.worldX;
    const dy = best.worldY - best.parent.worldY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1) faceH = dist * 2;
  }

  return { x: best.worldX, y: best.worldY, faceH };
}

function isSkinPixel(r, g, b, a) {
  if (a < 100) return false;
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (l < 0.35 || l > 0.88) return false;
  const d = max - min;
  if (d < 0.04) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  if (s < 0.08 || s > 0.70) return false;
  let h;
  if      (max === rn) h = 60 * (((gn - bn) / d) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / d + 2);
  else                 h = 60 * ((rn - gn) / d + 4);
  if (h < 0) h += 360;
  return h <= 45;
}

function skinScore(pixels, imgWidth, rx, ry, rw, rh) {
  let skin = 0, total = 0;
  for (let py = ry; py < ry + rh; py++) {
    for (let px = rx; px < rx + rw; px++) {
      const i = (py * imgWidth + px) * 4;
      const a = pixels[i + 3];
      if (a < 100) continue;
      total++;
      if (isSkinPixel(pixels[i], pixels[i + 1], pixels[i + 2], a)) skin++;
    }
  }
  return total > 0 ? skin / total : 0;
}

async function loadTextures(dir, atlas) {
  const sharp = require('sharp');
  const map = {};
  for (const page of atlas.pages) {
    const imgPath = path.join(dir, page.name);
    try {
      const { data, info } = await sharp(imgPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      map[page.name] = { pixels: data, width: info.width, height: info.height };
    } catch (_) {}
  }
  return map;
}

const SKIN_THRESHOLD = 0.25;

async function computeFraming(dir, bases, id, modelPath, game) {
  const core = await loadCore();
  const { TextureAtlas, AtlasAttachmentLoader, SkeletonBinary, Skeleton, Vector2 } = core;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const skinPts = [], boneAnchors = [], head = [], eyePts = [];

  for (const base of bases) {
    const atlasText = fs.readFileSync(path.join(dir, `${base}.atlas`), 'utf8');
    const atlas     = new TextureAtlas(atlasText);
    const textures  = await loadTextures(dir, atlas);
    for (const page of atlas.pages)     page.texture = STUB_TEXTURE;
    for (const region of atlas.regions) region.texture = STUB_TEXTURE;

    const skelBuf    = new Uint8Array(fs.readFileSync(path.join(dir, `${base}.skel`)));
    const skeletonData = new SkeletonBinary(new AtlasAttachmentLoader(atlas)).readSkeletonData(skelBuf);
    const skeleton   = new Skeleton(skeletonData);
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform();

    const off = new Vector2(), size = new Vector2();
    skeleton.getBounds(off, size, []);
    minX = Math.min(minX, off.x); minY = Math.min(minY, off.y);
    maxX = Math.max(maxX, off.x + size.x); maxY = Math.max(maxY, off.y + size.y);

    const ba = findHeadBone(skeleton);
    if (ba) boneAnchors.push(ba);

    for (const slot of skeleton.slots) {
      const att = slot.getAttachment();
      if (!att) continue;
      const c = attachmentCenter(core, slot, att);
      if (!c) continue;

      const region = att.region;
      if (region && region.page) {
        const tex = textures[region.page.name];
        if (tex) {
          const rw = region.rotate ? region.height : region.width;
          const rh = region.rotate ? region.width  : region.height;
          const score = skinScore(tex.pixels, tex.width, region.x, region.y, rw, rh);
          if (score >= SKIN_THRESHOLD) { skinPts.push(c); continue; }
        }
      }

      if (isEyeAttachment(att.name)) { eyePts.push(c); continue; }
      const tier = headTier(att.name);
      if (tier === 'head') head.push(c);
    }
  }

  if (!isFinite(minX)) return null;
  const w = maxX - minX, h = maxY - minY;
  const max = Math.max(w, h);

  const boneAnchor = boneAnchors.length
    ? { x: boneAnchors.reduce((s, p) => s + p.x, 0) / boneAnchors.length,
        y: boneAnchors.reduce((s, p) => s + p.y, 0) / boneAnchors.length,
        faceH: boneAnchors[0].faceH }
    : null;

  async function pickAnchor() {
    if (modelPath) {
      const boxes = await detectFaces(dir, bases, modelPath).catch(() => null);
      if (boxes && boxes.length) {
        const pick = boxes[0];
        const result = { cx: pick.cx, cy: pick.cy, max, faceH: pick.h };
        console.log(`[framing] ${id}: face-detect → cx=${result.cx.toFixed(0)} cy=${result.cy.toFixed(0)}`);
        return result;
      }
    }

    if (eyePts.length >= 2) {
      const sum = eyePts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
      const cx = sum.x / eyePts.length, cy = sum.y / eyePts.length;
      const spreadX = Math.max(...eyePts.map(p => p.x)) - Math.min(...eyePts.map(p => p.x));
      const faceH = boneAnchor?.faceH ?? (spreadX > 1 ? spreadX * 2.5 : h / 6);
      console.log(`[framing] ${id}: eye-anchor → cx=${cx.toFixed(0)} cy=${cy.toFixed(0)}`);
      return { cx, cy, max, faceH };
    }

    if (skinPts.length && boneAnchor) {
      const proxThreshY = h * 0.25;
      const nearPts = skinPts.filter(p => Math.abs(p.y - boneAnchor.y) <= proxThreshY);
      if (nearPts.length >= 3) {
        const sum = nearPts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
        const faceH = boneAnchor.faceH ?? h / 6;
        const result = { cx: sum.x / nearPts.length, cy: sum.y / nearPts.length, max, faceH };
        console.log(`[framing] ${id}: bone-Y+skin → cx=${result.cx.toFixed(0)} cy=${result.cy.toFixed(0)}`);
        return result;
      }
    }

    if (boneAnchor) {
      const faceH = boneAnchor.faceH ?? h / 6;
      console.log(`[framing] ${id}: bone-only → cx=${boneAnchor.x.toFixed(0)} cy=${boneAnchor.y.toFixed(0)}`);
      return { cx: boneAnchor.x, cy: boneAnchor.y, max, faceH };
    }

    const pts = head.length ? head : [];
    if (pts.length) {
      const sum = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
      console.log(`[framing] ${id}: head-token`);
      return { cx: sum.x / pts.length, cy: sum.y / pts.length, max };
    }

    console.log(`[framing] ${id}: bounds-center`);
    return { cx: minX + w / 2, cy: minY + h / 2, max };
  }

  const anchor = await pickAnchor();

  // Animated-pose top/bottom extent, for layouts that fit the character's
  // body span between two fixed screen lines (ZZZ's 2-TV layout) rather than
  // anchoring on the face alone. Independent of which anchor method above won.
  const bounds = await getAnimatedBounds(dir, bases).catch(() => null);
  return bounds ? { ...anchor, ...bounds } : anchor;
}

module.exports = { computeFraming };
