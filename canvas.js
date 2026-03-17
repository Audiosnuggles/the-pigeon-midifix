export function drawGrid(t) { 
    t.ctx.save();
    t.ctx.clearRect(0,0,t.canvas.width,t.canvas.height);
    const gridSteps = t.gridSteps || 32;
    const majorEvery = Math.max(1, Math.round(gridSteps / 8));
    for (let i = 0; i <= gridSteps; i++) {
        const isMajor = i % majorEvery === 0;
        t.ctx.beginPath();
        const x = i * (t.canvas.width / gridSteps);
        t.ctx.moveTo(x, 0);
        t.ctx.lineTo(x, t.canvas.height);
        t.ctx.strokeStyle = isMajor ? "#c7c7c7" : "#dfdfdf";
        t.ctx.lineWidth = isMajor ? 2 : 1;
        t.ctx.stroke();
    }
    t.ctx.restore(); 
    const cache = trackBaseCache.get(t);
    if (cache) cache.valid = false;
}

const trackBaseCache = new WeakMap();
const PARTICLE_CACHE_REFRESH_MS = 75;

// Hilfsfunktionen für komplexe Pinsel (die noch segmentweise berechnet werden müssen)
function drawSegmentVariable(ctx, pts, idx1, idx2, size) { const dist = Math.hypot(pts[idx2].x - pts[idx1].x, pts[idx2].y - pts[idx1].y); ctx.lineWidth = size * (1 + Math.max(0, (10 - dist) / 5)); ctx.beginPath(); ctx.moveTo(pts[idx1].x, pts[idx1].y); ctx.lineTo(pts[idx2].x, pts[idx2].y); ctx.stroke(); }
function drawSegmentCalligraphy(ctx, pts, idx1, idx2, size, calligraphyMod) {
    const angleNorm = Number.isFinite(calligraphyMod?.angleNorm) ? calligraphyMod.angleNorm : 0.25;
    const contrastNorm = Number.isFinite(calligraphyMod?.contrastNorm) ? calligraphyMod.contrastNorm : 0.5;
    const angle = ((angleNorm * 180) - 90) * (Math.PI / 180);
    const nibScale = 0.5 + contrastNorm; // 0.5..1.5, default 1.0
    const nibHalf = size * nibScale;
    const dx = Math.cos(angle) * nibHalf;
    const dy = Math.sin(angle) * nibHalf;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.moveTo(pts[idx1].x - dx, pts[idx1].y - dy);
    ctx.lineTo(pts[idx1].x + dx, pts[idx1].y + dy);
    ctx.lineTo(pts[idx2].x + dx, pts[idx2].y + dy);
    ctx.lineTo(pts[idx2].x - dx, pts[idx2].y - dy);
    ctx.fill();
}
function drawSegmentParticles(ctx, pts, idx1, idx2, size) { ctx.fillStyle = "rgba(0,0,0,0.6)"; for(let i=0; i<2; i++) { const ox = (Math.random()-0.5)*size*2, oy = (Math.random()-0.5)*size*2; ctx.beginPath(); ctx.arc(pts[idx2].x+ox, pts[idx2].y+oy, Math.max(1, size/3), 0, Math.PI*2); ctx.fill(); } }
function drawExplosionBurst(ctx, point, size, explosionMod, strokeStyle = "rgba(0, 0, 0, 0.76)", lineScale = 1) {
    const lengthNorm = Number.isFinite(explosionMod?.lengthNorm) ? explosionMod.lengthNorm : 0.55;
    const burstNorm = Number.isFinite(explosionMod?.burstNorm) ? explosionMod.burstNorm : 0.45;
    const rayCount = 4 + Math.round(burstNorm * 6);
    const rayLength = (size * (3.2 + (lengthNorm * 12.5))) * lineScale;
    const irregularity = 0.24 + (burstNorm * 0.6);
    const baseAngle = (((point?.rX || 0) + 0.5) * Math.PI * 2) + (((point?.rY || 0) + 0.5) * 0.9);
    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(0.9, size * 0.18 * lineScale);
    for (let i = 0; i < rayCount; i++) {
        const rayAngle = baseAngle + ((i / rayCount) * Math.PI * 2) + Math.sin(baseAngle + i * 1.21) * irregularity * 0.15;
        const rayScale = 0.7 + (0.3 * Math.abs(Math.sin(baseAngle + (i * 1.67))));
        const len = rayLength * rayScale;
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
        ctx.lineTo(point.x + (Math.cos(rayAngle) * len), point.y + (Math.sin(rayAngle) * len));
        ctx.stroke();
    }
    ctx.fillStyle = strokeStyle;
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(1.2, size * 0.24 * lineScale), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function getEvolveBranchPaths(point, size, evolveMod) {
    const lengthNorm = Number.isFinite(evolveMod?.lengthNorm) ? evolveMod.lengthNorm : 0.55;
    const branchNorm = Number.isFinite(evolveMod?.branchNorm) ? evolveMod.branchNorm : (Number.isFinite(evolveMod?.timeNorm) ? evolveMod.timeNorm : 0.45);
    const primaryCount = 3 + Math.round(lengthNorm * 3);
    const fan = 1.0 + (branchNorm * 0.7);
    const baseAngle = (((point?.rX || 0) + 0.5) * 0.8) - 0.4;
    const mainLength = size * (4.6 + (lengthNorm * 16.0));
    const branchLength = mainLength * (0.52 + (lengthNorm * 0.18));
    const twigLength = branchLength * (0.62 + (branchNorm * 0.12));
    const paths = [];
    const branchNodes = [];
    const root = { x: point.x, y: point.y };

    for (let i = 0; i < primaryCount; i++) {
        const spreadRatio = primaryCount === 1 ? 0 : (i / (primaryCount - 1)) - 0.5;
        const angle = baseAngle + (spreadRatio * fan);
        const end = {
            x: point.x + (Math.cos(angle) * mainLength),
            y: point.y + (Math.sin(angle) * mainLength)
        };
        const branchStart = {
            x: point.x + ((end.x - point.x) * 0.58),
            y: point.y + ((end.y - point.y) * 0.58)
        };
        paths.push({ order: i, points: [root, end] });
        branchNodes.push({ start: branchStart, angle, index: i, end });
    }

    branchNodes.forEach((node, idx) => {
        const branchSign = idx % 2 === 0 ? 1 : -1;
        const angle = node.angle + (branchSign * (0.52 + (branchNorm * 0.32)));
        const end = {
            x: node.start.x + (Math.cos(angle) * branchLength),
            y: node.start.y + (Math.sin(angle) * branchLength)
        };
        paths.push({ order: primaryCount + idx, points: [root, node.start, end] });

        const twigAngle = angle - (branchSign * (0.34 + (branchNorm * 0.18)));
        const twigStart = {
            x: node.start.x + ((end.x - node.start.x) * 0.68),
            y: node.start.y + ((end.y - node.start.y) * 0.68)
        };
        const twigEnd = {
            x: twigStart.x + (Math.cos(twigAngle) * twigLength),
            y: twigStart.y + (Math.sin(twigAngle) * twigLength)
        };
        paths.push({ order: (primaryCount * 2) + idx, points: [root, node.start, twigStart, twigEnd] });
    });

    return paths.sort((a, b) => a.order - b.order);
}

function drawPathProgress(ctx, points, progress) {
    const p = Math.max(0, Math.min(1, progress));
    if (!Array.isArray(points) || points.length < 2) return points?.[0] || { x: 0, y: 0 };
    const segLens = [];
    let totalLen = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
        segLens.push(len);
        totalLen += len;
    }
    let remaining = totalLen * p;
    let lastTip = { x: points[0].x, y: points[0].y };
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const segLen = segLens[i] || 0;
        if (remaining <= 0) break;
        const segProgress = segLen <= 0 ? 1 : Math.min(1, remaining / segLen);
        const x2 = a.x + ((b.x - a.x) * segProgress);
        const y2 = a.y + ((b.y - a.y) * segProgress);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        lastTip = { x: x2, y: y2 };
        remaining -= segLen;
        if (segProgress < 1) break;
    }
    return lastTip;
}

function drawStandardScanDot(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ff4444";
    ctx.fill();
    ctx.stroke();
}

function drawEvolveStructure(ctx, point, size, evolveMod, progress = 1, strokeStyle = "rgba(0, 0, 0, 0.76)", lineScale = 1, showScanDots = false) {
    const paths = getEvolveBranchPaths(point, size * lineScale, evolveMod);
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const total = Math.max(1, paths.length);
    const branchNorm = Number.isFinite(evolveMod?.branchNorm) ? evolveMod.branchNorm : (Number.isFinite(evolveMod?.timeNorm) ? evolveMod.timeNorm : 0.45);
    const pathWindow = 0.18 + (branchNorm * 0.18);
    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.fillStyle = strokeStyle;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1, size * 0.16 * lineScale);
    const activeTips = [];
    paths.forEach((path, idx) => {
        const start = idx / total;
        const localProgress = Math.max(0, Math.min(1, (clampedProgress - start) / pathWindow));
        if (localProgress <= 0) return;
        const tip = drawPathProgress(ctx, path.points, localProgress);
        activeTips.push(tip);
    });
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(1.4, size * 0.2 * lineScale), 0, Math.PI * 2);
    ctx.fill();
    activeTips.forEach(tip => {
        if (showScanDots) {
            drawStandardScanDot(ctx, tip.x, tip.y);
            ctx.fillStyle = strokeStyle;
            ctx.strokeStyle = strokeStyle;
        } else {
            ctx.beginPath();
            ctx.arc(tip.x, tip.y, Math.max(1.2, size * 0.16 * lineScale), 0, Math.PI * 2);
            ctx.fill();
        }
    });
    ctx.restore();
}
function drawExplosionScanOverlay(ctx, point, size, explosionMod, progress = 1) {
    const lengthNorm = Number.isFinite(explosionMod?.lengthNorm) ? explosionMod.lengthNorm : 0.55;
    const burstNorm = Number.isFinite(explosionMod?.burstNorm) ? explosionMod.burstNorm : 0.45;
    const rayCount = 4 + Math.round(burstNorm * 6);
    const rayLength = (size * (2.2 + (lengthNorm * 8.5))) * 0.55;
    const irregularity = 0.24 + (burstNorm * 0.6);
    const baseAngle = (((point?.rX || 0) + 0.5) * Math.PI * 2) + (((point?.rY || 0) + 0.5) * 0.9);
    const clampedProgress = Math.max(0.05, Math.min(1, progress));
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255, 68, 68, 0.9)";
    ctx.fillStyle = "rgba(255, 68, 68, 0.9)";
    ctx.lineWidth = Math.max(1, size * 0.16);
    for (let i = 0; i < rayCount; i++) {
        const rayAngle = baseAngle + ((i / rayCount) * Math.PI * 2) + Math.sin(baseAngle + i * 1.21) * irregularity * 0.15;
        const rayScale = 0.7 + (0.3 * Math.abs(Math.sin(baseAngle + (i * 1.67))));
        const len = rayLength * rayScale * clampedProgress;
        const x2 = point.x + (Math.cos(rayAngle) * len);
        const y2 = point.y + (Math.sin(rayAngle) * len);
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x2, y2, Math.max(1.3, size * 0.16), 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(1.5, size * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(255, 68, 68, 0.95)";
    ctx.stroke();
    ctx.restore();
}
function drawSegmentExplosion(ctx, pts, idx1, idx2, size, explosionMod) {
    const centerPoint = {
        x: (pts[idx1].x + pts[idx2].x) * 0.5,
        y: (pts[idx1].y + pts[idx2].y) * 0.5,
        rX: ((pts[idx1].rX || 0) + (pts[idx2].rX || 0)) * 0.5,
        rY: ((pts[idx1].rY || 0) + (pts[idx2].rY || 0)) * 0.5
    };
    ctx.save();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.24)";
    ctx.lineWidth = Math.max(1, size * 0.24);
    ctx.beginPath();
    ctx.moveTo(pts[idx1].x, pts[idx1].y);
    ctx.lineTo(pts[idx2].x, pts[idx2].y);
    ctx.stroke();
    ctx.restore();
    drawExplosionBurst(ctx, centerPoint, size, explosionMod);
}
function drawSegmentEvolve(ctx, pts, idx1, idx2, size, evolveMod) {
    const centerPoint = {
        x: (pts[idx1].x + pts[idx2].x) * 0.5,
        y: (pts[idx1].y + pts[idx2].y) * 0.5,
        rX: ((pts[idx1].rX || 0) + (pts[idx2].rX || 0)) * 0.5,
        rY: ((pts[idx1].rY || 0) + (pts[idx2].rY || 0)) * 0.5
    };
    drawEvolveStructure(ctx, centerPoint, size, evolveMod, 1);
}
function getEvolve2BranchPaths(pts, evolveMod) {
    const points = Array.isArray(pts) ? pts : [];
    if (points.length < 2) return [];
    const center = points[0];
    const lengthNorm = Number.isFinite(evolveMod?.lengthNorm) ? evolveMod.lengthNorm : 0.55;
    const lengthScale = 0.42 + (lengthNorm * 2.58); // max roughly 3x from center
    const grouped = new Map();
    points.slice(1).forEach((point, idx) => {
        const branchId = Number.isFinite(point?.e2b) ? point.e2b : idx;
        const order = Number.isFinite(point?.e2o) ? point.e2o : idx;
        if (!grouped.has(branchId)) grouped.set(branchId, []);
        grouped.get(branchId).push({ ...point, __order: order });
    });
    return Array.from(grouped.entries()).map(([branchId, branchPoints]) => {
        const sorted = branchPoints.sort((a, b) => a.__order - b.__order);
        const scaledPoints = sorted.map(point => ({
            ...point,
            x: center.x + ((point.x - center.x) * lengthScale),
            y: center.y + ((point.y - center.y) * lengthScale)
        }));
        return {
            order: Number(branchId) || 0,
            points: [center, ...scaledPoints]
        };
    }).sort((a, b) => a.order - b.order);
}
function drawEvolve2Structure(ctx, pts, size, evolveMod, activeStates = null, activeProgress = 1, strokeStyle = "rgba(0, 0, 0, 0.76)", lineScale = 1, showScanDots = false) {
    const paths = getEvolve2BranchPaths(pts, evolveMod);
    if (!paths.length) return;
    const branchNorm = Number.isFinite(evolveMod?.branchNorm) ? evolveMod.branchNorm : (Number.isFinite(evolveMod?.timeNorm) ? evolveMod.timeNorm : 0.45);
    const activeMap = new Map();
    const singleActive = typeof activeStates === "number" ? activeStates : null;
    if (Array.isArray(activeStates)) {
        activeStates.forEach(state => {
            if (!state) return;
            const idx = Number(state.index);
            const progress = Number(state.progress);
            if (!Number.isFinite(idx) || !Number.isFinite(progress)) return;
            activeMap.set(idx, Math.max(0, Math.min(1, progress)));
        });
    } else if (singleActive !== null) {
        activeMap.set(singleActive, Math.max(0, Math.min(1, activeProgress)));
    }
    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.fillStyle = strokeStyle;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1, size * 0.16 * lineScale);
    paths.forEach((path, idx) => {
        const progress = activeStates === null ? 1 : (activeMap.get(idx) || 0);
        if (progress <= 0) return;
        const visiblePoints = [];
        const p = Math.max(0, Math.min(1, progress));
        const segLens = [];
        let totalLen = 0;
        for (let i = 0; i < path.points.length - 1; i++) {
            const len = Math.hypot(path.points[i + 1].x - path.points[i].x, path.points[i + 1].y - path.points[i].y);
            segLens.push(len);
            totalLen += len;
        }
        let remaining = totalLen * p;
        let tip = path.points[0];
        visiblePoints.push(path.points[0]);
        for (let i = 0; i < path.points.length - 1; i++) {
            const a = path.points[i];
            const b = path.points[i + 1];
            const segLen = segLens[i] || 0;
            if (remaining <= 0) break;
            const segProgress = segLen <= 0 ? 1 : Math.min(1, remaining / segLen);
            const x2 = a.x + ((b.x - a.x) * segProgress);
            const y2 = a.y + ((b.y - a.y) * segProgress);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            tip = { x: x2, y: y2, rX: b.rX, rY: b.rY };
            visiblePoints.push(tip);
            remaining -= segLen;
            if (segProgress < 1) break;
        }
        if (branchNorm > 0.08 && visiblePoints.length > 2) {
            const twigLen = Math.max(5, size * lineScale * (0.7 + (branchNorm * 4.4)));
            const twigEvery = Math.max(1, 5 - Math.round(branchNorm * 4));
            for (let i = 1; i < visiblePoints.length - 1; i += twigEvery) {
                const base = visiblePoints[i];
                const next = visiblePoints[Math.min(visiblePoints.length - 1, i + 1)];
                const dx = next.x - base.x;
                const dy = next.y - base.y;
                const angle = Math.atan2(dy || 0.0001, dx || 0.0001);
                const side = ((base.rY || 0) >= 0 ? 1 : -1);
                const twigSpread = 0.48 + (branchNorm * 0.95);
                const twigScale = 0.7 + (0.45 * Math.abs(base.rX || 0));
                [-1, 1].forEach(dir => {
                    if (branchNorm < 0.22 && dir > 0) return;
                    const twigAngle = angle + ((side * dir) * twigSpread);
                    ctx.beginPath();
                    ctx.moveTo(base.x, base.y);
                    ctx.lineTo(
                        base.x + (Math.cos(twigAngle) * twigLen * twigScale),
                        base.y + (Math.sin(twigAngle) * twigLen * twigScale)
                    );
                    ctx.stroke();
                });
            }
        }
        if (showScanDots) drawStandardScanDot(ctx, tip.x, tip.y);
    });
    ctx.restore();
}
function drawSegmentEvolve2(ctx, pts, size, evolveMod) {
    drawEvolve2Structure(ctx, pts, size, evolveMod, null, 1);
}
function drawSegmentFractal(ctx, pts, idx1, idx2, size, liveChaos, liveMorph) { ctx.lineCap = liveMorph > 0.5 ? "square" : "round"; ctx.lineWidth = size; ctx.strokeStyle = "#000"; ctx.beginPath(); const jx1 = (pts[idx1].rX||0) * 50 * liveChaos; const jy1 = (pts[idx1].rY||0) * 100 * liveChaos; const jx2 = (pts[idx2].rX||0) * 50 * liveChaos; const jy2 = (pts[idx2].rY||0) * 100 * liveChaos; ctx.moveTo(pts[idx1].x + jx1, pts[idx1].y + jy1); ctx.lineTo(pts[idx2].x + jx2, pts[idx2].y + jy2); ctx.stroke(); if (liveMorph > 0) { ctx.lineWidth = Math.max(1, size * (liveMorph * 1.5)); ctx.strokeStyle = `rgba(255, 68, 68, ${liveMorph * 0.7})`; ctx.beginPath(); ctx.moveTo(pts[idx1].x + jx1 * (1 + liveMorph), pts[idx1].y + jy1 * (1 + liveMorph)); ctx.lineTo(pts[idx2].x + jx2 * (1 + liveMorph), pts[idx2].y + jy2 * (1 + liveMorph)); ctx.stroke(); } }
function drawSegmentXenakis(ctx, pts, idx1, idx2, size) { ctx.strokeStyle = "rgba(0, 0, 0, 0.4)"; for (let i = -2; i <= 2; i++) { ctx.lineWidth = Math.max(1, size / 3); ctx.beginPath(); const wave1 = Math.sin(pts[idx1].x * 0.04 + i * 1.5) * size * 1.5; const wave2 = Math.sin(pts[idx2].x * 0.04 + i * 1.5) * size * 1.5; ctx.moveTo(pts[idx1].x, pts[idx1].y + wave1 + (i * size * 0.5)); ctx.lineTo(pts[idx2].x, pts[idx2].y + wave2 + (i * size * 0.5)); ctx.stroke(); } ctx.strokeStyle = "#000"; }
function drawSegmentFM(ctx, pts, idx1, idx2, size) { ctx.lineWidth = size * 2.5; ctx.strokeStyle = "rgba(0, 150, 255, 0.2)"; ctx.beginPath(); ctx.moveTo(pts[idx1].x, pts[idx1].y); ctx.lineTo(pts[idx2].x, pts[idx2].y); ctx.stroke(); ctx.lineWidth = Math.max(1, size / 2); ctx.strokeStyle = "#000"; ctx.beginPath(); const side1 = (idx1 % 2 === 0) ? 1 : -1; const side2 = (idx2 % 2 === 0) ? 1 : -1; const fmSpread = size * 1.2; ctx.moveTo(pts[idx1].x, pts[idx1].y + fmSpread * side1); ctx.lineTo(pts[idx2].x, pts[idx2].y + fmSpread * side2); ctx.stroke(); }

function getTrackBaseCacheEntry(track) {
    let entry = trackBaseCache.get(track);
    const width = track.canvas.width;
    const height = track.canvas.height;
    if (!entry || entry.width !== width || entry.height !== height) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        entry = {
            canvas,
            ctx: canvas.getContext("2d"),
            width,
            height,
            valid: false,
            lastParticlesRefreshMs: 0
        };
        trackBaseCache.set(track, entry);
    }
    return entry;
}

function trackHasParticleSegments(track) {
    const segs = Array.isArray(track?.segments) ? track.segments : [];
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if ((seg?.brush || "standard") !== "particles") continue;
        if (Array.isArray(seg.points) && seg.points.length > 1) return true;
    }
    return false;
}

function drawTrackBaseLayer(t, chordIntervals, chordColors, liveChaos, liveMorph, targetCtx) {
    const originalCtx = t.ctx;
    t.ctx = targetCtx;
    try {
        drawGrid(t);

        t.segments.forEach(seg => {
            const pts = seg.points; if (pts.length < 1) return;
            const brush = seg.brush || "standard"; const size = seg.thickness || 5;

            t.ctx.save();

            if (t.selectedSegments && t.selectedSegments.includes(seg)) {
                t.ctx.shadowColor = "#0275ff";
                t.ctx.shadowBlur = 8;
            }

            t.ctx.lineJoin = "round";
            t.ctx.lineCap = "round";
            t.ctx.strokeStyle = "#000";
            t.ctx.lineWidth = size;

            if (brush === "standard") {
                t.ctx.beginPath();
                t.ctx.moveTo(pts[0].x, pts[0].y);
                for(let i=1; i<pts.length; i++) t.ctx.lineTo(pts[i].x, pts[i].y);
                t.ctx.stroke();
            } else if (brush === "rorschach") {
                t.ctx.beginPath();
                t.ctx.moveTo(pts[0].x, pts[0].y);
                for(let i=1; i<pts.length; i++) t.ctx.lineTo(pts[i].x, pts[i].y);
                t.ctx.stroke();

                t.ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
                t.ctx.beginPath();
                t.ctx.moveTo(pts[0].x, 100 - pts[0].y);
                for(let i=1; i<pts.length; i++) t.ctx.lineTo(pts[i].x, 100 - pts[i].y);
                t.ctx.stroke();
            } else if (brush === "overtone") {
                for (let j = 1; j <= 5; j++) {
                    t.ctx.lineWidth = size / j;
                    t.ctx.strokeStyle = `rgba(0, 0, 0, ${1 / j})`;
                    t.ctx.beginPath();
                    const offset = Math.log2(j) * 20;
                    t.ctx.moveTo(pts[0].x, pts[0].y - offset);
                    for(let i=1; i<pts.length; i++) t.ctx.lineTo(pts[i].x, pts[i].y - offset);
                    t.ctx.stroke();
                }
            } else if (brush === "chord") {
                const ivs = chordIntervals[seg.chordType || "major"] || chordIntervals["major"];
                ivs.forEach((iv,i) => {
                    t.ctx.save();
                    t.ctx.beginPath();
                    t.ctx.strokeStyle = chordColors ? chordColors[i%3] : '#000';
                    t.ctx.lineWidth = size;
                    t.ctx.moveTo(pts[0].x, pts[0].y-iv*5);
                    for(let k=1;k<pts.length;k++) t.ctx.lineTo(pts[k].x,pts[k].y-iv*5);
                    t.ctx.stroke();
                    t.ctx.restore();
                });
            } else if (brush === "particles") {
                for(let i=1;i<pts.length;i++) drawSegmentParticles(t.ctx, pts, i-1, i, size);
            } else {
                for(let i=1;i<pts.length;i++){
                    switch(brush){
                        case "variable": drawSegmentVariable(t.ctx, pts, i-1, i, size); break;
                        case "calligraphy": drawSegmentCalligraphy(t.ctx, pts, i-1, i, size, seg.calligraphy); break;
                        case "explosion": drawSegmentExplosion(t.ctx, pts, i-1, i, size, seg.explosion); break;
                        case "evolve": drawSegmentEvolve(t.ctx, pts, i-1, i, size, seg.evolve); break;
                        case "evolve2":
                            if (i === 1) drawSegmentEvolve2(t.ctx, pts, size, seg.evolve);
                            break;
                        case "fractal": drawSegmentFractal(t.ctx, pts, i-1, i, size, liveChaos, liveMorph); break;
                        case "xenakis": drawSegmentXenakis(t.ctx, pts, i-1, i, size); break;
                        case "fm": drawSegmentFM(t.ctx, pts, i-1, i, size); break;
                    }
                }
            }

            t.ctx.restore();
        });

        if (t.selectionBox) {
            t.ctx.fillStyle = "rgba(0, 150, 255, 0.2)";
            t.ctx.strokeStyle = "rgba(0, 150, 255, 0.8)";
            t.ctx.lineWidth = 1;
            t.ctx.fillRect(t.selectionBox.x, t.selectionBox.y, t.selectionBox.w, t.selectionBox.h);
            t.ctx.strokeRect(t.selectionBox.x, t.selectionBox.y, t.selectionBox.w, t.selectionBox.h);
        }
    } finally {
        t.ctx = originalCtx;
    }
}

function normalizeScanState(scanArg) {
    if (scanArg === undefined || scanArg === null) return null;
    if (typeof scanArg === "number") return { mode: "x", hx: scanArg };
    if (typeof scanArg === "object") {
        const mode = scanArg.mode === "draw" ? "draw" : "x";
        const forceBase = !!scanArg.forceBase;
        if (mode === "draw") return { mode, localElapsed: Number(scanArg.localElapsed) || 0, trackDuration: Number(scanArg.trackDuration) || 0, forceBase };
        return { mode: "x", hx: Number(scanArg.hx) || 0, localElapsed: Number(scanArg.localElapsed) || 0, trackDuration: Number(scanArg.trackDuration) || 0, forceBase };
    }
    return null;
}

function findLatestActivePoint(points, track, timing, localElapsed, trackDuration, sweepDur) {
    const pointCount = Array.isArray(points) ? points.length : 0;
    if (!pointCount) return null;
    let activePoint = null;
    let activeProgress = 0;
    let latestPointTime = -Infinity;
    for (let i = 0; i < pointCount; i++) {
        const pointTime = getDrawPointLocalTime(track, timing, i, pointCount, trackDuration);
        const dt = localElapsed - pointTime;
        if (dt < 0 || dt > sweepDur) continue;
        if (pointTime >= latestPointTime) {
            latestPointTime = pointTime;
            activePoint = points[i];
            activeProgress = Math.max(0.04, Math.min(1, dt / Math.max(0.001, sweepDur)));
        }
    }
    return activePoint ? { point: activePoint, progress: activeProgress } : null;
}

function quantizeLocalTimeToGrid(track, localTime, trackDuration) {
    if (!track || !track.snap) return localTime;
    if (!Number.isFinite(trackDuration) || trackDuration <= 0) return localTime;
    const gridSteps = Math.max(1, Number(track.gridSteps) || 32);
    const stepDuration = trackDuration / gridSteps;
    if (!Number.isFinite(stepDuration) || stepDuration <= 0) return localTime;
    const clamped = Math.max(0, Math.min(trackDuration, localTime));
    const snapped = Math.round(clamped / stepDuration) * stepDuration;
    return Math.max(0, Math.min(trackDuration, snapped));
}

function getDrawSegmentTiming(seg, trackDuration) {
    const pts = Array.isArray(seg?.points) ? seg.points : [];
    if (!pts.length || !Number.isFinite(trackDuration) || trackDuration <= 0) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    pts.forEach(p => {
        const x = Number(p && p.x);
        if (!Number.isFinite(x)) return;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
    });
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
        minX = 0;
        maxX = 0;
    }
    const firstX = Number(pts[0] && pts[0].x);
    const startX = Number.isFinite(firstX) ? firstX : minX;
    const rangeX = Math.max(0, maxX - minX);
    const drawSpan = Math.max(0.02, (rangeX / 750) * trackDuration);
    const drawOffset = Math.max(0, Math.min(trackDuration, (startX / 750) * trackDuration));
    const available = Math.max(0.02, trackDuration - drawOffset);
    const drawDuration = Math.min(drawSpan, available);
    return { drawOffset, drawDuration };
}

function getDrawPointLocalTime(track, timing, pointIndex, pointCount, trackDuration) {
    const ratio = pointCount > 1 ? (pointIndex / (pointCount - 1)) : 0;
    const rawLocal = timing.drawOffset + (ratio * timing.drawDuration);
    return quantizeLocalTimeToGrid(track, rawLocal, trackDuration);
}

function getExplosionVisualSweepDuration(trackDuration, explosionMod) {
    const lengthNorm = Number.isFinite(explosionMod?.lengthNorm) ? explosionMod.lengthNorm : 0.55;
    const burstNorm = Number.isFinite(explosionMod?.burstNorm) ? explosionMod.burstNorm : 0.45;
    const baseSweep = 0.04 + (lengthNorm * 0.16) + (burstNorm * 0.03);
    const maxSweep = Number.isFinite(trackDuration) && trackDuration > 0
        ? Math.max(0.05, trackDuration * 0.32)
        : 0.24;
    return Math.min(baseSweep, maxSweep);
}

function getEvolveVisualSweepDuration(trackDuration, evolveMod) {
    const lengthNorm = Number.isFinite(evolveMod?.lengthNorm) ? evolveMod.lengthNorm : 0.55;
    const branchNorm = Number.isFinite(evolveMod?.branchNorm) ? evolveMod.branchNorm : (Number.isFinite(evolveMod?.timeNorm) ? evolveMod.timeNorm : 0.45);
    const baseSweep = 0.16 + (branchNorm * 0.34) + (lengthNorm * 0.18);
    const maxSweep = Number.isFinite(trackDuration) && trackDuration > 0
        ? Math.max(0.2, trackDuration * 0.86)
        : 0.92;
    return Math.min(baseSweep, maxSweep);
}

function drawExplosionPlaybackProgress(ctx, track, seg, timing, localElapsed, trackDuration) {
    const pts = Array.isArray(seg?.points) ? seg.points : [];
    const sweepDur = getExplosionVisualSweepDuration(trackDuration, seg.explosion);
    const active = findLatestActivePoint(pts, track, timing, localElapsed, trackDuration, sweepDur);
    if (active) {
        drawExplosionScanOverlay(ctx, active.point, seg.thickness || 5, seg.explosion, active.progress);
    }
}

function drawEvolvePlaybackProgress(ctx, track, seg, timing, localElapsed, trackDuration) {
    const pts = Array.isArray(seg?.points) ? seg.points : [];
    const sweepDur = getEvolveVisualSweepDuration(trackDuration, seg.evolve);
    const active = findLatestActivePoint(pts, track, timing, localElapsed, trackDuration, sweepDur);
    if (active) {
        drawEvolveStructure(ctx, active.point, seg.thickness || 5, seg.evolve, active.progress, "rgba(255, 68, 68, 0.9)", 0.95, true);
    }
}

function drawEvolve2PlaybackProgress(ctx, track, seg, timing, localElapsed, trackDuration) {
    const pts = Array.isArray(seg?.points) ? seg.points : [];
    if (pts.length < 2) return;
    if (!Number.isFinite(localElapsed) || localElapsed < timing.drawOffset) return;
    const paths = getEvolve2BranchPaths(pts, seg.evolve);
    if (!paths.length) return;
    const allOrders = paths.flatMap(path => path.points.slice(1).map(p => Number.isFinite(p?.__order) ? p.__order : 0));
    const maxOrder = allOrders.length ? Math.max(...allOrders) : 0;
    const currentRatio = Math.max(0, Math.min(1, (localElapsed - timing.drawOffset) / Math.max(0.001, timing.drawDuration)));
    const orderFloat = maxOrder > 0 ? currentRatio * maxOrder : 0;
    const activePaths = [];

    paths.forEach(path => {
        const branchPoints = path.points;
        if (branchPoints.length < 2) return;
        const firstOrder = Number.isFinite(branchPoints[1]?.__order) ? branchPoints[1].__order : 0;
        const lastOrder = Number.isFinite(branchPoints[branchPoints.length - 1]?.__order) ? branchPoints[branchPoints.length - 1].__order : 0;
        if (orderFloat < firstOrder || orderFloat > (lastOrder + 1)) return;

        const visible = [branchPoints[0]];
        let tip = branchPoints[0];

        for (let i = 1; i < branchPoints.length; i++) {
            const prev = branchPoints[i - 1];
            const next = branchPoints[i];
            const prevOrder = Number.isFinite(prev?.__order) ? prev.__order : firstOrder;
            const nextOrder = Number.isFinite(next?.__order) ? next.__order : prevOrder;

            if (orderFloat >= nextOrder) {
                visible.push(next);
                tip = next;
                continue;
            }

            const span = Math.max(0.0001, nextOrder - prevOrder);
            const localProgress = Math.max(0, Math.min(1, (orderFloat - prevOrder) / span));
            tip = {
                x: prev.x + ((next.x - prev.x) * localProgress),
                y: prev.y + ((next.y - prev.y) * localProgress)
            };
            visible.push(tip);
            break;
        }

        if (visible.length > 1) activePaths.push({ points: visible, tip });
    });

    if (!activePaths.length) return;

    ctx.save();
    ctx.strokeStyle = "rgba(255, 68, 68, 0.9)";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1, (seg.thickness || 5) * 0.15);
    activePaths.forEach(path => {
        ctx.beginPath();
        ctx.moveTo(path.points[0].x, path.points[0].y);
        for (let i = 1; i < path.points.length; i++) {
            ctx.lineTo(path.points[i].x, path.points[i].y);
        }
        ctx.stroke();
        drawStandardScanDot(ctx, path.tip.x, path.tip.y);
    });
    ctx.restore();
}

function findDrawHitPoint(track, seg, timing, localElapsed, trackDuration, activeWindow, isSnapped) {
    const pts = Array.isArray(seg?.points) ? seg.points : [];
    const pointCount = pts.length;
    if (pointCount === 0) return null;

    if (pointCount === 1) {
        const p0Time = getDrawPointLocalTime(track, timing, 0, 1, trackDuration);
        if (Math.abs(localElapsed - p0Time) <= activeWindow) {
            return { x: pts[0].x, y: pts[0].y, rY: pts[0].rY || 0 };
        }
        return null;
    }

    const firstTime = getDrawPointLocalTime(track, timing, 0, pointCount, trackDuration);
    const lastTime = getDrawPointLocalTime(track, timing, pointCount - 1, pointCount, trackDuration);
    const minTime = Math.min(firstTime, lastTime) - activeWindow;
    const maxTime = Math.max(firstTime, lastTime) + activeWindow;
    if (localElapsed < minTime || localElapsed > maxTime) return null;

    const dur = Math.max(1e-6, timing.drawDuration);
    const approxRatio = Math.max(0, Math.min(1, (localElapsed - timing.drawOffset) / dur));
    const approxIndex = Math.max(0, Math.min(pointCount - 2, Math.round(approxRatio * (pointCount - 1))));
    const scanRadius = isSnapped ? 7 : 4;

    let bestHit = null;
    let bestDist = Infinity;
    for (let d = -scanRadius; d <= scanRadius; d++) {
        const i = approxIndex + d;
        if (i < 0 || i >= pointCount - 1) continue;

        const t1 = getDrawPointLocalTime(track, timing, i, pointCount, trackDuration);
        const t2 = getDrawPointLocalTime(track, timing, i + 1, pointCount, trackDuration);
        const minSegT = Math.min(t1, t2) - (isSnapped ? activeWindow : 0.0015);
        const maxSegT = Math.max(t1, t2) + (isSnapped ? activeWindow : 0.0015);
        const contains = localElapsed >= minSegT && localElapsed <= maxSegT;

        const dt = t2 - t1;
        let ratio = 0;
        if (Math.abs(dt) > 1e-6) {
            ratio = (localElapsed - t1) / dt;
            ratio = Math.max(0, Math.min(1, ratio));
        }
        const hit = {
            x: pts[i].x + (pts[i + 1].x - pts[i].x) * ratio,
            y: pts[i].y + (pts[i + 1].y - pts[i].y) * ratio,
            rY: (pts[i].rY || 0) + ((pts[i + 1].rY || 0) - (pts[i].rY || 0)) * ratio
        };

        if (contains) return hit;

        const dist = Math.min(Math.abs(localElapsed - t1), Math.abs(localElapsed - t2));
        if (dist < bestDist) {
            bestDist = dist;
            bestHit = hit;
        }
    }

    const fallbackWindow = isSnapped ? (activeWindow * 1.2) : 0.006;
    if (bestHit && bestDist <= fallbackWindow) return bestHit;
    return null;
}

export function redrawTrack(t, hx, brushSelectValue, chordIntervals, chordColors) {
    const fractalChaosKnob = document.querySelector('.modify-knob[data-mod="fractal-chaos"]');
    const fractalMorphKnob = document.querySelector('.modify-knob[data-mod="fractal-morph"]');
    const liveChaos = fractalChaosKnob ? parseFloat(fractalChaosKnob.dataset.val || 0) : 0;
    const liveMorph = fractalMorphKnob ? parseFloat(fractalMorphKnob.dataset.val || 0) : 0;
    const scanState = normalizeScanState(hx);
    const baseCache = getTrackBaseCacheEntry(t);
    const nowMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const particlesPresent = trackHasParticleSegments(t);
    const particleRefreshDue = !!(scanState && particlesPresent && ((nowMs - baseCache.lastParticlesRefreshMs) >= PARTICLE_CACHE_REFRESH_MS));
    const shouldRefreshBase = !scanState || !!scanState.forceBase || !baseCache.valid || particleRefreshDue;
    if (shouldRefreshBase) {
        drawTrackBaseLayer(t, chordIntervals, chordColors, liveChaos, liveMorph, baseCache.ctx);
        baseCache.valid = true;
        if (particleRefreshDue) baseCache.lastParticlesRefreshMs = nowMs;
    }
    t.ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
    t.ctx.drawImage(baseCache.canvas, 0, 0);

    if(scanState){ 
        t.ctx.save(); 
        
        const drawPingAt = (xPos, yPos) => drawStandardScanDot(t.ctx, xPos, yPos);

        const drawBrushPings = (seg, baseX, baseY, rYVal = 0) => {
            const brush = seg.brush || "standard";
            const size = seg.thickness || 5;
            if (brush === "rorschach") {
                drawPingAt(baseX, baseY);
                drawPingAt(baseX, 100 - baseY);
            } else if (brush === "chord") {
                const ivs = chordIntervals[seg.chordType || "major"] || chordIntervals["major"];
                ivs.forEach(iv => { if (iv !== 0) drawPingAt(baseX, baseY - iv * 5); });
                drawPingAt(baseX, baseY);
            } else if (brush === "overtone") {
                drawPingAt(baseX, baseY);
                for (let j = 2; j <= 5; j++) drawPingAt(baseX, baseY - Math.log2(j) * 20);
            } else if (brush === "xenakis") {
                for (let j = -2; j <= 2; j++) {
                    const wave = Math.sin(baseX * 0.04 + j * 1.5) * size * 1.5;
                    drawPingAt(baseX, baseY + wave + (j * size * 0.5));
                }
            } else if (brush === "fm") {
                const fmSpread = size * 1.2;
                drawPingAt(baseX, baseY + fmSpread);
                drawPingAt(baseX, baseY - fmSpread);
            } else if (brush === "explosion") {
                drawExplosionScanOverlay(t.ctx, { x: baseX, y: baseY, rX: 0, rY: rYVal }, size, seg.explosion, 1);
            } else if (brush === "evolve") {
                drawEvolveStructure(t.ctx, { x: baseX, y: baseY, rX: 0, rY: rYVal }, size, seg.evolve, 1, "rgba(255, 68, 68, 0.9)", 0.95, true);
            } else if (brush === "evolve2") {
                drawStandardScanDot(t.ctx, baseX, baseY);
            } else if (brush === "fractal") {
                const chaosOffset = rYVal * 100 * liveChaos;
                drawPingAt(baseX, baseY + chaosOffset);
            } else {
                drawPingAt(baseX, baseY);
            }
        };

        if (scanState.mode === "x") {
            const hxValue = scanState.hx;
            t.ctx.beginPath();
            t.ctx.strokeStyle = "rgba(255, 68, 68, 0.8)";
            t.ctx.lineWidth = 1;
            t.ctx.moveTo(hxValue, 0);
            t.ctx.lineTo(hxValue, t.canvas.height);
            t.ctx.stroke();

            t.segments.forEach(seg => {
                const pts = seg.points;
                if (!pts || pts.length === 0) return;
                const brush = seg.brush || "standard";
                const localElapsed = Number(scanState.localElapsed) || 0;
                const trackDuration = Number(scanState.trackDuration) || 0;
                if (trackDuration > 0 && (brush === "explosion" || brush === "evolve" || brush === "evolve2")) {
                    const timing = getDrawSegmentTiming(seg, trackDuration);
                    if (timing) {
                        if (brush === "explosion") {
                            drawExplosionPlaybackProgress(t.ctx, t, seg, timing, localElapsed, trackDuration);
                            return;
                        }
                        if (brush === "evolve") {
                            drawEvolvePlaybackProgress(t.ctx, t, seg, timing, localElapsed, trackDuration);
                            return;
                        }
                        if (brush === "evolve2") {
                            drawEvolve2PlaybackProgress(t.ctx, t, seg, timing, localElapsed, trackDuration);
                            return;
                        }
                    }
                }

                let minX = pts[0].x, maxX = pts[0].x;
                for (let p of pts) {
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                }
                if (hxValue < minX - 10 || hxValue > maxX + 10) return;

                if (pts.length === 1) {
                    if (Math.abs(hxValue - pts[0].x) <= 2.5) {
                        drawBrushPings(seg, hxValue, pts[0].y, pts[0].rY);
                    }
                } else {
                    for (let i = 0; i < pts.length - 1; i++) {
                        const p1 = pts[i];
                        const p2 = pts[i + 1];
                        const leftP = p1.x < p2.x ? p1 : p2;
                        const rightP = p1.x < p2.x ? p2 : p1;
                        if (hxValue >= leftP.x - 1.5 && hxValue <= rightP.x + 1.5) {
                            let ratio = 0;
                            if (rightP.x - leftP.x > 0.01) {
                                ratio = (hxValue - leftP.x) / (rightP.x - leftP.x);
                                ratio = Math.max(0, Math.min(1, ratio));
                            }
                            const intersectY = leftP.y + ratio * (rightP.y - leftP.y);
                            const interpolatedRY = (leftP.rY || 0) + ratio * ((rightP.rY || 0) - (leftP.rY || 0));
                            drawBrushPings(seg, hxValue, intersectY, interpolatedRY);
                        }
                    }
                }
            });
        } else {
            const localElapsed = Number(scanState.localElapsed) || 0;
            const trackDuration = Number(scanState.trackDuration) || 0;
            if (trackDuration > 0) {
                const localHx = (localElapsed / trackDuration) * t.canvas.width;
                t.ctx.beginPath();
                t.ctx.strokeStyle = "rgba(255, 68, 68, 0.8)";
                t.ctx.lineWidth = 1;
                t.ctx.moveTo(localHx, 0);
                t.ctx.lineTo(localHx, t.canvas.height);
                t.ctx.stroke();

                const stepDuration = trackDuration / Math.max(1, Number(t.gridSteps) || 32);
                const isSnapped = !!t.snap;
                const activeWindow = isSnapped ? Math.max(0.015, stepDuration * 0.55) : 0.01;

                t.segments.forEach(seg => {
                    const pts = seg.points;
                    const pointCount = Array.isArray(pts) ? pts.length : 0;
                    if (pointCount === 0) return;

                    const timing = getDrawSegmentTiming(seg, trackDuration);
                    if (!timing) return;
                    if ((seg.brush || "standard") === "explosion") {
                        drawExplosionPlaybackProgress(t.ctx, t, seg, timing, localElapsed, trackDuration);
                        return;
                    }
                    if ((seg.brush || "standard") === "evolve") {
                        drawEvolvePlaybackProgress(t.ctx, t, seg, timing, localElapsed, trackDuration);
                        return;
                    }
                    if ((seg.brush || "standard") === "evolve2") {
                        drawEvolve2PlaybackProgress(t.ctx, t, seg, timing, localElapsed, trackDuration);
                        return;
                    }
                    const hit = findDrawHitPoint(t, seg, timing, localElapsed, trackDuration, activeWindow, isSnapped);
                    if (hit) drawBrushPings(seg, hit.x, hit.y, hit.rY);
                });
            }
        }

        t.ctx.restore(); 
    }
}
