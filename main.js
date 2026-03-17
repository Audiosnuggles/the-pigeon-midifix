import { drawGrid, redrawTrack } from './canvas.js';
import { 
    initAudio, audioCtx, masterGain, masterLimiter, analyser, fxNodes, trackSends, trackAnalysers,
    connectTrackToFX, getDistortionCurve, mapYToFrequency, quantizeFrequency,
    updateReverbDecay
} from './audio.js';
import { setupKnob, updatePadUI, resetFXUI } from './ui.js';
import { initMidiEngine, midiSyncActive, getMidiClockState } from './midi.js';

const PATTERN_BANK_IDS = ["A", "B", "C", "D"];
const PATTERN_SLOTS_PER_BANK = 4;
let patternBanks = { A: [null, null, null, null], B: [null, null, null, null], C: [null, null, null, null], D: [null, null, null, null] };
let activePatternSlot = { bank: "A", idx: 0 };
let slotTargetPicker = null;
let isPlaying = false, playbackStartTime = 0, transportStartTime = 0, playbackDuration = 0;
let nextLoopScheduledFor = null;
let nextLoopScheduledBoundaryId = null;
let lastProcessedBoundaryId = null;
let activeMidiLoopTickSpan = 0;
let midiLoopAnchorTick = NaN;
const LOOP_SCHEDULE_AHEAD_SEC = 0.15;
let undoStack = [], redoStack = [], liveNodes = [], liveGainNode = null, activeNodes = new Set(), lastAvg = 0;
let currentTargetTrack = 0, traceCurrentY = 50, isTracing = false, isEffectMode = false, traceCurrentSeg = null, queuedPattern = null, queuedPresetBank = null;
let lastTraceTrackX = null;
let isExportingWav = false;
let playbackPathMode = "x";
const HISTORY_STACK_LIMIT = 25;
let currentLiveScene = null;
let scheduledLiveScene = null;

function clearNextLoopSchedule() {
    nextLoopScheduledFor = null;
    nextLoopScheduledBoundaryId = null;
}

function disconnectSceneNode(node) {
    if (!node) return;
    try { node.disconnect(); } catch (e) {}
}

function clearTrackSceneRefs(sceneKey) {
    tracks.forEach(track => {
        track[sceneKey] = null;
    });
}

function disconnectLiveScene(scene) {
    if (!scene || !Array.isArray(scene.trackGains)) return;
    scene.trackGains.forEach(disconnectSceneNode);
}

function assignCurrentLiveScene(scene) {
    if (currentLiveScene && currentLiveScene !== scene) {
        disconnectLiveScene(currentLiveScene);
    }
    currentLiveScene = scene || null;
    tracks.forEach((track, idx) => {
        track.gainNode = scene?.trackGains?.[idx] || null;
    });
}

function assignScheduledLiveScene(scene) {
    if (scheduledLiveScene && scheduledLiveScene !== scene) {
        disconnectLiveScene(scheduledLiveScene);
    }
    scheduledLiveScene = scene || null;
    tracks.forEach((track, idx) => {
        track.scheduledGainNode = scene?.trackGains?.[idx] || null;
    });
}

function killPreScheduledFutureTrackGraph() {
    if (scheduledLiveScene) {
        disconnectLiveScene(scheduledLiveScene);
        scheduledLiveScene = null;
        clearTrackSceneRefs("scheduledGainNode");
        return;
    }
    if (nextLoopScheduledFor === null) return;
    tracks.forEach(track => {
        if (!track?.scheduledGainNode) return;
        disconnectSceneNode(track.scheduledGainNode);
        track.scheduledGainNode = null;
    });
}

function promoteScheduledTrackGraph() {
    if (scheduledLiveScene) {
        assignCurrentLiveScene(scheduledLiveScene);
        scheduledLiveScene = null;
        clearTrackSceneRefs("scheduledGainNode");
        return;
    }
    tracks.forEach(track => {
        if (!track?.scheduledGainNode) return;
        if (track.gainNode && track.gainNode !== track.scheduledGainNode) {
            disconnectSceneNode(track.gainNode);
        }
        track.gainNode = track.scheduledGainNode;
        track.scheduledGainNode = null;
    });
}

function getActiveMidiLoopTickSpan() {
    return Math.max(24, Math.round(Number(activeMidiLoopTickSpan) || getLoopTickSpanForSteps()));
}

function updateActiveMidiLoopSpan(steps = getGlobalLengthSteps()) {
    activeMidiLoopTickSpan = getLoopTickSpanForSteps(steps);
    return activeMidiLoopTickSpan;
}

function rebaseMidiLoopPhase(boundaryTick, steps = getGlobalLengthSteps()) {
    const nextAnchorTick = Math.max(0, Math.round(Number(boundaryTick) || 0));
    midiLoopAnchorTick = nextAnchorTick;
    activeMidiLoopTickSpan = getLoopTickSpanForSteps(steps);
    return {
        anchorTick: midiLoopAnchorTick,
        loopTickSpan: activeMidiLoopTickSpan
    };
}

let activeWaveShapers = []; 
let lastParticleTime = 0; 
let liveShaper = null, liveCompGain = null;
let savePatternFeedbackTimer = null;
const presetCache = {};
const MAX_IMPORT_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const TAPE_STOP_STATE = Object.freeze({
    BYPASS: "bypass",
    STOPPING: "stopping",
    HELD: "held",
    STARTING: "starting"
});
let tapeStopState = TAPE_STOP_STATE.BYPASS;
let tapeStopHoldTimer = null;
let tapeStopReleaseTimer = null;
let tapeStopStateToken = 0;
let slotExportFormatPreference = "json";
let pendingWavExportFileName = null;
let slotExportChoiceOverlay = null;
const fallbackPresetBankSources = [
    { id: "standard_set", name: "Standard Set", url: "default_set.json" },
    { id: "floaters_a", name: "Floaters A", url: "presets/Floaters A.json" },
    { id: "factory_a", name: "Factory A", url: "presets/factory_a.json" },
    { id: "factory_b", name: "Factory B", url: "presets/factory_b.json" },
    { id: "artist_radiophonic", name: "Artist: Radiophonic", url: "presets/artist_radiophonic.json" },
    { id: "artist_oram", name: "Artist: Oram Study", url: "presets/artist_oram.json" },
    { id: "artist_live", name: "Artist: Live Tools", url: "presets/artist_live.json" }
];
let presetBankSources = fallbackPresetBankSources.slice();
const presetManifestVersion = "20260310c";
const presetBankManifestPath = `presets/index.json?v=${presetManifestVersion}`;
const FX_NAME_TO_KEY = Object.freeze({
    DELAY: "delay",
    REVERB: "reverb",
    VIBRATO: "vibrato",
    FILTER: "filter",
    STUTTER: "stutter",
    "TAPE STOP": "tapestop",
    FRACTAL: "fractal"
});
const fxDomIndex = {};

function getFxKeyFromHeaderText(text) {
    const title = String(text || "").toUpperCase();
    if (title.includes("TAPE STOP")) return "tapestop";
    if (title.includes("STUTTER")) return "stutter";
    if (title.includes("VIBRATO")) return "vibrato";
    if (title.includes("REVERB")) return "reverb";
    if (title.includes("FILTER")) return "filter";
    if (title.includes("DELAY")) return "delay";
    if (title.includes("FRACTAL")) return "fractal";
    return null;
}

function getFxKeyFromName(name) {
    const key = FX_NAME_TO_KEY[String(name || "").toUpperCase()];
    return key || getFxKeyFromHeaderText(name);
}

function buildFxDomIndex() {
    Object.keys(fxDomIndex).forEach(k => delete fxDomIndex[k]);
    document.querySelectorAll(".fx-unit").forEach(unit => {
        const header = unit.querySelector(".fx-header");
        const fxKey = getFxKeyFromHeaderText(header ? header.textContent : "");
        if (!fxKey) return;
        unit.dataset.fxKey = fxKey;
        fxDomIndex[fxKey] = {
            unit,
            header,
            knobs: Array.from(unit.querySelectorAll(".knob")),
            matrixButtons: Array.from(unit.querySelectorAll(".matrix-btn")),
            led: unit.querySelector(".led"),
            xyButtons: Array.from(unit.querySelectorAll(".fx-xy-link")),
            tapeButtons: Array.from(unit.querySelectorAll(".fx-enable-btn--tapestop"))
        };
    });
}

function ensureFxDomIndex() {
    if (Object.keys(fxDomIndex).length > 0) return;
    buildFxDomIndex();
}

function normalizePatternBanksShape(rawBanks) {
    const normalized = (rawBanks && typeof rawBanks === "object") ? rawBanks : {};
    PATTERN_BANK_IDS.forEach(bank => {
        if (!Array.isArray(normalized[bank])) normalized[bank] = [];
        while (normalized[bank].length < PATTERN_SLOTS_PER_BANK) normalized[bank].push(null);
        if (normalized[bank].length > PATTERN_SLOTS_PER_BANK) normalized[bank] = normalized[bank].slice(0, PATTERN_SLOTS_PER_BANK);
    });
    return normalized;
}

function parsePatternSlot(slotValue) {
    if (!slotValue || typeof slotValue !== "string") return null;
    const bank = slotValue[0];
    const idx = (parseInt(slotValue.slice(1), 10) || 1) - 1;
    if (!PATTERN_BANK_IDS.includes(bank)) return null;
    if (idx < 0 || idx >= PATTERN_SLOTS_PER_BANK) return null;
    return { bank, idx };
}

function resolvePatternFromImportedJson(rawData, bank, idx) {
    const isPatternLike = (value) => {
        if (!value || typeof value !== "object") return false;
        if (Array.isArray(value)) return true;
        return Array.isArray(value.tracks);
    };

    if (!rawData || typeof rawData !== "object") return null;
    if (isPatternLike(rawData.pattern)) return rawData.pattern;
    if (isPatternLike(rawData)) return rawData;
    if (isPatternLike(rawData.current)) return rawData.current;
    if (rawData.banks && typeof rawData.banks === "object") {
        const normalized = normalizePatternBanksShape(JSON.parse(JSON.stringify(rawData.banks)));
        return normalized[bank] && normalized[bank][idx] ? normalized[bank][idx] : null;
    }
    return null;
}

// Copy/Paste, Selection und Alt-Drag States
let clipboardSegments = [];
let activeTrack = null;

const workerCode = `
  let timerID = null;
  self.onmessage = function(e) {
    if (e.data === 'start') {
      if (!timerID) timerID = setInterval(() => postMessage('tick'), 16);
    } else if (e.data === 'stop') {
      clearInterval(timerID); timerID = null;
    }
  };
`;
const timerWorkerUrl = URL.createObjectURL(new Blob([workerCode], {type: 'application/javascript'}));
const timerWorker = new Worker(timerWorkerUrl);
timerWorker.onmessage = () => { if (isPlaying) loop(); };
let timerWorkerDisposed = false;

function disposeTimerWorker() {
    if (timerWorkerDisposed) return;
    timerWorkerDisposed = true;
    try { timerWorker.postMessage("stop"); } catch (_) {}
    try { timerWorker.terminate(); } catch (_) {}
    try { URL.revokeObjectURL(timerWorkerUrl); } catch (_) {}
}

window.addEventListener("beforeunload", disposeTimerWorker, { once: true });

const chordIntervals = { major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], dim: [0, 3, 6], augmented: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7] };
const chordColors = ['#FF5733', '#33FF57', '#3357FF'];
const DEFAULT_CALLIGRAPHY_MOD = Object.freeze({ angleNorm: 0.25, contrastNorm: 0.5 });
const DEFAULT_EXPLOSION_MOD = Object.freeze({ lengthNorm: 0.55, burstNorm: 0.45 });
const DEFAULT_EVOLVE_MOD = Object.freeze({ lengthNorm: 0.55, branchNorm: 0.45 });
const CALLIGRAPHY_SKEW_MAX_SEC = 0.016;
const CALLIGRAPHY_CROSSOVER_HZ = 1900;
const TAPE_STOP_CURVE_EXP = 4.0;
const TAPE_STOP_RELEASE_EXP = 2.8;
const TAPE_STOP_MIN_STOP_SEC = 0.03;
const TAPE_STOP_MAX_STOP_SEC = 3.0;
const TAPE_STOP_MIN_START_SEC = 0.04;
const TAPE_STOP_MAX_START_SEC = 1.8;
const noiseBufferCache = new WeakMap();

function getOrCreateNoiseBuffer(ctx) {
    if (noiseBufferCache.has(ctx)) return noiseBufferCache.get(ctx);
    const length = Math.max(1, Math.floor(ctx.sampleRate * 2));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2) - 1;
    noiseBufferCache.set(ctx, buffer);
    return buffer;
}

function createWaveSource(ctx, wave, startFreq, noiseQ = 6) {
    if (wave === "noise") {
        const source = ctx.createBufferSource();
        source.buffer = getOrCreateNoiseBuffer(ctx);
        source.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.Q.value = Math.max(1, Math.min(18, noiseQ));
        const safeFreq = Math.max(30, Math.min(12000, startFreq || 440));
        filter.frequency.setValueAtTime(safeFreq, ctx.currentTime);
        source.connect(filter);
        return {
            source,
            output: filter,
            isNoise: true,
            frequencyParam: filter.frequency,
            setValueAtTime: (freq, time) => filter.frequency.setValueAtTime(Math.max(30, Math.min(12000, freq)), time),
            setTargetAtTime: (freq, time, tc = 0.02) => filter.frequency.setTargetAtTime(Math.max(30, Math.min(12000, freq)), time, tc),
            linearRampToValueAtTime: (freq, time) => filter.frequency.linearRampToValueAtTime(Math.max(30, Math.min(12000, freq)), time),
            cancelScheduledValues: (time) => filter.frequency.cancelScheduledValues(time),
            disconnect: () => { try { source.disconnect(); } catch(e) {} try { filter.disconnect(); } catch(e) {} }
        };
    }

    const source = ctx.createOscillator();
    source.type = wave;
    const safeFreq = Math.max(20, startFreq || 440);
    source.frequency.setValueAtTime(safeFreq, ctx.currentTime);
    return {
        source,
        output: source,
        isNoise: false,
        frequencyParam: source.frequency,
        setValueAtTime: (freq, time) => source.frequency.setValueAtTime(Math.max(20, freq), time),
        setTargetAtTime: (freq, time, tc = 0.02) => source.frequency.setTargetAtTime(Math.max(20, freq), time, tc),
        linearRampToValueAtTime: (freq, time) => source.frequency.linearRampToValueAtTime(Math.max(20, freq), time),
        cancelScheduledValues: (time) => source.frequency.cancelScheduledValues(time),
        disconnect: () => { try { source.disconnect(); } catch(e) {} }
    };
}

function createParticleNoiseSource(ctx) {
    const source = ctx.createBufferSource();
    source.buffer = getOrCreateNoiseBuffer(ctx);
    source.loop = true;
    return {
        source,
        output: source,
        isNoise: true,
        frequencyParam: null,
        setValueAtTime: () => {},
        setTargetAtTime: () => {},
        linearRampToValueAtTime: () => {},
        cancelScheduledValues: () => {},
        disconnect: () => { try { source.disconnect(); } catch(e) {} }
    };
}

const toolSelect = document.getElementById("toolSelect"),
      brushSelect = document.getElementById("brushSelect"),
      sizeSlider = document.getElementById("brushSizeSlider"),
      chordSelect = document.getElementById("chordSelect"),
      harmonizeCheckbox = document.getElementById("harmonizeCheckbox"),
      scaleSelect = document.getElementById("scaleSelect"),
      pigeonImg = document.getElementById("pigeon"),
      tracePad = document.getElementById("trace-pad"),
      customEraser = document.getElementById("custom-eraser");
const quoteCodeLine = document.getElementById("quoteCodeLine");
const toolButtons = Array.from(document.querySelectorAll(".tool-btn"));
let quoteHoverAudio = null;

const tracks = Array.from(document.querySelectorAll(".track-container")).map((c, i) => ({
    index: i, canvas: c.querySelector("canvas"), ctx: c.querySelector("canvas").getContext("2d"),
    segments: [], wave: "sine", mute: false, solo: false, bp: false, vol: 0.8, snap: false, noiseQ: 6, lengthSteps: 32, gridSteps: 32, gainNode: null, scheduledGainNode: null, masterGainNode: null, curSeg: null, particleBus: null,
    selectedSegments: [], selectionBox: null 
}));

document.addEventListener("DOMContentLoaded", () => {
    activeTrack = tracks[0];
    tracks.forEach(t => {
        drawGrid(t);
        setupTrackControls(t);
        setupDrawing(t);
        updateNoiseButtonLabel(t, t.canvas.closest('.track-container'));
    });
    setupPresetControls();
    warnIfFileProtocol();
    loadInitialData();
    setupFX();
    setupMainControls();
    setupPads();
    setupTracePad();
    resetFXUI(updateRoutingFromUI);
    setTapeStopState(TAPE_STOP_STATE.BYPASS, false);
    initGlobalTooltips();
    ensurePathModeSwitchVisible();
    setupQuoteHoverSound();
    const initialTool = toolSelect ? toolSelect.value : "draw";
    updateToolButtons(initialTool);
    document.body.classList.toggle("eraser-mode", initialTool === "erase");
    document.body.classList.toggle("select-mode", initialTool === "select");
});

function setTitle(el, text, force = false) {
    if (!el) return;
    const cleaned = String(text || "").replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    if (!force && el.title && el.title.trim()) return;
    el.title = cleaned;
}

function bindValueTooltip(el, formatter) {
    if (!el || typeof formatter !== "function") return;
    const update = () => setTitle(el, formatter(el.value), true);
    update();
    el.addEventListener("input", update);
    el.addEventListener("change", update);
}

function setPlaybackPathMode(mode) {
    const next = mode === "draw" ? "draw" : "x";
    playbackPathMode = next;
    document.querySelectorAll(".path-mode-btn").forEach(btn => {
        const isActive = btn.dataset.pathMode === next;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
}

function isDrawOrderPlaybackModeFor(mode) {
    return mode === "draw";
}

function isDrawOrderPlaybackMode() {
    return isDrawOrderPlaybackModeFor(playbackPathMode);
}

function ensurePathModeSwitchVisible() {
    const toolsHead = document.querySelector(".tools-head");
    if (!toolsHead) return;
    let switchEl = document.getElementById("playbackPathSwitch");
    if (!switchEl) {
        switchEl = document.createElement("div");
        switchEl.className = "path-switch";
        switchEl.id = "playbackPathSwitch";
        switchEl.setAttribute("role", "group");
        switchEl.setAttribute("aria-label", "Playback path mode");
        switchEl.innerHTML = `
          <button type="button" id="pathModeX" class="path-mode-btn" data-path-mode="x" aria-pressed="false" title="Playback path: X-order (classic time-left-to-right)">X</button>
          <button type="button" id="pathModeD" class="path-mode-btn" data-path-mode="draw" aria-pressed="false" title="Playback path: draw-order (follows your stroke direction)">D</button>
        `;
        toolsHead.appendChild(switchEl);
        setupPathModeSwitch();
    }
    switchEl.hidden = false;
    switchEl.style.display = "inline-flex";
    switchEl.style.visibility = "visible";
    switchEl.style.opacity = "1";
    setPlaybackPathMode(playbackPathMode);
}

function setQuoteHoverSoundSource(src) {
    const soundPath = String(src || "").trim();
    if (!soundPath) {
        stopQuoteHoverSound();
        quoteHoverAudio = null;
        if (quoteCodeLine) quoteCodeLine.dataset.hoverSound = "";
        return false;
    }
    if (quoteCodeLine) quoteCodeLine.dataset.hoverSound = soundPath;
    const audio = new Audio(soundPath);
    audio.preload = "auto";
    audio.loop = true;
    quoteHoverAudio = audio;
    return true;
}

function startQuoteHoverSound() {
    if (!quoteHoverAudio) return;
    try {
        quoteHoverAudio.currentTime = 0;
        const playResult = quoteHoverAudio.play();
        if (playResult && typeof playResult.catch === "function") playResult.catch(() => {});
    } catch (_) {}
}

function stopQuoteHoverSound() {
    if (!quoteHoverAudio) return;
    try {
        quoteHoverAudio.pause();
        quoteHoverAudio.currentTime = 0;
    } catch (_) {}
}

function setupQuoteHoverSound() {
    if (!quoteCodeLine) return;
    const initialSound = quoteCodeLine.dataset.hoverSound;
    if (initialSound) setQuoteHoverSoundSource(initialSound);
    quoteCodeLine.addEventListener("pointerenter", startQuoteHoverSound);
    quoteCodeLine.addEventListener("pointerleave", stopQuoteHoverSound);
    quoteCodeLine.addEventListener("pointercancel", stopQuoteHoverSound);
    quoteCodeLine.addEventListener("blur", stopQuoteHoverSound);
    window.setQuoteHoverSound = setQuoteHoverSoundSource;
}

function initGlobalTooltips() {
    const idTips = {
        playButton: "Play",
        stopButton: "Stop",
        undoButton: "Undo (Cmd/Ctrl+Z)",
        redoButton: "Redo (Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y)",
        clearButton: "Clear all tracks",
        recButton: "Live record master output",
        extSyncBtn: "External sync on/off",
        midiInputSelect: "MIDI input source for external sync",
        scaleSelect: "Scale used for harmonize",
        brushSelect: "Brush mode",
        chordSelect: "Chord mode",
        importPresetBankButton: "Import complete bank from file",
        loadPresetBankButton: "Load selected bank from list",
        exportBankButton: "Export complete bank to file",
        exportWavButton: "Export loop as WAV",
        loadPresetPatternButton: "Choose a target slot, then import one slot from file",
        exportPatternButton: "Export active slot",
        savePatternButton: "Choose a target slot, then save current state",
        presetBankSelect: "Choose preset bank",
        traceClearBtn: "Clear poke pad"
    };
    Object.entries(idTips).forEach(([id, text]) => setTitle(document.getElementById(id), text));

    const waveTips = {
        sine: "Sine oscillator",
        square: "Square oscillator",
        sawtooth: "Sawtooth oscillator",
        noise: "Noise source (click active button to cycle bandwidth)"
    };
    document.querySelectorAll(".wave-btn").forEach(btn => {
        const wave = btn.dataset.wave || "";
        if (waveTips[wave]) setTitle(btn, waveTips[wave]);
    });

    document.querySelectorAll(".tool-btn").forEach(btn => {
        const name = btn.dataset.tool || "tool";
        setTitle(btn, name.charAt(0).toUpperCase() + name.slice(1));
    });
    setTitle(document.getElementById("pathModeX"), "Playback path: X-order (classic time-left-to-right)", true);
    setTitle(document.getElementById("pathModeD"), "Playback path: draw-order (follows your stroke direction)", true);
    setTitle(document.getElementById("toolHelpQuickBtn"), "Help", true);
    setTitle(document.querySelector('.modify-knob[data-mod="calligraphy-angle"]'), "Calligraphy angle");
    setTitle(document.querySelector('.modify-knob[data-mod="calligraphy-contrast"]'), "Calligraphy contrast");
    setTitle(document.querySelector('.modify-knob[data-mod="fractal-chaos"]'), "Fractal chaos");
    setTitle(document.querySelector('.modify-knob[data-mod="fractal-morph"]'), "Fractal morph");

    document.querySelectorAll(".picker-btn").forEach(btn => {
        const label = (btn.textContent || "").trim();
        if (label) setTitle(btn, `Target track ${label}`);
    });

    document.querySelectorAll(".pad.pattern-btn").forEach(btn => {
        const bank = btn.dataset.bank || "?";
        const idx = Number.parseInt(btn.dataset.idx || "0", 10);
        if (Number.isFinite(idx)) setTitle(btn, `Memory slot ${bank}${idx + 1}`);
    });

    document.querySelectorAll(".fx-unit").forEach(unit => {
        const fxName = ((unit.querySelector(".fx-header")?.textContent) || "FX").trim();
        unit.querySelectorAll(".matrix-btn").forEach((btn, idx) => {
            setTitle(btn, `${fxName}: route track ${idx + 1}`);
        });
        unit.querySelectorAll(".knob").forEach(knob => {
            const param = (knob.nextElementSibling?.textContent || "Parameter").trim();
            setTitle(knob, `${fxName}: ${param}`);
        });
        unit.querySelectorAll(".fx-xy-link").forEach(btn => setTitle(btn, `${fxName}: X/Y link`));
        unit.querySelectorAll(".fx-enable-btn--tapestop").forEach(btn => setTitle(btn, `${fxName}: hold to tape stop`));
    });

    document.querySelectorAll(".btn--solo").forEach(btn => setTitle(btn, "Solo track"));
    document.querySelectorAll(".btn--mute").forEach(btn => setTitle(btn, "Mute track"));
    document.querySelectorAll(".track__bp-extra").forEach(btn => setTitle(btn, "FX Bypass"));
    document.querySelectorAll(".toggle-wrap").forEach(label => {
        const text = (label.querySelector("span")?.textContent || "").trim();
        if (text) setTitle(label, text);
    });

    bindValueTooltip(document.getElementById("bpmInput"), v => `Tempo: ${v} BPM`);
    bindValueTooltip(document.getElementById("brushSizeSlider"), v => `Brush size: ${v}`);
    document.querySelectorAll(".volume-slider").forEach((slider, idx) => {
        bindValueTooltip(slider, v => `Track ${idx + 1} volume: ${Math.round((Number(v) || 0) * 100)}%`);
    });

    document.querySelectorAll("button, select, input[type=\"range\"], input[type=\"number\"]").forEach(el => {
        if (el.type === "hidden") return;
        if (el.title && el.title.trim()) return;
        const aria = (el.getAttribute("aria-label") || "").trim();
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        const fallback = aria || text || el.id || el.className || "";
        setTitle(el, fallback);
    });
}

function warnIfFileProtocol() {
    if (window.location.protocol !== "file:") return;
    const msg = "The Pigeon needs a local web server (not file://). Start one with: npm run dev";
    console.warn(msg);
    setTimeout(() => alert(msg), 300);
}

function getTrackGridStepSize(track) {
    return 750 / (track.gridSteps || 32);
}

function getCurrentBpm() {
    const bpmInput = document.getElementById("bpmInput");
    const raw = bpmInput ? parseFloat(bpmInput.value) : NaN;
    return Number.isFinite(raw) && raw > 0 ? raw : 120;
}

function getGlobalLengthStepsForTracks(trackList) {
    if (!Array.isArray(trackList) || trackList.length === 0) return 32;
    return Math.max(1, ...trackList.map(t => Math.max(1, Number(t && t.lengthSteps) || 32)));
}

function getGlobalLengthSteps() {
    return getGlobalLengthStepsForTracks(tracks);
}

function updatePlaybackDuration(optionalBpm) {
    const parsed = Number(optionalBpm);
    const bpm = Number.isFinite(parsed) && parsed > 0 ? parsed : getCurrentBpm();
    playbackDuration = (60 / bpm) * getGlobalLengthSteps();
    return playbackDuration;
}

function getPlaybackDurationForTracks(trackList, optionalBpm) {
    const parsed = Number(optionalBpm);
    const bpm = Number.isFinite(parsed) && parsed > 0 ? parsed : getCurrentBpm();
    return (60 / bpm) * getGlobalLengthStepsForTracks(trackList);
}

function getTrackDuration(track, baseLoopDuration = playbackDuration, globalSteps = getGlobalLengthSteps()) {
    const trackSteps = Math.max(1, Number(track && track.lengthSteps) || 32);
    const resolvedLoopDuration = (isFinite(baseLoopDuration) && baseLoopDuration > 0)
        ? baseLoopDuration
        : ((60 / getCurrentBpm()) * globalSteps);
    const stepDuration = resolvedLoopDuration / Math.max(1, globalSteps);
    return stepDuration * trackSteps;
}

function getTransportElapsedTime(now = audioCtx?.currentTime ?? 0) {
    if (!Number.isFinite(now)) return 0;
    const anchor = Number.isFinite(transportStartTime) ? transportStartTime : playbackStartTime;
    return now - anchor;
}

function getTrackHeadX(track, elapsed) {
    const d = getTrackDuration(track);
    if (!isFinite(d) || d <= 0) return 0;
    const localElapsed = ((elapsed % d) + d) % d;
    return (localElapsed / d) * 750;
}

function quantizeTrackTimeToGrid(track, cycleStart, absoluteTime) {
    if (!track || !track.snap) return absoluteTime;
    const trackDuration = getTrackDuration(track);
    if (!isFinite(trackDuration) || trackDuration <= 0) return absoluteTime;
    const gridSteps = Math.max(1, Number(track.gridSteps) || 32);
    const stepDuration = trackDuration / gridSteps;
    if (!isFinite(stepDuration) || stepDuration <= 0) return absoluteTime;

    const localTime = absoluteTime - cycleStart;
    const clampedLocal = Math.max(0, Math.min(trackDuration, localTime));
    const snappedLocal = Math.round(clampedLocal / stepDuration) * stepDuration;
    const safeLocal = Math.max(0, Math.min(trackDuration, snappedLocal));
    return cycleStart + safeLocal;
}

function getDrawPlaybackWindowFromPoints(points, trackDuration) {
    const pts = Array.isArray(points) ? points : [];
    if (!pts.length || !isFinite(trackDuration) || trackDuration <= 0) {
        return { drawOffset: 0, drawDuration: Math.max(0.02, trackDuration || 0.02) };
    }
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

function getPlaybackSettingsForSnapshot(snapshot) {
    const currentSettings = createCurrentPatternSnapshot().settings;
    const nextSettings = (snapshot && snapshot.settings && typeof snapshot.settings === "object")
        ? snapshot.settings
        : null;
    const masterBpm = getCurrentBpm();
    const requestedBpm = Number(nextSettings?.bpm);
    return {
        bpm: midiSyncActive
            ? masterBpm
            : (Number.isFinite(requestedBpm) ? requestedBpm : (Number(currentSettings?.bpm) || masterBpm)),
        loop: typeof nextSettings?.loop === "boolean" ? nextSettings.loop : !!currentSettings.loop,
        scale: String(nextSettings?.scale || currentSettings.scale || "major").toLowerCase(),
        harmonize: typeof nextSettings?.harmonize === "boolean" ? nextSettings.harmonize : !!currentSettings.harmonize,
        pathMode: nextSettings?.pathMode === "draw" ? "draw" : "x"
    };
}

function buildPlaybackSnapshot(patternData) {
    const currentSnapshot = createCurrentPatternSnapshot();
    const source = (patternData && typeof patternData === "object") ? patternData : currentSnapshot;
    const sourceTracks = Array.isArray(source.tracks) ? source.tracks : (Array.isArray(source) ? source : []);
    const settings = getPlaybackSettingsForSnapshot(source);
    const fractalFx = source.fx && source.fx.fractal && typeof source.fx.fractal === "object"
        ? source.fx.fractal
        : currentSnapshot.fx.fractal;
    const playbackTracks = tracks.map((liveTrack, idx) => {
        const snapTrack = sourceTracks[idx] || {};
        return {
            index: idx,
            segments: JSON.parse(JSON.stringify(Array.isArray(snapTrack.segments) ? snapTrack.segments : liveTrack.segments || [])),
            vol: Number.isFinite(Number(snapTrack.vol)) ? Number(snapTrack.vol) : liveTrack.vol,
            mute: typeof snapTrack.mute === "boolean" ? snapTrack.mute : !!liveTrack.mute,
            solo: typeof snapTrack.solo === "boolean" ? snapTrack.solo : !!liveTrack.solo,
            bp: typeof snapTrack.bp === "boolean" ? snapTrack.bp : !!liveTrack.bp,
            wave: snapTrack.wave || liveTrack.wave,
            snap: typeof snapTrack.snap === "boolean" ? snapTrack.snap : !!liveTrack.snap,
            noiseQ: Number(snapTrack.noiseQ) || liveTrack.noiseQ,
            lengthSteps: Number(snapTrack.lengthSteps) || liveTrack.lengthSteps || 32,
            gridSteps: Number(snapTrack.gridSteps) || liveTrack.gridSteps || 32
        };
    });

    return {
        settings,
        fx: {
            fractal: {
                chaos: Number(fractalFx?.chaos) || 0,
                morph: Number(fractalFx?.morph) || 0
            }
        },
        tracks: playbackTracks,
        playbackDuration: getPlaybackDurationForTracks(playbackTracks, settings.bpm),
        globalSteps: getGlobalLengthStepsForTracks(playbackTracks)
    };
}

function resolveCurrentPatternFromBankPayload(data) {
    if (!data || typeof data !== "object") return null;
    if (data.current && typeof data.current === "object") return data.current;
    if (data.banks && typeof data.banks === "object") {
        const normalized = normalizePatternBanksShape(JSON.parse(JSON.stringify(data.banks)));
        for (const bank of PATTERN_BANK_IDS) {
            for (let i = 0; i < PATTERN_SLOTS_PER_BANK; i++) {
                if (normalized[bank] && normalized[bank][i]) return normalized[bank][i];
            }
        }
    }
    return null;
}

function getQueuedPlaybackSnapshot() {
    if (queuedPresetBank) {
        const bankPattern = resolveCurrentPatternFromBankPayload(queuedPresetBank);
        return bankPattern ? buildPlaybackSnapshot(bankPattern) : null;
    }
    if (queuedPattern && queuedPattern.data) return buildPlaybackSnapshot(queuedPattern.data);
    return null;
}

function getActivePlaybackSnapshot() {
    return buildPlaybackSnapshot(createCurrentPatternSnapshot());
}

function midiTimestampMsToAudioTime(timeStampMs) {
    if (!audioCtx || !Number.isFinite(timeStampMs) || typeof performance === "undefined") return null;
    return audioCtx.currentTime + ((timeStampMs - performance.now()) / 1000);
}

function getLoopTickSpanForSteps(steps = getGlobalLengthSteps()) {
    return Math.max(24, Math.round(Math.max(1, Number(steps) || 32) * 24));
}

function getNextExternalBoundaryInfo() {
    if (!audioCtx || !midiSyncActive) return null;
    const midiState = getMidiClockState();
    if (!midiState.running || !Number.isFinite(midiState.lastTickTimeMs) || !Number.isFinite(midiState.smoothedTickMs) || midiState.smoothedTickMs <= 0) {
        return null;
    }
    const lastTickAudioTime = midiTimestampMsToAudioTime(midiState.lastTickTimeMs);
    if (!Number.isFinite(lastTickAudioTime)) return null;
    const loopTickSpan = getActiveMidiLoopTickSpan();
    const absoluteTickCount = Math.max(0, Number(midiState.absoluteTickCount) || 0);
    const anchor = Math.max(0, Math.round(Number(midiLoopAnchorTick) || 0));
    const ticksSinceAnchor = absoluteTickCount - anchor;
    const remainder = ((ticksSinceAnchor % loopTickSpan) + loopTickSpan) % loopTickSpan;
    const ticksUntilBoundary = remainder === 0 ? loopTickSpan : (loopTickSpan - remainder);
    const boundaryTick = absoluteTickCount + ticksUntilBoundary;
    return {
        time: lastTickAudioTime + ((ticksUntilBoundary * midiState.smoothedTickMs) / 1000),
        boundaryTick,
        loopTickSpan,
        id: `midi:${loopTickSpan}:${boundaryTick}`
    };
}

function getUpcomingLoopBoundaryInfo() {
    if (!isPlaying || !audioCtx || !isFinite(playbackDuration) || playbackDuration <= 0) return null;
    if (midiSyncActive) {
        const extBoundary = getNextExternalBoundaryInfo();
        if (Number.isFinite(extBoundary?.time)) return extBoundary;
    }
    const localBoundaryTime = playbackStartTime + playbackDuration;
    return Number.isFinite(localBoundaryTime) ? {
        time: localBoundaryTime,
        id: `local:${localBoundaryTime.toFixed(6)}`
    } : null;
}

function getUpcomingLoopBoundaryTime() {
    return getUpcomingLoopBoundaryInfo()?.time ?? null;
}

function getBoundaryProcessKey(boundaryInfo, boundaryId = null) {
    const rawId = String(boundaryId || boundaryInfo?.id || "");
    if (rawId.startsWith("midi:")) {
        const parts = rawId.split(":");
        const tick = Number(parts[parts.length - 1]);
        if (Number.isFinite(tick)) return `midi-tick:${Math.round(tick)}`;
    }
    if (Number.isFinite(boundaryInfo?.boundaryTick)) {
        return `midi-tick:${Math.round(boundaryInfo.boundaryTick)}`;
    }
    return rawId || null;
}

function scheduleUpcomingLoopIfNeeded(force = false) {
    if (!isPlaying || !audioCtx || !isFinite(playbackDuration) || playbackDuration <= 0) return;
    if (isTracing && !isEffectMode) return;
    const boundaryInfo = getUpcomingLoopBoundaryInfo();
    const nextStart = boundaryInfo?.time;
    if (!Number.isFinite(nextStart) || !boundaryInfo?.id) return;
    const boundaryProcessKey = getBoundaryProcessKey(boundaryInfo, boundaryInfo.id);
    if (boundaryProcessKey && boundaryProcessKey === lastProcessedBoundaryId) return;
    const alreadyScheduled = nextLoopScheduledFor !== null && nextLoopScheduledBoundaryId === boundaryInfo.id;
    if (alreadyScheduled) return;
    const timeUntilNext = nextStart - audioCtx.currentTime;
    if (force || timeUntilNext <= LOOP_SCHEDULE_AHEAD_SEC) {
        const safeStart = Math.max(nextStart, audioCtx.currentTime + 0.003);
        const queuedSnapshot = getQueuedPlaybackSnapshot();
        const phaseAnchorTime = queuedSnapshot ? nextStart : transportStartTime;
        scheduleTracks(safeStart, audioCtx, masterGain, null, queuedSnapshot || getActivePlaybackSnapshot(), phaseAnchorTime, "scheduled", boundaryInfo.id);
        nextLoopScheduledFor = nextStart;
        nextLoopScheduledBoundaryId = boundaryInfo.id;
    }
}

function finalizeTraceSegmentIfNeeded() {
    if (!traceCurrentSeg || isEffectMode) return;
    const pts = Array.isArray(traceCurrentSeg.points) ? traceCurrentSeg.points : null;
    if (!pts || pts.length !== 1) return;
    const p = pts[0];
    const nextX = Math.min(750, (Number(p.x) || 0) + 0.5);
    pts.push({ x: nextX, y: p.y, rX: p.rX, rY: p.rY });
}

function clamp01(v, fallback = 0) {
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
}

function readModifierKnob(modName, fallback = 0) {
    const knob = document.querySelector(`.modify-knob[data-mod="${modName}"]`);
    if (!knob) return fallback;
    return clamp01(parseFloat(knob.dataset.val), fallback);
}

function getCurrentCalligraphyModifier() {
    return {
        angleNorm: readModifierKnob("calligraphy-angle", DEFAULT_CALLIGRAPHY_MOD.angleNorm),
        contrastNorm: readModifierKnob("calligraphy-contrast", DEFAULT_CALLIGRAPHY_MOD.contrastNorm)
    };
}

function getCurrentExplosionModifier() {
    return {
        lengthNorm: readModifierKnob("explosion-length", DEFAULT_EXPLOSION_MOD.lengthNorm),
        burstNorm: readModifierKnob("explosion-burst", DEFAULT_EXPLOSION_MOD.burstNorm)
    };
}

function getCurrentEvolveModifier() {
    const branchFallback = readModifierKnob("evolve-time", DEFAULT_EVOLVE_MOD.branchNorm);
    return {
        lengthNorm: readModifierKnob("evolve-length", DEFAULT_EVOLVE_MOD.lengthNorm),
        branchNorm: readModifierKnob("evolve-branch", branchFallback)
    };
}

function getExplosionAudioProfile(explosionMod) {
    const lengthNorm = clamp01(explosionMod?.lengthNorm, DEFAULT_EXPLOSION_MOD.lengthNorm);
    const burstNorm = clamp01(explosionMod?.burstNorm, DEFAULT_EXPLOSION_MOD.burstNorm);
    const voiceCount = 3 + Math.round(burstNorm * 4); // 3..7 voices
    const centerIndex = (voiceCount - 1) / 2;
    const spreadSemitones = 0.8 + (lengthNorm * 14.0);
    const flutterSemitones = 0.03 + (burstNorm * 0.3);
    const detunes = Array.from({ length: voiceCount }, (_, i) => {
        const offset = i - centerIndex;
        if (Math.abs(offset) < 0.0001) return 0;
        const norm = centerIndex > 0 ? (offset / centerIndex) : 0;
        const edgeSpread = Math.sign(norm) * Math.pow(Math.abs(norm), 1.08) * spreadSemitones;
        const microJitter = Math.sin((i + 1) * 1.73 + (lengthNorm * Math.PI)) * flutterSemitones * Math.abs(norm);
        return edgeSpread + microJitter;
    });
    return {
        lengthNorm,
        burstNorm,
        detunes,
        flutterSemitones,
        sweepSec: 0.016 + (lengthNorm * 0.075) + (burstNorm * 0.01),
        gainScale: 0.82 / Math.sqrt(voiceCount)
    };
}

function getEvolveAudioProfile(evolveMod) {
    const lengthNorm = clamp01(evolveMod?.lengthNorm, DEFAULT_EVOLVE_MOD.lengthNorm);
    const branchNorm = clamp01(
        Number.isFinite(evolveMod?.branchNorm) ? evolveMod.branchNorm : evolveMod?.timeNorm,
        DEFAULT_EVOLVE_MOD.branchNorm
    );
    const voiceCount = 4 + Math.round((lengthNorm * 2) + (branchNorm * 3)); // 4..9 voices
    const centerIndex = (voiceCount - 1) / 2;
    const spreadSemitones = 1.5 + (lengthNorm * 28.0);
    const growthSec = 0.08 + (branchNorm * 0.42);
    const branchSweepSec = 0.05 + (lengthNorm * 0.14) + (branchNorm * 0.03);
    const branchDelays = Array.from({ length: voiceCount }, (_, i) => {
        if (voiceCount <= 1) return 0;
        const ratio = i / (voiceCount - 1);
        return Math.pow(ratio, 1.15) * growthSec;
    });
    const detunes = Array.from({ length: voiceCount }, (_, i) => {
        const offset = i - centerIndex;
        if (Math.abs(offset) < 0.0001) return 0;
        const norm = centerIndex > 0 ? (offset / centerIndex) : 0;
        return Math.sign(norm) * Math.pow(Math.abs(norm), 1.05) * spreadSemitones;
    });
    return {
        lengthNorm,
        branchNorm,
        detunes,
        branchDelays,
        branchSweepSec,
        gainScale: 0.78 / Math.sqrt(voiceCount)
    };
}

function getCalligraphyAudioModifier(calligraphyMod) {
    const angleNorm = clamp01(calligraphyMod?.angleNorm, DEFAULT_CALLIGRAPHY_MOD.angleNorm);
    const contrastNorm = clamp01(calligraphyMod?.contrastNorm, DEFAULT_CALLIGRAPHY_MOD.contrastNorm);
    const angleRad = ((angleNorm * 180) - 90) * (Math.PI / 180);
    const defaultAngleRad = ((DEFAULT_CALLIGRAPHY_MOD.angleNorm * 180) - 90) * (Math.PI / 180);
    const flatness = 1 - Math.abs(Math.sin(angleRad)); // 0=vertical, 1=horizontal
    const defaultFlatness = 1 - Math.abs(Math.sin(defaultAngleRad));
    const skewNorm = Math.max(0, (flatness - defaultFlatness) / Math.max(0.0001, 1 - defaultFlatness));
    return {
        skewSec: skewNorm * CALLIGRAPHY_SKEW_MAX_SEC,
        skewDirection: angleNorm >= DEFAULT_CALLIGRAPHY_MOD.angleNorm ? 1 : -1,
        gainScale: 1 + ((contrastNorm - DEFAULT_CALLIGRAPHY_MOD.contrastNorm) * 0.8)
    };
}

function connectCalligraphySkew(ctx, sourceNode, destinationNode, calligraphyAudioMod) {
    if (!calligraphyAudioMod || !destinationNode) {
        sourceNode.connect(destinationNode);
        return () => {};
    }

    const skewSec = Math.max(0, calligraphyAudioMod.skewSec || 0);
    if (skewSec < 0.00005) {
        sourceNode.connect(destinationNode);
        return () => {};
    }

    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = CALLIGRAPHY_CROSSOVER_HZ;
    low.Q.value = 0.707;

    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = CALLIGRAPHY_CROSSOVER_HZ;
    high.Q.value = 0.707;

    const lowGain = ctx.createGain();
    const highGain = ctx.createGain();
    lowGain.gain.value = 0.78;
    highGain.gain.value = 0.78;

    const delay = ctx.createDelay(0.03);
    delay.delayTime.value = Math.min(0.03, skewSec);

    sourceNode.connect(low);
    sourceNode.connect(high);
    if (calligraphyAudioMod.skewDirection >= 0) {
        // Higher partials appear earlier: delay low band.
        low.connect(delay);
        delay.connect(lowGain);
        high.connect(highGain);
    } else {
        // Lower partials appear earlier: delay high band.
        high.connect(delay);
        delay.connect(highGain);
        low.connect(lowGain);
    }
    lowGain.connect(destinationNode);
    highGain.connect(destinationNode);

    return () => {
        try { sourceNode.disconnect(low); } catch (e) {}
        try { sourceNode.disconnect(high); } catch (e) {}
        try { low.disconnect(); } catch (e) {}
        try { high.disconnect(); } catch (e) {}
        try { delay.disconnect(); } catch (e) {}
        try { lowGain.disconnect(); } catch (e) {}
        try { highGain.disconnect(); } catch (e) {}
    };
}

function applyCalligraphyModifierToSegments(modifier = getCurrentCalligraphyModifier()) {
    tracks.forEach(track => {
        track.segments.forEach(seg => {
            if ((seg.brush || "standard") === "calligraphy") {
                seg.calligraphy = { angleNorm: modifier.angleNorm, contrastNorm: modifier.contrastNorm };
            }
        });
    });
}

function applyExplosionModifierToSegments(modifier = getCurrentExplosionModifier()) {
    tracks.forEach(track => {
        track.segments.forEach(seg => {
            if ((seg.brush || "standard") === "explosion") {
                seg.explosion = { lengthNorm: modifier.lengthNorm, burstNorm: modifier.burstNorm };
            }
        });
    });
}

function applyEvolveModifierToSegments(modifier = getCurrentEvolveModifier()) {
    tracks.forEach(track => {
        track.segments.forEach(seg => {
            if ((seg.brush || "standard") === "evolve" || (seg.brush || "standard") === "evolve2") {
                seg.evolve = { lengthNorm: modifier.lengthNorm, branchNorm: modifier.branchNorm };
            }
        });
    });
}

function setKnobVisual(knob, value) {
    if (!knob) return;
    const v = clamp01(value, 0);
    knob.dataset.val = v;
    knob.style.transform = `rotate(${-135 + (v * 270)}deg)`;
}

function applyFractalMorphRealtime(val) {
    const newCurve = getDistortionCurve(80 + (val * 400));
    const compVal = 1.0 - (val * 0.5);
    activeWaveShapers.forEach(sh => {
        sh.curve = newCurve;
        if (sh.compGain) sh.compGain.gain.setTargetAtTime(compVal, audioCtx.currentTime, 0.05);
    });
    if (liveShaper) {
        liveShaper.curve = newCurve;
        if (liveCompGain) liveCompGain.gain.setTargetAtTime(compVal, audioCtx.currentTime, 0.05);
    }
}

function applyFractalChaosRealtime(val) {
    activeNodes.forEach(osc => { if (osc.updateChaos) osc.updateChaos(val); });
}

function getTapeStopStopNorm() {
    return getKnobVal("TAPE STOP", "STOP");
}

function getTapeStopStartNorm() {
    return getKnobVal("TAPE STOP", "START");
}

function buildPowerCurve(pointCount, exponent, from = 0, to = 1) {
    const n = Math.max(8, pointCount | 0);
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const t = n === 1 ? 1 : i / (n - 1);
        const shaped = Math.pow(t, exponent);
        curve[i] = from + ((to - from) * shaped);
    }
    return curve;
}

function mapCurve(curve, from, to, shapeExp = 1.0) {
    const out = new Float32Array(curve.length);
    for (let i = 0; i < curve.length; i++) {
        const c = Math.max(0, Math.min(1, curve[i]));
        const shaped = Math.pow(c, shapeExp);
        out[i] = from + ((to - from) * shaped);
    }
    return out;
}

function getTapeStopParams(stopNorm, startNorm) {
    const stop = clamp01(Number(stopNorm), 0.55);
    const start = clamp01(Number(startNorm), 0.35);
    const stopTimeSec = TAPE_STOP_MIN_STOP_SEC + (Math.pow(1 - stop, 1.25) * (TAPE_STOP_MAX_STOP_SEC - TAPE_STOP_MIN_STOP_SEC));
    const startTimeSec = TAPE_STOP_MIN_START_SEC + (Math.pow(start, 1.2) * (TAPE_STOP_MAX_START_SEC - TAPE_STOP_MIN_START_SEC));
    const stopStrength = clamp01((stopTimeSec - TAPE_STOP_MIN_STOP_SEC) / Math.max(0.0001, (TAPE_STOP_MAX_STOP_SEC - TAPE_STOP_MIN_STOP_SEC)), 0.5);

    const normal = {
        lfoHz: 1.6 - (stopStrength * 0.55),
        smootherHz: 6.5 - (stopStrength * 2.2),
        depthSec: 0.001 + (stopStrength * 0.0017),
        baseSec: 0.001 + (stopStrength * 0.0009),
        flutterHz: 6.2 - (stopStrength * 2.6),
        flutterDepthSec: 0.00022 + (stopStrength * 0.00018),
        toneHz: 9000 - (stopStrength * 1100)
    };
    const stopped = {
        lfoHz: 0.008,
        smootherHz: 0.7,
        depthSec: 0.016 + (stopStrength * 0.01),
        baseSec: 0.011 + (stopStrength * 0.018),
        flutterHz: 0.7,
        flutterDepthSec: 0.00001,
        toneHz: 110
    };
    return {
        stopTimeSec,
        startTimeSec,
        curveExp: TAPE_STOP_CURVE_EXP,
        releaseExp: TAPE_STOP_RELEASE_EXP,
        normal,
        stopped
    };
}

function applyTapeStopFromUI(stopNorm = getTapeStopStopNorm(), startNorm = getTapeStopStartNorm()) {
    if (!audioCtx || !fxNodes.tapestop || !fxNodes.tapestop.lfo) return;
    const p = getTapeStopParams(stopNorm, startNorm);
    fxNodes.tapestop.lfo.frequency.setTargetAtTime(p.normal.lfoHz, audioCtx.currentTime, 0.05);
    fxNodes.tapestop.depthNode.gain.setTargetAtTime(p.normal.depthSec, audioCtx.currentTime, 0.05);
    if (fxNodes.tapestop.smoother && fxNodes.tapestop.smoother.frequency) {
        fxNodes.tapestop.smoother.frequency.setTargetAtTime(p.normal.smootherHz, audioCtx.currentTime, 0.05);
    }
    if (fxNodes.tapestop.flutterOsc && fxNodes.tapestop.flutterOsc.frequency) {
        fxNodes.tapestop.flutterOsc.frequency.setTargetAtTime(p.normal.flutterHz, audioCtx.currentTime, 0.05);
    }
    if (fxNodes.tapestop.flutterDepth && fxNodes.tapestop.flutterDepth.gain) {
        fxNodes.tapestop.flutterDepth.gain.setTargetAtTime(p.normal.flutterDepthSec, audioCtx.currentTime, 0.05);
    }
    if (fxNodes.tapestop.base && fxNodes.tapestop.base.offset) {
        fxNodes.tapestop.base.offset.setTargetAtTime(p.normal.baseSec, audioCtx.currentTime, 0.05);
    }
    if (fxNodes.tapestop.tone && fxNodes.tapestop.tone.frequency) {
        fxNodes.tapestop.tone.frequency.setTargetAtTime(p.normal.toneHz, audioCtx.currentTime, 0.05);
    }
}

function setTapeStopTriggerVisual(active) {
    const btn = document.querySelector('.fx-enable-btn--tapestop');
    if (!btn) return;
    btn.classList.toggle('active', !!active);
    btn.textContent = 'TRG';
}

function clearTapeStopTimers() {
    if (tapeStopHoldTimer) {
        clearTimeout(tapeStopHoldTimer);
        tapeStopHoldTimer = null;
    }
    if (tapeStopReleaseTimer) {
        clearTimeout(tapeStopReleaseTimer);
        tapeStopReleaseTimer = null;
    }
}

function setTapeStopState(nextState, refreshRouting = true) {
    tapeStopState = nextState;
    setTapeStopTriggerVisual(nextState !== TAPE_STOP_STATE.BYPASS);
    if (refreshRouting) updateRoutingFromUI();
}

function stopTapeStopTrigger(resetFx = true, refreshRouting = true) {
    const ts = fxNodes.tapestop;
    const now = audioCtx ? audioCtx.currentTime : 0;
    const token = ++tapeStopStateToken;
    clearTapeStopTimers();

    if (!audioCtx || !ts || !ts.input || !ts.input.gain) {
        setTapeStopState(TAPE_STOP_STATE.BYPASS, refreshRouting);
        return;
    }

    if (!resetFx) {
        ts.input.gain.cancelScheduledValues(now);
        ts.input.gain.setValueAtTime(1.0, now);
        setTapeStopState(TAPE_STOP_STATE.BYPASS, refreshRouting);
        return;
    }

    const p = getTapeStopParams(getTapeStopStopNorm(), getTapeStopStartNorm());
    const releaseDur = p.startTimeSec;
    const pointCount = Math.max(48, Math.min(512, Math.floor(releaseDur * 190)));
    const speedUp = buildPowerCurve(pointCount, p.releaseExp, 0, 1);
    setTapeStopState(TAPE_STOP_STATE.STARTING, refreshRouting);

    ts.input.gain.cancelScheduledValues(now);
    ts.input.gain.setValueAtTime(Math.max(0.0001, ts.input.gain.value || 0.0001), now);
    ts.input.gain.setValueCurveAtTime(mapCurve(speedUp, 0.0001, 1.0, 0.8), now, releaseDur);
    ts.lfo.frequency.cancelScheduledValues(now);
    ts.lfo.frequency.setValueCurveAtTime(mapCurve(speedUp, p.stopped.lfoHz, p.normal.lfoHz), now, releaseDur);
    if (ts.smoother && ts.smoother.frequency) {
        ts.smoother.frequency.cancelScheduledValues(now);
        ts.smoother.frequency.setValueCurveAtTime(mapCurve(speedUp, p.stopped.smootherHz, p.normal.smootherHz), now, releaseDur);
    }
    if (ts.depthNode && ts.depthNode.gain) {
        ts.depthNode.gain.cancelScheduledValues(now);
        ts.depthNode.gain.setValueCurveAtTime(mapCurve(speedUp, p.stopped.depthSec, p.normal.depthSec), now, releaseDur);
    }
    if (ts.base && ts.base.offset) {
        ts.base.offset.cancelScheduledValues(now);
        ts.base.offset.setValueCurveAtTime(mapCurve(speedUp, p.stopped.baseSec, p.normal.baseSec), now, releaseDur);
    }
    if (ts.flutterOsc && ts.flutterOsc.frequency) {
        ts.flutterOsc.frequency.cancelScheduledValues(now);
        ts.flutterOsc.frequency.setValueCurveAtTime(mapCurve(speedUp, p.stopped.flutterHz, p.normal.flutterHz), now, releaseDur);
    }
    if (ts.flutterDepth && ts.flutterDepth.gain) {
        ts.flutterDepth.gain.cancelScheduledValues(now);
        ts.flutterDepth.gain.setValueCurveAtTime(mapCurve(speedUp, p.stopped.flutterDepthSec, p.normal.flutterDepthSec), now, releaseDur);
    }
    if (ts.tone && ts.tone.frequency) {
        ts.tone.frequency.cancelScheduledValues(now);
        ts.tone.frequency.setValueCurveAtTime(mapCurve(speedUp, p.stopped.toneHz, p.normal.toneHz), now, releaseDur);
    }

    tapeStopReleaseTimer = setTimeout(() => {
        if (token !== tapeStopStateToken) return;
        applyTapeStopFromUI();
        setTapeStopState(TAPE_STOP_STATE.BYPASS, true);
    }, Math.ceil(releaseDur * 1000) + 20);
}

function startTapeStopTriggerHold(stopNorm = getTapeStopStopNorm(), startNorm = getTapeStopStartNorm()) {
    if (!audioCtx || !fxNodes.tapestop || !fxNodes.tapestop.lfo) return;

    const p = getTapeStopParams(stopNorm, startNorm);
    const now = audioCtx.currentTime;

    const token = ++tapeStopStateToken;
    clearTapeStopTimers();
    const stopDur = p.stopTimeSec;
    const pointCount = Math.max(48, Math.min(768, Math.floor(stopDur * 210)));
    const speedCurve = buildPowerCurve(pointCount, p.curveExp, 0, 1);
    for (let i = 0; i < speedCurve.length; i++) speedCurve[i] = Math.max(0.0001, 1 - speedCurve[i]);

    setTapeStopState(TAPE_STOP_STATE.STOPPING, true);

    const ts = fxNodes.tapestop;

    if (ts.input && ts.input.gain) {
        ts.input.gain.cancelScheduledValues(now);
        ts.input.gain.setValueAtTime(1.0, now);
        ts.input.gain.setValueCurveAtTime(mapCurve(speedCurve, 0.0001, 1.0, 1.05), now, stopDur);
    }

    ts.lfo.frequency.cancelScheduledValues(now);
    ts.lfo.frequency.setValueCurveAtTime(mapCurve(speedCurve, p.stopped.lfoHz, p.normal.lfoHz), now, stopDur);

    if (ts.smoother && ts.smoother.frequency) {
        ts.smoother.frequency.cancelScheduledValues(now);
        ts.smoother.frequency.setValueCurveAtTime(mapCurve(speedCurve, p.stopped.smootherHz, p.normal.smootherHz), now, stopDur);
    }

    if (ts.depthNode && ts.depthNode.gain) {
        ts.depthNode.gain.cancelScheduledValues(now);
        ts.depthNode.gain.setValueCurveAtTime(mapCurve(speedCurve, p.stopped.depthSec, p.normal.depthSec), now, stopDur);
    }

    if (ts.base && ts.base.offset) {
        ts.base.offset.cancelScheduledValues(now);
        ts.base.offset.setValueCurveAtTime(mapCurve(speedCurve, p.stopped.baseSec, p.normal.baseSec), now, stopDur);
    }

    if (ts.flutterOsc && ts.flutterOsc.frequency) {
        ts.flutterOsc.frequency.cancelScheduledValues(now);
        ts.flutterOsc.frequency.setValueCurveAtTime(mapCurve(speedCurve, p.stopped.flutterHz, p.normal.flutterHz), now, stopDur);
    }

    if (ts.flutterDepth && ts.flutterDepth.gain) {
        ts.flutterDepth.gain.cancelScheduledValues(now);
        ts.flutterDepth.gain.setValueCurveAtTime(mapCurve(speedCurve, p.stopped.flutterDepthSec, p.normal.flutterDepthSec), now, stopDur);
    }

    if (ts.tone && ts.tone.frequency) {
        ts.tone.frequency.cancelScheduledValues(now);
        ts.tone.frequency.setValueCurveAtTime(mapCurve(speedCurve, p.stopped.toneHz, p.normal.toneHz), now, stopDur);
    }

    tapeStopHoldTimer = setTimeout(() => {
        if (token !== tapeStopStateToken) return;
        if (tapeStopState !== TAPE_STOP_STATE.STOPPING) return;
        if (ts.input && ts.input.gain) {
            ts.input.gain.cancelScheduledValues(audioCtx.currentTime);
            ts.input.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        }
        setTapeStopState(TAPE_STOP_STATE.HELD, true);
    }, Math.ceil(stopDur * 1000) + 8);
}

function buildSegmentMeta(brush) {
    const thickness = parseInt(sizeSlider.value, 10);
    const meta = {
        brush: brush || "standard",
        thickness: Number.isFinite(thickness) ? thickness : 5,
        chordType: chordSelect.value
    };
    if (meta.brush === "calligraphy") meta.calligraphy = getCurrentCalligraphyModifier();
    if (meta.brush === "explosion") meta.explosion = getCurrentExplosionModifier();
    if (meta.brush === "evolve" || meta.brush === "evolve2") meta.evolve = getCurrentEvolveModifier();
    return meta;
}

function downloadJson(data, fileName) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
}

function ensureSlotExportChoiceOverlay() {
    if (slotExportChoiceOverlay) return slotExportChoiceOverlay;
    const overlay = document.createElement("div");
    overlay.id = "slotExportChoiceOverlay";
    overlay.className = "export-busy-overlay export-choice-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="export-busy-overlay__panel export-choice-overlay__panel" role="dialog" aria-modal="true" aria-labelledby="slotExportChoiceTitle">
        <div id="slotExportChoiceTitle" class="export-choice-overlay__title">Export Slot As</div>
        <div class="export-choice-overlay__actions">
          <button type="button" class="btn--ctrl export-choice-btn" data-export-choice="wav">WAV</button>
          <button type="button" class="btn--ctrl export-choice-btn" data-export-choice="json">JSON</button>
          <button type="button" class="btn--ctrl export-choice-btn" data-export-choice="cancel">CANCEL</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    slotExportChoiceOverlay = overlay;
    return overlay;
}

function askSlotExportFormat(defaultFormat = "json") {
    return new Promise((resolve) => {
        const overlay = ensureSlotExportChoiceOverlay();
        const panel = overlay.querySelector(".export-choice-overlay__panel");
        const wavBtn = overlay.querySelector('[data-export-choice="wav"]');
        const jsonBtn = overlay.querySelector('[data-export-choice="json"]');
        const cancelBtn = overlay.querySelector('[data-export-choice="cancel"]');

        const cleanup = () => {
            overlay.classList.remove("is-active");
            overlay.setAttribute("aria-hidden", "true");
            overlay.removeEventListener("click", onOverlayClick);
            document.removeEventListener("keydown", onKeyDown, true);
            [wavBtn, jsonBtn, cancelBtn].forEach((btn) => {
                if (!btn) return;
                btn.removeEventListener("click", onButtonClick);
            });
        };

        const finish = (choice) => {
            cleanup();
            resolve(choice);
        };

        const onButtonClick = (e) => {
            const choice = e.currentTarget && e.currentTarget.dataset
                ? e.currentTarget.dataset.exportChoice
                : "cancel";
            if (choice === "wav") return finish("wav");
            if (choice === "json") return finish("json");
            return finish(null);
        };

        const onOverlayClick = (e) => {
            if (e.target === overlay) finish(null);
        };

        const onKeyDown = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                finish(null);
            }
        };

        [wavBtn, jsonBtn, cancelBtn].forEach((btn) => {
            if (!btn) return;
            btn.addEventListener("click", onButtonClick);
        });
        overlay.addEventListener("click", onOverlayClick);
        document.addEventListener("keydown", onKeyDown, true);
        overlay.classList.add("is-active");
        overlay.setAttribute("aria-hidden", "false");
        const preferredBtn = defaultFormat === "wav" ? wavBtn : jsonBtn;
        (preferredBtn || wavBtn || panel)?.focus();
    });
}

function getSelectedPatternSlot() {
    const bank = PATTERN_BANK_IDS.includes(activePatternSlot.bank) ? activePatternSlot.bank : "A";
    const idx = Math.max(0, Math.min(PATTERN_SLOTS_PER_BANK - 1, Number(activePatternSlot.idx) || 0));
    const slot = `${bank}${idx + 1}`;
    return { slot, bank, idx };
}

function setSlotTargetPickerUI(active) {
    document.querySelectorAll(".pad.pattern-btn").forEach(p => p.classList.toggle("slot-pick", active));
    const loadPatBtn = document.getElementById("loadPresetPatternButton");
    const saveBtn = document.getElementById("savePatternButton");
    const mode = slotTargetPicker && slotTargetPicker.mode ? slotTargetPicker.mode : "load";

    if (loadPatBtn) {
        const loadActive = !!active && mode === "load";
        loadPatBtn.classList.toggle("is-armed", loadActive);
        loadPatBtn.textContent = loadActive ? "CHOOSE SLOT" : "LOAD SLOT";
    }
    if (saveBtn) {
        const saveActive = !!active && mode === "save";
        saveBtn.classList.toggle("is-armed", saveActive);
        saveBtn.textContent = saveActive ? "CHOOSE SLOT" : "SAVE SLOT";
    }
}

function clearSlotTargetPicker() {
    slotTargetPicker = null;
    setSlotTargetPickerUI(false);
}

function beginSlotTargetPicker(onPick, mode = "load") {
    slotTargetPicker = { onPick, mode: mode === "save" ? "save" : "load" };
    setSlotTargetPickerUI(true);
}

function consumeSlotTargetPick(bank, idx) {
    if (!slotTargetPicker || typeof slotTargetPicker.onPick !== "function") return false;
    const onPick = slotTargetPicker.onPick;
    clearSlotTargetPicker();
    onPick(bank, idx);
    return true;
}

function activatePatternPad(bank, idx) {
    document.querySelectorAll(".pad.active").forEach(p => p.classList.remove("active"));
    const activePad = document.querySelector(`.pad[data-bank="${bank}"][data-idx="${idx}"]`);
    if (activePad) activePad.classList.add("active");
    activePatternSlot = { bank, idx };
}

function createCurrentPatternSnapshot() {
    return {
        settings: {
            bpm: document.getElementById("bpmInput").value,
            loop: document.getElementById("loopCheckbox").checked,
            scale: scaleSelect.value,
            harmonize: harmonizeCheckbox.checked,
            pathMode: playbackPathMode
        },
        fx: {
            delay: { time: getKnobVal("DELAY", "TIME") * 1.0, feedback: getKnobVal("DELAY", "FDBK") * 0.9 },
            reverb: { mix: getKnobVal("REVERB", "MIX") * 1.5, decay: getKnobVal("REVERB", "DECAY") * 1.0 },
            vibrato: { rate: getKnobVal("VIBRATO", "RATE") * 20, depth: getKnobVal("VIBRATO", "DEPTH") * 0.01 },
            filter: { freq: getKnobVal("FILTER", "FREQ") * 1.0, res: getKnobVal("FILTER", "RES") * 1.0 },
            stutter: { rate: getKnobVal("STUTTER", "RATE") * 1.0, mix: getKnobVal("STUTTER", "MIX") * 1.0 },
            tapestop: { stop: getTapeStopStopNorm() * 1.0, start: getTapeStopStartNorm() * 1.0 },
            fractal: { chaos: readModifierKnob("fractal-chaos", 0), morph: readModifierKnob("fractal-morph", 0) },
            matrix: tracks.map((_, i) => ({
                delay: getMatrixStateByName("DELAY", i),
                reverb: getMatrixStateByName("REVERB", i),
                vibrato: getMatrixStateByName("VIBRATO", i),
                filter: getMatrixStateByName("FILTER", i),
                stutter: getMatrixStateByName("STUTTER", i),
                tapestop: getMatrixStateByName("TAPE STOP", i)
            }))
        },
        tracks: tracks.map(t => ({
            segments: t.segments,
            vol: t.vol,
            mute: t.mute,
            solo: t.solo,
            bp: t.bp,
            wave: t.wave,
            snap: t.snap,
            noiseQ: t.noiseQ,
            lengthSteps: t.lengthSteps,
            gridSteps: t.gridSteps
        }))
    };
}

function createEmptyPatternSnapshotFromCurrentState() {
    const snapshot = createCurrentPatternSnapshot();
    if (Array.isArray(snapshot.tracks)) {
        snapshot.tracks.forEach(trackState => {
            trackState.segments = [];
        });
    }
    return snapshot;
}

function persistPatternBanksToLocalStorage() {
    try {
        localStorage.setItem("pigeonBanks", JSON.stringify(patternBanks));
        return true;
    } catch (err) {
        const isQuotaError = !!err && (
            err.name === "QuotaExceededError"
            || err.name === "NS_ERROR_DOM_QUOTA_REACHED"
            || err.code === 22
            || err.code === 1014
        );
        console.error("Speichern in LocalStorage fehlgeschlagen:", err);
        if (isQuotaError) {
            alert("Speicher voll: Die Bank konnte nicht lokal gespeichert werden. Bitte exportiere die Bank als JSON und lösche alte Browserdaten.");
        } else {
            alert("Lokales Speichern fehlgeschlagen. Bitte exportiere die Bank als JSON.");
        }
        return false;
    }
}

function saveCurrentPatternToSlot(bank, idx) {
    patternBanks = normalizePatternBanksShape(patternBanks);
    patternBanks[bank][idx] = createCurrentPatternSnapshot();
    persistPatternBanksToLocalStorage();
    updatePadUI(patternBanks);
    activatePatternPad(bank, idx);
}

function showSavePatternFeedback(saveBtn, isOverwrite, bank, idx) {
    if (!saveBtn) return;
    if (savePatternFeedbackTimer) clearTimeout(savePatternFeedbackTimer);

    saveBtn.classList.remove("is-saved", "is-overwrite");
    saveBtn.classList.add(isOverwrite ? "is-overwrite" : "is-saved");
    saveBtn.textContent = isOverwrite ? "OVERWRITE" : "SAVED";

    const pad = document.querySelector(`.pad[data-bank="${bank}"][data-idx="${idx}"]`);
    if (pad) {
        pad.classList.remove("just-saved");
        // Restart animation on repeated clicks.
        void pad.offsetWidth;
        pad.classList.add("just-saved");
    }

    savePatternFeedbackTimer = setTimeout(() => {
        saveBtn.textContent = "SAVE SLOT";
        saveBtn.classList.remove("is-saved", "is-overwrite");
        if (pad) pad.classList.remove("just-saved");
        savePatternFeedbackTimer = null;
    }, 900);
}

async function loadPresetDataById(presetId) {
    const src = presetBankSources.find(p => p.id === presetId);
    if (!src) return null;
    if (presetCache[presetId]) return presetCache[presetId];
    const response = await fetch(src.url);
    if (!response.ok) throw new Error(`Preset load failed: ${src.url}`);
    const data = await response.json();
    presetCache[presetId] = data;
    return data;
}

function clearPresetCache() {
    Object.keys(presetCache).forEach(key => delete presetCache[key]);
}

function toPresetLabelFromId(id) {
    return String(id || "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, ch => ch.toUpperCase());
}

function normalizePresetSources(rawSources) {
    if (!Array.isArray(rawSources)) return [];
    const seen = new Set();
    const normalized = [];
    rawSources.forEach(src => {
        if (!src || typeof src.id !== "string" || typeof src.url !== "string") return;
        const id = src.id.trim();
        const url = src.url.trim();
        const name = String(src.name || toPresetLabelFromId(id)).trim();
        if (!id || !url || !name || seen.has(id)) return;
        seen.add(id);
        normalized.push({ id, name, url });
    });
    return normalized;
}

function isFloatersPresetSource(src) {
    if (!src) return false;
    const id = String(src.id || "").toLowerCase();
    const name = String(src.name || "").toLowerCase();
    const url = String(src.url || "").toLowerCase();
    return (
        id === "floaters a"
        || id === "floaters_a"
        || id === "floaters-a"
        || name === "floaters a"
        || url.endsWith("/floaters a.json")
        || url.endsWith("/floaters_a.json")
        || url.endsWith("/floaters-a.json")
    );
}

function ensureStandardSetFirst(sources) {
    const normalized = normalizePresetSources(sources);
    if (!normalized.length) return normalized;

    const standard = normalized.find(src => src.id === "standard_set") || null;
    const floaters = normalized.find(isFloatersPresetSource) || null;

    // Always prefer Standard Set at position 1 when available.
    if (standard) {
        const ordered = [standard];
        if (floaters && floaters !== standard) ordered.push(floaters);
        normalized.forEach(src => {
            if (src === standard || src === floaters) return;
            ordered.push(src);
        });
        return ordered;
    }

    // If Standard Set is missing, keep the first non-Floaters source as position 1
    // and pin Floaters to position 2.
    if (floaters) {
        const firstNonFloaters = normalized.find(src => src !== floaters) || null;
        if (!firstNonFloaters) return [floaters];
        const ordered = [firstNonFloaters, floaters];
        normalized.forEach(src => {
            if (src === firstNonFloaters || src === floaters) return;
            ordered.push(src);
        });
        return ordered;
    }

    return normalized;
}

async function ensurePinnedPresetSources(sources) {
    let ordered = ensureStandardSetFirst(sources);
    if (ordered.some(isFloatersPresetSource)) return ordered;

    const floatersCandidates = [
        { id: "floaters_a", name: "Floaters A", url: "presets/Floaters A.json" },
        { id: "floaters_a", name: "Floaters A", url: "presets/Floaters_A.json" },
        { id: "floaters_a", name: "Floaters A", url: "presets/Floaters-A.json" }
    ];

    for (const candidate of floatersCandidates) {
        try {
            const resp = await fetch(candidate.url, { method: "HEAD", cache: "no-store" });
            if (!resp.ok) continue;
            ordered = ensureStandardSetFirst([...ordered, candidate]);
            break;
        } catch (_) {
            // Ignore probe errors; candidate may not exist in this hosting mode.
        }
    }

    return ordered;
}

function pickDefaultPresetId() {
    if (presetBankSources.some(src => src.id === "standard_set")) return "standard_set";
    return presetBankSources[0] ? presetBankSources[0].id : "";
}

function populatePresetBankSelect(selectEl, preferredId = "") {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    presetBankSources.forEach(src => {
        const opt = document.createElement("option");
        opt.value = src.id;
        opt.textContent = src.name;
        selectEl.appendChild(opt);
    });
    const hasPreferred = preferredId && presetBankSources.some(src => src.id === preferredId);
    selectEl.value = hasPreferred ? preferredId : pickDefaultPresetId();
}

async function loadDynamicPresetBankSources() {
    const tryFetch = async (url, label) => {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
        const payload = await response.json();
        const candidate = Array.isArray(payload) ? payload : payload && payload.sources;
        const sources = await ensurePinnedPresetSources(candidate);
        if (!sources.length) throw new Error(`${label} empty`);
        return sources;
    };

    let sources = null;
    try {
        sources = await tryFetch("/api/preset-banks", "Preset API");
    } catch (apiErr) {
        console.warn("Preset API nicht erreichbar, versuche statisches Manifest.", apiErr);
        try {
            sources = await tryFetch(presetBankManifestPath, "Preset manifest");
        } catch (manifestErr) {
            console.warn("Preset manifest nicht erreichbar, nutze Fallback-Liste.", manifestErr);
        }
    }

    if (sources && sources.length) {
        presetBankSources = sources;
        clearPresetCache();
        return presetBankSources;
    }

    presetBankSources = await ensurePinnedPresetSources(fallbackPresetBankSources);
    clearPresetCache();
    return presetBankSources;
}

function applyLoadedBankPayload(data) {
    if (!data || typeof data !== "object") return false;

    let loadedAnything = false;
    if (data.banks && typeof data.banks === "object") {
        patternBanks = normalizePatternBanksShape(JSON.parse(JSON.stringify(data.banks)));
        updatePadUI(patternBanks);
        persistPatternBanksToLocalStorage();
        loadedAnything = true;
    }

    if (data.current && typeof data.current === "object") {
        loadPatternData(data.current);
        loadedAnything = true;
    } else if (loadedAnything && patternBanks.A && patternBanks.A[0]) {
        loadPatternData(patternBanks.A[0]);
    }

    if (loadedAnything) setActivePadFromBanks();
    return loadedAnything;
}

function queueLoadedBankPayload(data) {
    if (!data || typeof data !== "object") return false;
    queuedPresetBank = data;
    queuedPattern = null;
    document.querySelectorAll(".pad.queued").forEach(p => p.classList.remove("queued"));
    killPreScheduledFutureTrackGraph();
    // Prevent stale pre-scheduled material from being reused on the next boundary.
    clearNextLoopSchedule();
    return true;
}

function setupPresetControls() {
    const bankSelect = document.getElementById("presetBankSelect");
    const loadBankBtn = document.getElementById("loadPresetBankButton");
    const importBankBtn = document.getElementById("importPresetBankButton");
    const loadPatBtn = document.getElementById("loadPresetPatternButton");
    const exportBankBtn = document.getElementById("exportBankButton");
    const exportPatternBtn = document.getElementById("exportPatternButton");
    const savePatternBtn = document.getElementById("savePatternButton");

    if (!bankSelect || !loadBankBtn || !importBankBtn || !loadPatBtn || !exportBankBtn || !exportPatternBtn || !savePatternBtn) return;

    populatePresetBankSelect(bankSelect, pickDefaultPresetId());
    loadDynamicPresetBankSources()
        .then(() => {
            const currentSelected = bankSelect.value;
            populatePresetBankSelect(bankSelect, currentSelected);
        })
        .catch((err) => {
            console.warn("Preset manifest konnte nicht geladen werden, nutze Fallback-Liste.", err);
            // Keep fallback list when manifest cannot be loaded.
        });

    loadBankBtn.addEventListener("click", async () => {
        try {
            const data = await loadPresetDataById(bankSelect.value);
            if (!data) return;
            if (isPlaying) {
                if (!queueLoadedBankPayload(data)) throw new Error("Invalid preset bank payload");
                return;
            }
            if (!applyLoadedBankPayload(data)) throw new Error("Invalid preset bank payload");
        } catch (err) {
            console.error(err);
            alert("Preset-Bank konnte nicht geladen werden.");
        }
    });

    importBankBtn.addEventListener("click", () => {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.accept = ".json,application/json";

        picker.addEventListener("change", async () => {
            const file = picker.files && picker.files[0];
            if (!file) return;
            if (file.size > MAX_IMPORT_FILE_SIZE_BYTES) {
                alert("Datei zu groß. Maximal erlaubt sind 5 MB.");
                return;
            }

            let parsed;
            try {
                parsed = JSON.parse(await file.text());
            } catch (parseErr) {
                console.error(parseErr);
                alert("Ungültige JSON-Datei.");
                return;
            }

            if (isPlaying) {
                if (!queueLoadedBankPayload(parsed)) {
                    alert("In der Datei wurde keine gültige Bank gefunden.");
                }
                return;
            }

            if (!applyLoadedBankPayload(parsed)) {
                alert("In der Datei wurde keine gültige Bank gefunden.");
            }
        });

        picker.click();
    });

    loadPatBtn.addEventListener("click", () => {
        if (slotTargetPicker) {
            clearSlotTargetPicker();
            return;
        }
        beginSlotTargetPicker((targetBank, targetIdx) => {
            activatePatternPad(targetBank, targetIdx);
            const picker = document.createElement("input");
            picker.type = "file";
            picker.accept = ".json,application/json";

            picker.addEventListener("change", async () => {
                const file = picker.files && picker.files[0];
                if (!file) return;
                if (file.size > MAX_IMPORT_FILE_SIZE_BYTES) {
                    alert("Datei zu groß. Maximal erlaubt sind 5 MB.");
                    return;
                }

                let parsed;
                try {
                    parsed = JSON.parse(await file.text());
                } catch (parseErr) {
                    console.error(parseErr);
                    alert("Ungültige JSON-Datei.");
                    return;
                }

                const pattern = resolvePatternFromImportedJson(parsed, targetBank, targetIdx);
                if (!pattern) {
                    alert("In der Datei wurde kein gültiger Slot-Inhalt gefunden.");
                    return;
                }

                patternBanks = normalizePatternBanksShape(patternBanks);
                patternBanks[targetBank][targetIdx] = JSON.parse(JSON.stringify(pattern));
                persistPatternBanksToLocalStorage();
                updatePadUI(patternBanks);
                loadPatternData(pattern);
                activatePatternPad(targetBank, targetIdx);
            });

            picker.click();
        }, "load");
    });

    exportBankBtn.addEventListener("click", () => {
        const payload = { current: createCurrentPatternSnapshot(), banks: patternBanks };
        downloadJson(payload, "pigeon_bank.json");
    });

    exportPatternBtn.addEventListener("click", async () => {
        const { slot, bank, idx } = getSelectedPatternSlot();
        const pattern = patternBanks[bank] && patternBanks[bank][idx];
        if (!pattern) {
            alert(`Slot ${slot} ist leer. Erst speichern, dann exportieren.`);
            return;
        }
        const selectedFormat = await askSlotExportFormat(slotExportFormatPreference);
        if (!selectedFormat) return;
        slotExportFormatPreference = selectedFormat;

        if (selectedFormat === "json") {
            downloadJson({ slot, pattern }, `pigeon_slot_${slot}.json`);
            return;
        }

        const exportWavBtn = document.getElementById("exportWavButton");
        if (!exportWavBtn) {
            alert("WAV-Export ist aktuell nicht verfügbar.");
            return;
        }
        pendingWavExportFileName = `pigeon_slot_${slot}.wav`;
        exportWavBtn.click();
    });

    savePatternBtn.addEventListener("click", () => {
        if (slotTargetPicker) {
            clearSlotTargetPicker();
            return;
        }
        beginSlotTargetPicker((targetBank, targetIdx) => {
            const isOverwrite = Boolean(patternBanks[targetBank] && patternBanks[targetBank][targetIdx]);
            saveCurrentPatternToSlot(targetBank, targetIdx);
            showSavePatternFeedback(savePatternBtn, isOverwrite, targetBank, targetIdx);
        }, "save");
    });

    if (!setupPresetControls._escapeBound) {
        window.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            if (!slotTargetPicker) return;
            e.preventDefault();
            clearSlotTargetPicker();
        });
        setupPresetControls._escapeBound = true;
    }
}

function getClientPointFromEvent(e, touchId = null) {
    if (!e) return null;
    const hasTouchList = (list) => list && typeof list.length === "number" && list.length > 0;
    const touchLists = [];
    if (hasTouchList(e.touches)) touchLists.push(e.touches);
    if (hasTouchList(e.changedTouches)) touchLists.push(e.changedTouches);

    if (touchLists.length > 0) {
        let point = null;
        if (touchId !== null && touchId !== undefined) {
            for (const list of touchLists) {
                for (let i = 0; i < list.length; i++) {
                    if (list[i].identifier === touchId) {
                        point = list[i];
                        break;
                    }
                }
                if (point) break;
            }
        }
        if (!point) point = touchLists[0][0];
        if (!point) return null;
        return { x: point.clientX, y: point.clientY, identifier: point.identifier };
    }

    if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
        return { x: e.clientX, y: e.clientY, identifier: null };
    }
    return null;
}

function getPos(e, c, touchId = null) {
    const r = c.getBoundingClientRect();
    const point = getClientPointFromEvent(e, touchId);
    if (!point) return null;
    return {
        x: (point.x - r.left) * (c.width / r.width),
        y: (point.y - r.top) * (c.height / r.height)
    };
}

function saveState() {
    undoStack.push(JSON.stringify(tracks.map(t => t.segments)));
    if (undoStack.length > HISTORY_STACK_LIMIT) undoStack.shift();
    redoStack = [];
}

function getKnobVal(fxName, paramName) {
    ensureFxDomIndex();
    const fxKey = getFxKeyFromName(fxName);
    const fxEntry = fxKey ? fxDomIndex[fxKey] : null;
    if (!fxEntry) return 0;
    let val = 0;
    fxEntry.knobs.forEach(k => {
        if (k.nextElementSibling && k.nextElementSibling.textContent.trim() === paramName) {
            val = parseFloat(k.dataset.val || 0.5);
        }
    });
    return val;
}

function getMatrixStateByName(fxName, trackIndex) {
    ensureFxDomIndex();
    const fxKey = getFxKeyFromName(fxName);
    const fxEntry = fxKey ? fxDomIndex[fxKey] : null;
    if (!fxEntry) return false;
    const btn = fxEntry.matrixButtons[trackIndex];
    return !!(btn && btn.classList.contains("active"));
}

function setMatrixStateByName(fxName, trackIndex, isActive) {
    ensureFxDomIndex();
    const fxKey = getFxKeyFromName(fxName);
    const fxEntry = fxKey ? fxDomIndex[fxKey] : null;
    if (!fxEntry) return;
    const btn = fxEntry.matrixButtons[trackIndex];
    if (btn) {
        if (isActive) btn.classList.add("active");
        else btn.classList.remove("active");
    }
    if (fxEntry.led) {
        const hasActive = fxEntry.matrixButtons.some(b => b.classList.contains("active"));
        fxEntry.led.classList.toggle("on", hasActive);
    }
}

function audioBufferToWav(buffer) {
    let numOfChan = buffer.numberOfChannels, length = buffer.length * numOfChan * 2 + 44,
        bufferArray = new ArrayBuffer(length), view = new DataView(bufferArray),
        channels = [], i, sample, offset = 0, pos = 0;
    const setUint16 = data => { view.setUint16(pos, data, true); pos += 2; };
    const setUint32 = data => { view.setUint32(pos, data, true); pos += 4; };
    setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
    setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan);
    setUint32(buffer.sampleRate); setUint32(buffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - 44);
    for (i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    while (pos < length) {
        for (i = 0; i < numOfChan; i++) {
            sample = Math.max(-1, Math.min(1, channels[i][offset]));
            sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(pos, sample, true); pos += 2;
        }
        offset++;
    }
    return new Blob([bufferArray], { type: "audio/wav" });
}

function setExportBusyState(isBusy) {
    isExportingWav = !!isBusy;
    const overlay = document.getElementById("exportBusyOverlay");
    if (overlay) overlay.classList.toggle("is-active", isExportingWav);

    const app = document.querySelector(".app");
    if (app) app.setAttribute("aria-busy", isExportingWav ? "true" : "false");
}

// KEYBOARD SHORTCUTS (inkl. COPY / PASTE / DELETE)
window.addEventListener("keydown", (e) => {
    if (isExportingWav) {
        const key = String(e.key || "").toLowerCase();
        const isRefresh = e.key === "F5" || ((e.metaKey || e.ctrlKey) && key === "r");
        if (!isRefresh) e.preventDefault();
        return;
    }

    const target = e.target;
    const tag = target && target.tagName ? target.tagName.toUpperCase() : "";
    const inputType = (tag === "INPUT" && target.type) ? String(target.type).toLowerCase() : "";
    const nonTextInputTypes = ["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"];
    const isTextEntryTarget =
        tag === "TEXTAREA" ||
        (tag === "INPUT" && !nonTextInputTypes.includes(inputType)) ||
        (target && target.isContentEditable);
    if (isTextEntryTarget) return;
    
    if (e.code === "Space") {
        e.preventDefault(); 
        if (isPlaying) document.getElementById("stopButton").click();
        else document.getElementById("playButton").click();
    }
    
    const lowerKey = String(e.key || "").toLowerCase();
    if ((e.metaKey || e.ctrlKey) && ((e.shiftKey && lowerKey === "z") || lowerKey === "y")) {
        e.preventDefault();
        document.getElementById("redoButton").click();
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && lowerKey === "z") {
        e.preventDefault();
        document.getElementById("undoButton").click();
    }
    
    if ((e.metaKey || e.ctrlKey) && e.key === "c") {
        if (activeTrack && activeTrack.selectedSegments && activeTrack.selectedSegments.length > 0) {
            clipboardSegments = JSON.parse(JSON.stringify(activeTrack.selectedSegments));
        }
    }
    
    if ((e.metaKey || e.ctrlKey) && e.key === "v") {
        if (activeTrack && clipboardSegments.length > 0) {
            saveState();
            const pasted = JSON.parse(JSON.stringify(clipboardSegments));
            
            // Snap Logik beim Einfügen anwenden
            const gridX = getTrackGridStepSize(activeTrack);
            const offsetX = activeTrack.snap ? gridX : 15;
            
            pasted.forEach(seg => {
                seg.points.forEach(p => { p.x += offsetX; p.y += 15; }); 
                activeTrack.segments.push(seg);
            });
            activeTrack.selectedSegments = pasted; 
            redrawTrack(activeTrack, undefined, brushSelect.value, chordIntervals, chordColors);
        }
    }
    
    if (e.key === "Backspace" || e.key === "Delete" || e.code === "Backspace" || e.code === "Delete") {
        const isSelectMode = toolSelect.value === "select";
        if (isSelectMode) e.preventDefault();

        let deletedSomething = false;
        tracks.forEach(t => {
            if (t.selectedSegments && t.selectedSegments.length > 0) {
                if (!deletedSomething) { saveState(); deletedSomething = true; }
                t.segments = t.segments.filter(s => !t.selectedSegments.includes(s));
                t.selectedSegments = []; 
                redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
            }
        });

        // Keep transport phase stable: do not restart playback after delete.
    }
});

toolSelect.addEventListener("change", (e) => {
    const nextTool = e.target.value || "draw";
    updateToolButtons(nextTool);
    document.body.classList.toggle("eraser-mode", nextTool === "erase");
    document.body.classList.toggle("select-mode", nextTool === "select");
});

toolButtons.forEach(btn => {
    btn.addEventListener("click", () => {
        const nextTool = btn.dataset.tool;
        if (!nextTool) return;
        toolSelect.value = nextTool;
        toolSelect.dispatchEvent(new Event("change"));
    });
});

function updateToolButtons(activeTool) {
    toolButtons.forEach(btn => {
        const isActive = btn.dataset.tool === activeTool;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
}

function setupPathModeSwitch() {
    setPlaybackPathMode(playbackPathMode);
    document.querySelectorAll(".path-mode-btn").forEach(btn => {
        if (btn.dataset.pathBound === "1") return;
        btn.dataset.pathBound = "1";
        btn.addEventListener("click", () => {
            const nextMode = btn.dataset.pathMode === "draw" ? "draw" : "x";
            setPlaybackPathMode(nextMode);
        });
    });
}

function setupModifierKnobs() {
    document.querySelectorAll(".modify-knob").forEach(knob => {
        const startVal = clamp01(parseFloat(knob.dataset.val), 0.5);
        knob.dataset.val = startVal;
        knob.style.transform = `rotate(${-135 + (startVal * 270)}deg)`;
        setupKnob(knob, (val) => {
            const safeVal = clamp01(val, startVal);
            knob.dataset.val = safeVal;
            const modName = knob.dataset.mod || "";
            if (modName === "calligraphy-angle" || modName === "calligraphy-contrast") {
                applyCalligraphyModifierToSegments(getCurrentCalligraphyModifier());
            } else if (modName === "explosion-length" || modName === "explosion-burst") {
                applyExplosionModifierToSegments(getCurrentExplosionModifier());
            } else if (modName === "evolve-length" || modName === "evolve-branch" || modName === "evolve-time") {
                applyEvolveModifierToSegments(getCurrentEvolveModifier());
            } else if (modName === "fractal-chaos" || modName === "fractal-morph") {
                if (audioCtx && modName === "fractal-morph") applyFractalMorphRealtime(safeVal);
                if (audioCtx && modName === "fractal-chaos") applyFractalChaosRealtime(safeVal);
            }
            tracks.forEach(t => redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors));
        });
    });
}

function updateModifierUI() {
    const currentBrush = brushSelect.value;

    const chordRow = document.getElementById("chordSelectRow");
    const modifyFractalPanel = document.getElementById("modifyFractalPanel");
    const modifyCalligraphyPanel = document.getElementById("modifyCalligraphyPanel");
    const modifyExplosionPanel = document.getElementById("modifyExplosionPanel");
    const modifyEvolvePanel = document.getElementById("modifyEvolvePanel");
    const modifyEmptyPanel = document.getElementById("modifyEmptyPanel");
    const modifyLed = document.getElementById("modifyPanelLed");
    if (chordRow) chordRow.classList.toggle("is-active", currentBrush === "chord");
    if (modifyFractalPanel) modifyFractalPanel.classList.toggle("is-active", currentBrush === "fractal");
    if (modifyCalligraphyPanel) modifyCalligraphyPanel.classList.toggle("is-active", currentBrush === "calligraphy");
    if (modifyExplosionPanel) modifyExplosionPanel.classList.toggle("is-active", currentBrush === "explosion");
    if (modifyEvolvePanel) modifyEvolvePanel.classList.toggle("is-active", currentBrush === "evolve" || currentBrush === "evolve2");
    if (modifyEmptyPanel) modifyEmptyPanel.classList.toggle("is-active", currentBrush !== "fractal" && currentBrush !== "chord" && currentBrush !== "calligraphy" && currentBrush !== "explosion" && currentBrush !== "evolve" && currentBrush !== "evolve2");
    if (modifyLed) modifyLed.classList.toggle("on", currentBrush === "fractal" || currentBrush === "chord" || currentBrush === "calligraphy" || currentBrush === "explosion" || currentBrush === "evolve" || currentBrush === "evolve2");
}
setupModifierKnobs();
setupPathModeSwitch();
brushSelect.addEventListener("change", updateModifierUI);
updateModifierUI(); 

chordSelect.addEventListener("change", () => {
    tracks.forEach(track => {
        track.segments.forEach(seg => {
            if ((seg.brush || "standard") === "chord") seg.chordType = chordSelect.value;
        });
    });
    tracks.forEach(t => redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors));
    if (isPlaying) {
        clearNextLoopSchedule();
        scheduleUpcomingLoopIfNeeded();
    }
});

const toolHelpQuickBtn = document.getElementById("toolHelpQuickBtn");
if (toolHelpQuickBtn) {
    toolHelpQuickBtn.addEventListener("click", () => {
        const helpBtn = document.getElementById("helpBtn") || document.getElementById("helpButton");
        if (helpBtn) helpBtn.click();
    });
}

const updateEraserPos = (e) => {
    if (toolSelect.value === "erase" && customEraser) {
        const point = getClientPointFromEvent(e, null);
        if (!point) return;
        customEraser.style.left = point.x + "px";
        customEraser.style.top = point.y + "px";
    }
};
window.addEventListener("mousemove", updateEraserPos);
window.addEventListener("touchmove", updateEraserPos, { passive: true });

function applyAllVolumes() {
    if (!audioCtx) return;
    const anySolo = tracks.some(tr => tr.solo);
    tracks.forEach(tr => {
        const isAudible = anySolo ? tr.solo : !tr.mute;
        if (tr.masterGainNode) {
            tr.masterGainNode.gain.setTargetAtTime(isAudible ? tr.vol : 0, audioCtx.currentTime, 0.05);
        }
    });
}

function ensureParticleBus(track) {
    if (!audioCtx || !track) return null;
    if (track.particleBus && track.particleBus.ctx === audioCtx) return track.particleBus;

    const input = audioCtx.createGain();
    const trackGain = audioCtx.createGain();
    trackGain.gain.value = 1.0;
    input.connect(trackGain);
    connectTrackToFX(trackGain, track.index);

    track.particleBus = { ctx: audioCtx, input, trackGain, noiseFilter: null };
    applyAllVolumes();
    return track.particleBus;
}

function ensureParticleNoiseFilter(track, startFreq) {
    const bus = ensureParticleBus(track);
    if (!bus) return null;
    if (!bus.noiseFilter) {
        const filter = audioCtx.createBiquadFilter();
        filter.type = "bandpass";
        filter.connect(bus.input);
        bus.noiseFilter = filter;
    }
    const safeFreq = Math.max(30, Math.min(12000, startFreq || 440));
    bus.noiseFilter.Q.setTargetAtTime(Math.max(1, Math.min(18, track.noiseQ || 6)), audioCtx.currentTime, 0.02);
    bus.noiseFilter.frequency.setTargetAtTime(safeFreq, audioCtx.currentTime, 0.02);
    return bus.noiseFilter;
}

function applyAllFXFromUI() {
    if (!audioCtx) return;
    if (fxNodes.delay) { fxNodes.delay.node.delayTime.value = getKnobVal("DELAY", "TIME") * 1.0; fxNodes.delay.feedback.gain.value = getKnobVal("DELAY", "FDBK") * 0.9; }
    if (fxNodes.reverb) { fxNodes.reverb.mix.gain.value = getKnobVal("REVERB", "MIX") * 1.5; updateReverbDecay(getKnobVal("REVERB", "DECAY")); }
    if (fxNodes.vibrato) { fxNodes.vibrato.lfo.frequency.value = getKnobVal("VIBRATO", "RATE") * 20; fxNodes.vibrato.depthNode.gain.value = getKnobVal("VIBRATO", "DEPTH") * 0.01; }
    if (fxNodes.filter && fxNodes.filter.node1) { const valF = getKnobVal("FILTER", "FREQ"); const valR = getKnobVal("FILTER", "RES"); fxNodes.filter.node1.frequency.value = Math.pow(valF, 3) * 22000; fxNodes.filter.node2.frequency.value = Math.pow(valF, 3) * 22000; fxNodes.filter.node1.Q.value = valR * 15; fxNodes.filter.node2.Q.value = valR * 15; }
    if (fxNodes.stutter) { fxNodes.stutter.lfo.frequency.value = (getKnobVal("STUTTER", "RATE") * 15) + 1; }
    if (fxNodes.tapestop) applyTapeStopFromUI();
    applyFractalMorphRealtime(readModifierKnob("fractal-morph", 0));
    applyFractalChaosRealtime(readModifierKnob("fractal-chaos", 0));
    updateRoutingFromUI();
}

function setActivePadFromBanks() {
    document.querySelectorAll(".pad.active").forEach(p => p.classList.remove("active"));
    for (const bank of PATTERN_BANK_IDS) {
        for (let i = 0; i < PATTERN_SLOTS_PER_BANK; i++) {
            if (patternBanks[bank] && patternBanks[bank][i]) {
                activatePatternPad(bank, i);
                return true;
            }
        }
    }
    activatePatternPad("A", 0);
    return false;
}

function updateNoiseButtonLabel(track, container) {
    if (!container) return;
    const noiseBtn = container.querySelector('.wave-btn[data-wave="noise"]');
    if (!noiseBtn) return;
    const qSteps = [3, 6, 10, 14];
    const currentIdx = qSteps.indexOf(track.noiseQ);
    noiseBtn.dataset.noiseLevel = String(currentIdx >= 0 ? currentIdx : 1);
    noiseBtn.title = `Noise bandwidth (Q): ${track.noiseQ} — click again to cycle`;
    noiseBtn.setAttribute("aria-label", `Noise bandwidth Q ${track.noiseQ}`);
}

function updateTrackMetaTooltips(track, container) {
    if (!container) return;
    const gridBtn = container.querySelector(".btn--grid");
    const lenBtn = container.querySelector(".btn--len");
    const snapBox = container.querySelector(".snap-checkbox");
    const snapLabel = container.querySelector(".track__snap-inline");

    if (gridBtn) gridBtn.title = `Grid: ${track.gridSteps} steps`;
    if (lenBtn) lenBtn.title = `Loop length: ${track.lengthSteps} steps`;

    const snapText = `Snap: ${track.snap ? "on" : "off"}`;
    if (snapBox) snapBox.title = snapText;
    if (snapLabel) snapLabel.title = snapText;
}

function setStepButtonValue(btn, steps) {
    if (!btn) return;
    btn.textContent = String(steps);
}

function loadInitialData() {
    // 1) Try user-saved banks from localStorage first.
    try {
        const savedBanksRaw = localStorage.getItem("pigeonBanks");
        if (savedBanksRaw) {
            const savedBanks = JSON.parse(savedBanksRaw);
            if (savedBanks && typeof savedBanks === "object") {
                patternBanks = normalizePatternBanksShape(savedBanks);
                updatePadUI(patternBanks);

                for (const bank of PATTERN_BANK_IDS) {
                    for (let i = 0; i < PATTERN_SLOTS_PER_BANK; i++) {
                        if (patternBanks[bank] && patternBanks[bank][i]) {
                            loadPatternData(patternBanks[bank][i]);
                            setActivePadFromBanks();
                            return;
                        }
                    }
                }
                setActivePadFromBanks();
                return;
            }
        }
    } catch (err) {
        console.warn("Konnte gespeicherte Banks nicht laden, nutze default_set.json.", err);
    }

    // 2) Fallback to default_set.json.
    fetch('default_set.json')
        .then(res => res.json())
        .then(data => {
            if (data.banks) { patternBanks = normalizePatternBanksShape(data.banks); updatePadUI(patternBanks); }
            if (data.current) { loadPatternData(data.current); }
            setActivePadFromBanks();
        })
        .catch(() => console.log("Default-Set nicht gefunden. Starte mit leerem Canvas."));
}

function loadPatternData(d) {
    ensurePathModeSwitchVisible();
    const bpmInput = document.getElementById("bpmInput");
    const loopCheckbox = document.getElementById("loopCheckbox");
    const validScales = new Set(["major", "minor", "pentatonic"]);
    const settings = (d && typeof d === "object" && d.settings && typeof d.settings === "object")
        ? d.settings
        : null;

    const defaultBpm = Number(bpmInput?.defaultValue || bpmInput?.value || 120);
    const requestedBpm = Number(settings?.bpm);
    const nextBpm = Number.isFinite(requestedBpm) ? requestedBpm : defaultBpm;
    if (bpmInput && !midiSyncActive) {
        bpmInput.value = String(Math.max(40, Math.min(240, nextBpm)));
    }
    if (loopCheckbox) loopCheckbox.checked = typeof settings?.loop === "boolean" ? settings.loop : !!loopCheckbox.defaultChecked;

    const requestedScale = String(settings?.scale || "").toLowerCase();
    scaleSelect.value = validScales.has(requestedScale) ? requestedScale : "major";
    harmonizeCheckbox.checked = typeof settings?.harmonize === "boolean" ? settings.harmonize : false;
    scaleSelect.classList.toggle("is-active-ui", !!harmonizeCheckbox.checked);
    setPlaybackPathMode(settings?.pathMode === "draw" ? "draw" : "x");
    ensurePathModeSwitchVisible();

    // Always reset FX baseline first so partial/legacy patterns cannot leak stale state.
    resetFXUI();
    setTapeStopState(TAPE_STOP_STATE.BYPASS, false);
    setKnobVisual(document.querySelector('.modify-knob[data-mod="fractal-chaos"]'), 0);
    setKnobVisual(document.querySelector('.modify-knob[data-mod="fractal-morph"]'), 0);
    
    if (d.fx) {
        ensureFxDomIndex();
        if (d.fx.matrix) {
            d.fx.matrix.forEach((m, i) => {
                setMatrixStateByName("DELAY", i, m.delay || false);
                setMatrixStateByName("REVERB", i, m.reverb || false);
                setMatrixStateByName("VIBRATO", i, m.vibrato || false);
                setMatrixStateByName("FILTER", i, m.filter || false);
                setMatrixStateByName("STUTTER", i, m.stutter || false);
                setMatrixStateByName("TAPE STOP", i, m.tapestop || false);
            });
        }
        
        const updateKnob = (fxName, paramName, rawVal, multiplier) => {
            const fxEntry = fxDomIndex[getFxKeyFromName(fxName)];
            if (!fxEntry) return;
            fxEntry.knobs.forEach(knob => {
                if (knob.nextElementSibling && knob.nextElementSibling.textContent.trim() === paramName) {
                    const normVal = rawVal / multiplier;
                    knob.dataset.val = normVal;
                    knob.style.transform = `rotate(${-135 + (normVal * 270)}deg)`;
                }
            });
        };

        if (d.fx.delay) { updateKnob("DELAY", "TIME", d.fx.delay.time, 1.0); updateKnob("DELAY", "FDBK", d.fx.delay.feedback, 0.9); }
        if (d.fx.reverb) { updateKnob("REVERB", "MIX", d.fx.reverb.mix, 1.5); updateKnob("REVERB", "DECAY", d.fx.reverb.decay !== undefined ? d.fx.reverb.decay : 0.5, 1.0); }
        if (d.fx.vibrato) { updateKnob("VIBRATO", "RATE", d.fx.vibrato.rate, 20); updateKnob("VIBRATO", "DEPTH", d.fx.vibrato.depth, 0.01); }
        if (d.fx.filter) { updateKnob("FILTER", "FREQ", d.fx.filter.freq, 1.0); updateKnob("FILTER", "RES", d.fx.filter.res, 1.0); }
        if (d.fx.stutter) { updateKnob("STUTTER", "RATE", d.fx.stutter.rate, 1.0); updateKnob("STUTTER", "MIX", d.fx.stutter.mix, 1.0); }
        if (d.fx.tapestop) {
            const stopVal = d.fx.tapestop.stop ?? d.fx.tapestop.speed ?? 0.55;
            const startVal = d.fx.tapestop.start ?? d.fx.tapestop.depth ?? 0.35;
            updateKnob("TAPE STOP", "STOP", stopVal, 1.0);
            updateKnob("TAPE STOP", "START", startVal, 1.0);
        }
        if (d.fx.fractal) {
            setKnobVisual(document.querySelector('.modify-knob[data-mod="fractal-chaos"]'), d.fx.fractal.chaos ?? 0);
            setKnobVisual(document.querySelector('.modify-knob[data-mod="fractal-morph"]'), d.fx.fractal.morph ?? 0);
        }
    }
    applyAllFXFromUI();

    const tData = d.tracks || d;
    if (Array.isArray(tData)) {
        tData.forEach((td, idx) => {
            if (!tracks[idx]) return;
            let t = tracks[idx];
            const rawSegments = Array.isArray(td) ? td : (Array.isArray(td?.segments) ? td.segments : []);
            t.segments = JSON.parse(JSON.stringify(rawSegments));
            if (!Array.isArray(td)) {
                t.vol = td.vol ?? 0.8;
                t.mute = td.mute ?? false;
                t.solo = td.solo ?? false;
                t.bp = td.bp ?? false;
                t.wave = td.wave ?? "sine";
                t.snap = td.snap ?? false;
                t.noiseQ = td.noiseQ ?? 6;
                t.lengthSteps = td.lengthSteps ?? 32;
                t.gridSteps = td.gridSteps ?? 32;
            }
            t.selectedSegments = [];
            t.selectionBox = null;
            
            const cont = t.canvas.closest('.track-container');
            if (cont) {
                cont.querySelector(".volume-slider").value = t.vol;
                const muteBtn = cont.querySelector(".mute-btn");
                if (muteBtn) muteBtn.classList.toggle("active", t.mute);
                const soloBtn = cont.querySelector(".btn--solo");
                if (soloBtn) soloBtn.classList.toggle("active", t.solo);
                const bpBtn = cont.querySelector(".track__bp-extra");
                if (bpBtn) bpBtn.classList.toggle("active", t.bp);
                const snapBox = cont.querySelector(".snap-checkbox"); if(snapBox) snapBox.checked = t.snap;
                const lenBtn = cont.querySelector(".btn--len"); setStepButtonValue(lenBtn, t.lengthSteps);
                const gridBtn = cont.querySelector(".btn--grid"); setStepButtonValue(gridBtn, t.gridSteps);
                cont.querySelectorAll(".wave-btn").forEach(btn => {
                    if (btn.dataset.wave === t.wave) btn.classList.add("active");
                    else btn.classList.remove("active");
                });
                updateNoiseButtonLabel(t, cont);
                updateTrackMetaTooltips(t, cont);
            }
            redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
        });
        updatePlaybackDuration();
        if (!isPlaying || !midiSyncActive) updateActiveMidiLoopSpan(getGlobalLengthSteps());
        clearNextLoopSchedule();
        applyAllVolumes();
        updateRoutingFromUI();
    }
}

function startLiveSynth(track, x, y) {
    const anySolo = tracks.some(t => t.solo);
    const isAudible = anySolo ? track.solo : !track.mute;
    if (!isAudible || track.vol < 0.01) return;
    
    liveNodes = []; 
    liveGainNode = audioCtx.createGain(); 
    liveGainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    
    const brush = brushSelect.value;
    const calligraphyAudioMod = (brush === "calligraphy")
        ? getCalligraphyAudioModifier(track.curSeg?.calligraphy || getCurrentCalligraphyModifier())
        : null;
    let maxVol = (brush === "xenakis") ? 0.15 : (brush === "fractal" ? 0.2 : (brush === "rorschach" ? 0.2 : (brush === "overtone" ? 0.4 : (brush === "fm" ? 0.2 : 0.3))));
    if (calligraphyAudioMod) maxVol *= calligraphyAudioMod.gainScale;
    liveGainNode.gain.linearRampToValueAtTime(maxVol, audioCtx.currentTime + 0.01);
    
    let targetNode = liveGainNode;
    liveShaper = null;
    liveCompGain = null;

    if (brush === "fractal") {
        liveShaper = audioCtx.createWaveShaper();
        const morphVal = readModifierKnob("fractal-morph", 0);
        liveShaper.curve = getDistortionCurve(80 + (morphVal * 400));
        liveShaper.oversample = '4x';
        liveCompGain = audioCtx.createGain();
        liveCompGain.gain.value = 1.0 - (morphVal * 0.5); 
        liveShaper.connect(liveCompGain);
        liveCompGain.connect(liveGainNode);
        targetNode = liveShaper;
    }

    let currentY = y;
    if (brush === "fractal" && track.curSeg && track.curSeg.points.length > 0) {
        const fractalChaos = readModifierKnob("fractal-chaos", 0);
        const p = track.curSeg.points[track.curSeg.points.length - 1];
        currentY += (p.rY || 0) * 100 * fractalChaos;
    }
    const explosionProfile = (brush === "explosion")
        ? getExplosionAudioProfile(track.curSeg?.explosion || getCurrentExplosionModifier())
        : null;
    const evolveProfile = (brush === "evolve")
        ? getEvolveAudioProfile(track.curSeg?.evolve || getCurrentEvolveModifier())
        : null;
    
    let baseFreq = mapYToFrequency(currentY, 100); 
    if (harmonizeCheckbox.checked) baseFreq = quantizeFrequency(baseFreq, scaleSelect.value);
    
    // RORSCHACH FIX: Fügt dem Synthesizer 2 Stimmen [0, 1] für Original und Spiegelung hinzu
    const ivs = (brush === "evolve") ? (evolveProfile?.detunes || [0]) :
                (brush === "explosion") ? (explosionProfile?.detunes || [0]) :
                (brush === "chord") ? (chordIntervals[chordSelect.value] || chordIntervals["major"]) : 
                (brush === "xenakis" ? [0, 1, 2, 3, 4] : 
                (brush === "overtone" ? [1, 2, 3, 4, 5, 6] : 
                (brush === "rorschach" ? [0, 1] : [0]))); 

    ivs.forEach((iv, i) => {
        let oscVol = audioCtx.createGain();
        oscVol.gain.value = (brush === "overtone") ? ((1 / iv) * 0.4) : ((brush === "explosion" && explosionProfile) ? explosionProfile.gainScale : ((brush === "evolve" && evolveProfile) ? evolveProfile.gainScale : 1)); 

        let finalDetune = 0;
        let currentFreq = baseFreq;

        if (brush === "evolve" && evolveProfile) {
            finalDetune = iv;
        } else if (brush === "explosion" && explosionProfile) {
            const driftPhase = Math.sin((x * 0.038) + (i * 1.27));
            finalDetune = iv + (driftPhase * explosionProfile.flutterSemitones);
        } else if (brush === "xenakis") {
            const offset = i - 2; 
            const waveMod = Math.sin(x * 0.04 + offset * 1.5);
            finalDetune = (offset * 0.05) + (waveMod * 0.15); 
        } else if (brush === "chord") {
            finalDetune = iv;
        } else if (brush === "overtone") {
            currentFreq = baseFreq * iv; 
        } else if (brush === "rorschach" && i === 1) {
            // RORSCHACH FIX: 2. Stimme spielt die gespiegelte Frequenz ab
            let mirroredY = 100 - currentY;
            currentFreq = mapYToFrequency(mirroredY, 100);
            if (harmonizeCheckbox.checked) currentFreq = quantizeFrequency(currentFreq, scaleSelect.value);
        }

        const startFreq = ((brush === "explosion" && explosionProfile) || (brush === "evolve" && evolveProfile))
            ? currentFreq
            : currentFreq * Math.pow(2, finalDetune / 12);
        const voice = createWaveSource(audioCtx, track.wave, startFreq, track.noiseQ);
        const disconnectCalligraphySkew = connectCalligraphySkew(audioCtx, voice.output, oscVol, calligraphyAudioMod);
        oscVol.connect(targetNode);
        
        let mod = null, modGain = null;
        if (brush === "fm") {
            mod = audioCtx.createOscillator();
            mod.type = "sine"; 
            modGain = audioCtx.createGain();
            
            mod.frequency.setValueAtTime(startFreq * 2.14, audioCtx.currentTime);
            const size = track.curSeg ? (track.curSeg.thickness || 5) : 5;
            modGain.gain.setValueAtTime(startFreq * (size * 0.4), audioCtx.currentTime);
            
            mod.connect(modGain);
            modGain.connect(voice.frequencyParam); 
            mod.start();
        }

        voice.source.start(); 
        if (brush === "explosion" && explosionProfile && voice.frequencyParam) {
            const now = audioCtx.currentTime;
            const outwardFreq = currentFreq * Math.pow(2, finalDetune / 12);
            voice.frequencyParam.cancelScheduledValues(now);
            voice.frequencyParam.setValueAtTime(currentFreq, now);
            voice.frequencyParam.linearRampToValueAtTime(outwardFreq, now + explosionProfile.sweepSec);
        } else if (brush === "evolve" && evolveProfile && voice.frequencyParam) {
            const now = audioCtx.currentTime;
            const outwardFreq = currentFreq * Math.pow(2, finalDetune / 12);
            const branchDelay = evolveProfile.branchDelays[i] || 0;
            const sustainAt = now + branchDelay;
            voice.frequencyParam.cancelScheduledValues(now);
            voice.frequencyParam.setValueAtTime(currentFreq, now);
            voice.frequencyParam.setValueAtTime(currentFreq, sustainAt);
            voice.frequencyParam.linearRampToValueAtTime(outwardFreq, sustainAt + evolveProfile.branchSweepSec);
        }
        liveNodes.push({ voice, mod, modGain, disconnectCalligraphySkew });
    });
    
    const trackG = audioCtx.createGain(); 
    trackG.gain.value = 1.0;
    liveGainNode.connect(trackG); 
    connectTrackToFX(trackG, track.index); 
    liveGainNode.out = trackG;
}

function updateLiveSynth(track, x, y) {
    if (!liveGainNode) return;
    
    let currentY = y;
    const brush = brushSelect.value;
    if (brush === "fractal" && track.curSeg && track.curSeg.points.length > 0) {
        const fractalChaos = readModifierKnob("fractal-chaos", 0);
        const p = track.curSeg.points[track.curSeg.points.length - 1];
        currentY += (p.rY || 0) * 100 * fractalChaos;
    }
    const explosionProfile = (brush === "explosion")
        ? getExplosionAudioProfile(track.curSeg?.explosion || getCurrentExplosionModifier())
        : null;
    const evolveProfile = (brush === "evolve")
        ? getEvolveAudioProfile(track.curSeg?.evolve || getCurrentEvolveModifier())
        : null;

    let baseFreq = mapYToFrequency(currentY, 100); 
    if (harmonizeCheckbox.checked) baseFreq = quantizeFrequency(baseFreq, scaleSelect.value);
    
    liveNodes.forEach((n, i) => { 
        let finalDetune = 0;
        let currentFreq = baseFreq;

        if (brush === "evolve" && evolveProfile) {
            finalDetune = evolveProfile.detunes[i] || 0;
        } else if (brush === "explosion" && explosionProfile) {
            const driftPhase = Math.sin((x * 0.038) + (i * 1.27));
            finalDetune = (explosionProfile.detunes[i] || 0) + (driftPhase * explosionProfile.flutterSemitones);
        } else if (brush === "xenakis") {
            const offset = i - 2; 
            const waveMod = Math.sin(x * 0.04 + offset * 1.5);
            finalDetune = (offset * 0.05) + (waveMod * 0.15);
        } else if (brush === "chord") {
            const ivs = chordIntervals[chordSelect.value] || chordIntervals["major"];
            finalDetune = ivs[i] || 0;
        } else if (brush === "overtone") {
            const harmonic = i + 1; 
            currentFreq = baseFreq * harmonic;
        } else if (brush === "rorschach" && i === 1) {
            // RORSCHACH FIX: Auch beim Ziehen der Linie die gespiegelte Frequenz updaten
            let mirroredY = 100 - currentY;
            currentFreq = mapYToFrequency(mirroredY, 100);
            if (harmonizeCheckbox.checked) currentFreq = quantizeFrequency(currentFreq, scaleSelect.value);
        }
        
        const targetF = currentFreq * Math.pow(2, finalDetune / 12);
        if (brush === "explosion" && explosionProfile) {
            const now = audioCtx.currentTime;
            n.voice.cancelScheduledValues(now);
            n.voice.setValueAtTime(currentFreq, now);
            n.voice.linearRampToValueAtTime(targetF, now + explosionProfile.sweepSec);
        } else if (brush === "evolve" && evolveProfile) {
            const now = audioCtx.currentTime;
            const branchDelay = evolveProfile.branchDelays[i] || 0;
            n.voice.cancelScheduledValues(now);
            n.voice.setValueAtTime(currentFreq, now);
            n.voice.setValueAtTime(currentFreq, now + branchDelay);
            n.voice.linearRampToValueAtTime(targetF, now + branchDelay + evolveProfile.branchSweepSec);
        } else {
            n.voice.setTargetAtTime(targetF, audioCtx.currentTime, 0.02); 
        }

        if (brush === "fm" && n.mod && n.modGain) {
            n.mod.frequency.setTargetAtTime(targetF * 2.14, audioCtx.currentTime, 0.02);
            const size = track.curSeg ? (track.curSeg.thickness || 5) : 5;
            n.modGain.gain.setTargetAtTime(targetF * (size * 0.4), audioCtx.currentTime, 0.02);
        }
    });
}

function stopLiveSynth() {
    if (!liveGainNode) return;
    const gn = liveGainNode; 
    const ns = liveNodes; 
    const ls = liveShaper;
    const cg = liveCompGain;

    gn.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
    setTimeout(() => { 
        ns.forEach(n => { 
            try { 
                n.voice.source.stop();
                n.voice.disconnect();
                if (n.disconnectCalligraphySkew) n.disconnectCalligraphySkew();
                if (n.mod) { n.mod.stop(); n.mod.disconnect(); n.modGain.disconnect(); }
            } catch(e){} 
        }); 
        if (ls) ls.disconnect();
        if (cg) cg.disconnect();
        if (gn.out) gn.out.disconnect(); 
        gn.disconnect(); 
    }, 100);
    liveNodes = []; 
    liveGainNode = null;
    liveShaper = null;
    liveCompGain = null;
}

function triggerParticleGrain(track, y) { 
    const anySolo = tracks.some(t => t.solo);
    const isAudible = anySolo ? track.solo : !track.mute;
    if (!isAudible || track.vol < 0.01) return; 
    const bus = ensureParticleBus(track);
    if (!bus) return;

    let freq = mapYToFrequency(y, 100); 
    if(harmonizeCheckbox.checked) freq = quantizeFrequency(freq, scaleSelect.value); 
    const env = audioCtx.createGain(); const now = audioCtx.currentTime;
    env.gain.setValueAtTime(0, now); 
    env.gain.linearRampToValueAtTime(0.4, now + 0.01); 
    env.gain.exponentialRampToValueAtTime(0.01, now + 0.15); 

    const useSharedNoiseFilter = track.wave === "noise";
    const voice = useSharedNoiseFilter
        ? createParticleNoiseSource(audioCtx)
        : createWaveSource(audioCtx, track.wave, freq, track.noiseQ);

    if (useSharedNoiseFilter) {
        const sharedNoiseFilter = ensureParticleNoiseFilter(track, freq);
        if (!sharedNoiseFilter) return;
        voice.output.connect(env);
        env.connect(sharedNoiseFilter);
    } else {
        voice.output.connect(env).connect(bus.input);
    }

    voice.source.onended = () => {
        activeNodes.delete(voice.source);
        try { env.disconnect(); } catch(e) {}
        voice.disconnect();
    };
    voice.source.start(now); voice.source.stop(now + 0.2); 
    activeNodes.add(voice.source);
}

function scheduleTracks(start, targetCtx = audioCtx, targetDest = masterGain, offlineFX = null, playbackSnapshot = null, transportAnchorTime = null, sceneRole = null, sceneBoundaryId = null) {
    const playbackTracks = Array.isArray(playbackSnapshot?.tracks) && playbackSnapshot.tracks.length
        ? playbackSnapshot.tracks
        : tracks;
    const playbackSettings = playbackSnapshot?.settings || null;
    const harmonizeOn = playbackSettings ? !!playbackSettings.harmonize : !!harmonizeCheckbox.checked;
    const scaleMode = playbackSettings ? playbackSettings.scale : scaleSelect.value;
    const playbackMode = playbackSettings ? playbackSettings.pathMode : playbackPathMode;
    const drawOrderPlayback = isDrawOrderPlaybackModeFor(playbackMode);
    const localPlaybackDuration = Number(playbackSnapshot?.playbackDuration) > 0
        ? Number(playbackSnapshot.playbackDuration)
        : playbackDuration;
    const localGlobalSteps = Number(playbackSnapshot?.globalSteps) > 0
        ? Number(playbackSnapshot.globalSteps)
        : getGlobalLengthStepsForTracks(playbackTracks);
    const fractalChaos = Number(playbackSnapshot?.fx?.fractal?.chaos);
    const resolvedFractalChaos = Number.isFinite(fractalChaos) ? fractalChaos : readModifierKnob("fractal-chaos", 0);
    const anySolo = playbackTracks.some(tr => tr.solo);
    const liveScene = (targetCtx === audioCtx && sceneRole)
        ? { role: sceneRole, boundaryId: sceneBoundaryId || null, startTime: start, trackGains: new Array(tracks.length).fill(null) }
        : null;

    playbackTracks.forEach((track, trackIndex) => {
        const outputTrackIndex = Number.isFinite(track?.index) ? track.index : trackIndex;
        const trkG = targetCtx.createGain(); 
        trkG.gain.value = 1.0;
        let sharedParticleNoiseFilter = null;
        // Tolerances for loop seam continuity: live tracing rarely lands exactly on x=0/750.
        const seamStartThreshold = 12;
        const seamEndThreshold = 738;
        const segmentExtents = track.segments.map(seg => {
            const pts = Array.isArray(seg.points) ? seg.points : [];
            if (!pts.length) return null;
            let minX = Infinity;
            let maxX = -Infinity;
            pts.forEach(p => {
                const x = Number(p.x);
                if (!Number.isFinite(x)) return;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
            });
            if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
            return { minX, maxX };
        }).filter(Boolean);
        const hasLoopSeamContinuity = segmentExtents.some(ext => ext.minX <= seamStartThreshold)
            && segmentExtents.some(ext => ext.maxX >= seamEndThreshold);
        
        if (targetCtx === audioCtx) { 
            if (liveScene) liveScene.trackGains[outputTrackIndex] = trkG;
            connectTrackToFX(trkG, outputTrackIndex); 
        } else if (offlineFX) { 
            const isBypassed = !!track.bp;
            let dryVol = 1.0;
            const hasFilter = getMatrixStateByName("FILTER", outputTrackIndex);
            const hasStutter = getMatrixStateByName("STUTTER", outputTrackIndex);
            const hasTapeStop = getMatrixStateByName("TAPE STOP", outputTrackIndex);
            if (!isBypassed) {
                if (hasFilter) dryVol = 0.0;
                else if (hasStutter) dryVol = 1.0 - getKnobVal("STUTTER", "MIX");
            }
            const dryGain = targetCtx.createGain(); dryGain.gain.value = dryVol;
            trkG.connect(dryGain); dryGain.connect(targetDest);
            if (!isBypassed && getMatrixStateByName("DELAY", outputTrackIndex)) trkG.connect(offlineFX.delay);
            if (!isBypassed && getMatrixStateByName("VIBRATO", outputTrackIndex)) trkG.connect(offlineFX.vibrato);
            if (!isBypassed && getMatrixStateByName("REVERB", outputTrackIndex) && offlineFX.reverbInput) trkG.connect(offlineFX.reverbInput); 
            if (!isBypassed && hasFilter && offlineFX.filterInput) trkG.connect(offlineFX.filterInput);
            if (!isBypassed && hasStutter && offlineFX.stutter) {
                const stutterSend = targetCtx.createGain(); stutterSend.gain.value = getKnobVal("STUTTER", "MIX");
                trkG.connect(stutterSend); stutterSend.connect(offlineFX.stutter);
            }
            if (!isBypassed && hasTapeStop && offlineFX.tapestop) trkG.connect(offlineFX.tapestop);
        }

        const trackDuration = getTrackDuration(track, localPlaybackDuration, localGlobalSteps);
        const globalEnd = start + localPlaybackDuration;
        if (!isFinite(trackDuration) || trackDuration <= 0) return;
        const phaseAnchor = Number.isFinite(transportAnchorTime)
            ? transportAnchorTime
            : ((targetCtx === audioCtx && Number.isFinite(transportStartTime)) ? transportStartTime : start);
        const firstCycleIndex = Math.floor((start - phaseAnchor) / trackDuration);
        let firstCycleStart = phaseAnchor + (firstCycleIndex * trackDuration);
        while ((firstCycleStart + trackDuration) <= start + 0.0001) firstCycleStart += trackDuration;

        for (let cycleStart = firstCycleStart; cycleStart < globalEnd - 0.0001; cycleStart += trackDuration) {
            track.segments.forEach(seg => {
                const brush = seg.brush || "standard";
                const explosionProfile = (brush === "explosion")
                    ? getExplosionAudioProfile(seg.explosion || DEFAULT_EXPLOSION_MOD)
                    : null;
                const evolveProfile = (brush === "evolve")
                    ? getEvolveAudioProfile(seg.evolve || DEFAULT_EVOLVE_MOD)
                    : null;
                const rawPoints = Array.isArray(seg.points) ? seg.points.slice() : [];
                const playbackPoints = drawOrderPlayback
                    ? rawPoints
                    : rawPoints.slice().sort((a, b) => a.x - b.x);
                if (playbackPoints.length < 2 && brush !== "particles") return;
                
                if (brush === "particles") {
                    const particlePoints = drawOrderPlayback ? playbackPoints : rawPoints;
                    const ppCount = particlePoints.length;
                    const drawWindow = getDrawPlaybackWindowFromPoints(particlePoints, trackDuration);
                    const drawOffset = drawWindow.drawOffset;
                    const drawDuration = drawWindow.drawDuration;
                    particlePoints.forEach((p, pIndex) => {
                            const rawT = drawOrderPlayback
                                ? Math.max(0, cycleStart + drawOffset + ((ppCount > 1 ? (pIndex / (ppCount - 1)) : 0) * drawDuration))
                                : Math.max(0, cycleStart + (p.x / 750) * trackDuration);
                            const t = quantizeTrackTimeToGrid(track, cycleStart, rawT);
                            if (t < start - 0.0001 || t > globalEnd) return;
                        const env = targetCtx.createGain();
                        let f = mapYToFrequency(p.y, 100); if (harmonizeOn) f = quantizeFrequency(f, scaleMode);
                        const useSharedNoiseFilter = track.wave === "noise";
                        const voice = useSharedNoiseFilter
                            ? createParticleNoiseSource(targetCtx)
                            : createWaveSource(targetCtx, track.wave, f, track.noiseQ);
                        env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.4, t + 0.01); env.gain.exponentialRampToValueAtTime(0.01, t + 0.15); 
                        if (useSharedNoiseFilter) {
                            if (!sharedParticleNoiseFilter) {
                                sharedParticleNoiseFilter = targetCtx.createBiquadFilter();
                                sharedParticleNoiseFilter.type = "bandpass";
                                sharedParticleNoiseFilter.Q.value = Math.max(1, Math.min(18, track.noiseQ || 6));
                                sharedParticleNoiseFilter.frequency.value = 440;
                                sharedParticleNoiseFilter.connect(trkG);
                            }
                            sharedParticleNoiseFilter.frequency.setTargetAtTime(Math.max(30, Math.min(12000, f)), t, 0.01);
                            voice.output.connect(env);
                            env.connect(sharedParticleNoiseFilter);
                        } else {
                            voice.output.connect(env).connect(trkG);
                        }
                        voice.source.onended = () => { activeNodes.delete(voice.source); };
                        voice.source.start(t); voice.source.stop(Math.min(t + 0.2, globalEnd + 0.2)); 
                        if (targetCtx === audioCtx) activeNodes.add(voice.source);
                    });
                } else {
                    const ivs = (brush === "evolve") ? (evolveProfile?.detunes || [0]) :
                                (brush === "explosion") ? (explosionProfile?.detunes || [0]) :
                                (brush === "chord") ? (chordIntervals[seg.chordType || "major"] || chordIntervals["major"]) : 
                                (brush === "xenakis" ? [0, 1, 2, 3, 4] : 
                                (brush === "overtone" ? [1, 2, 3, 4, 5, 6] : 
                                (brush === "rorschach" ? [0, 1] : [0])));
                    
                    ivs.forEach((iv, i) => {
                        const oscVol = targetCtx.createGain();
                        oscVol.gain.value = (brush === "overtone") ? ((1 / iv) * 0.4) : ((brush === "explosion" && explosionProfile) ? explosionProfile.gainScale : ((brush === "evolve" && evolveProfile) ? evolveProfile.gainScale : 1)); 
                        const calligraphyAudioMod = (brush === "calligraphy")
                            ? getCalligraphyAudioModifier(seg.calligraphy || DEFAULT_CALLIGRAPHY_MOD)
                            : null;
                        
                        const g = targetCtx.createGain(); 
                        const voice = createWaveSource(targetCtx, track.wave, 440, track.noiseQ);
                        const disconnectCalligraphySkew = connectCalligraphySkew(targetCtx, voice.output, oscVol, calligraphyAudioMod);
                        
                        let shaper = null;
                        if (brush === "fractal") {
                            shaper = targetCtx.createWaveShaper();
                            const morphVal = readModifierKnob("fractal-morph", 0);
                            shaper.curve = getDistortionCurve(80 + (morphVal * 400));
                            shaper.oversample = '4x';
                            const compGain = targetCtx.createGain();
                            compGain.gain.value = 1.0 - (morphVal * 0.5); 
                            shaper.connect(compGain);
                            shaper.compGain = compGain; 
                            if (targetCtx === audioCtx) activeWaveShapers.push(shaper);
                        }

                        if (shaper) { oscVol.connect(shaper); shaper.compGain.connect(g); } 
                        else { oscVol.connect(g); }
                        g.connect(trkG); 

                        let mod = null, modGain = null;
                        if (brush === "fm" && !voice.isNoise) {
                            mod = targetCtx.createOscillator(); mod.type = "sine";
                            modGain = targetCtx.createGain();
                            mod.connect(modGain);
                            modGain.connect(voice.frequencyParam);
                        }

                        let tfPairs = [];
                        const ptCount = playbackPoints.length;
                        const drawWindow = getDrawPlaybackWindowFromPoints(playbackPoints, trackDuration);
                        const drawOffset = drawWindow.drawOffset;
                        const drawDuration = drawWindow.drawDuration;

                        playbackPoints.forEach((p, pIndex) => {
                            let cX = p.x, cY = p.y;
                            if (brush === "fractal") {
                                cX += (p.rX || 0) * 50 * resolvedFractalChaos; cY += (p.rY || 0) * 100 * resolvedFractalChaos;
                            }
                            const rawT = drawOrderPlayback
                                ? Math.max(0, cycleStart + drawOffset + ((ptCount > 1 ? (pIndex / (ptCount - 1)) : 0) * drawDuration))
                                : Math.max(0, cycleStart + (cX / 750) * trackDuration);
                            const t = quantizeTrackTimeToGrid(track, cycleStart, rawT);
                            if (t > globalEnd) return;
                            let f = mapYToFrequency(cY, 100); 
                            if (harmonizeOn) f = quantizeFrequency(f, scaleMode);
                            tfPairs.push({ t, f, cX, origY: p.y, rY: p.rY }); 
                        });
                        
                        if (!drawOrderPlayback) {
                            tfPairs.sort((a, b) => a.t - b.t);
                        }
                        if (tfPairs.length === 0) return;
                        
                        const firstBranchDelay = (brush === "evolve" && evolveProfile) ? Math.min(...evolveProfile.branchDelays) : 0;
                        const maxBranchDelay = (brush === "evolve" && evolveProfile) ? Math.max(...evolveProfile.branchDelays) : 0;
                        const sT = tfPairs[0].t + firstBranchDelay;
                        const eT = tfPairs[tfPairs.length - 1].t + maxBranchDelay + ((brush === "evolve" && evolveProfile) ? evolveProfile.branchSweepSec : 0);
                        if (sT > globalEnd || eT <= start) return;

                        let maxVol = (brush === "xenakis") ? 0.15 : (brush === "fractal" ? 0.2 : (brush === "rorschach" ? 0.2 : (brush === "overtone" ? 0.4 : (brush === "fm" ? 0.2 : 0.3))));
                        if (calligraphyAudioMod) maxVol *= calligraphyAudioMod.gainScale;
                        // If a segment starts near loop start, avoid attack ramp to prevent seam dips.
                        const seamStartTimeTolerance = Math.max(0.03, trackDuration * 0.02);
                        const startsAtLoopStart =
                            (tfPairs[0].cX <= seamStartThreshold) ||
                            ((sT - cycleStart) <= seamStartTimeTolerance);
                        const endsAtLoopEnd =
                            (tfPairs[tfPairs.length - 1].cX >= seamEndThreshold) ||
                            ((cycleStart + trackDuration - eT) <= seamStartTimeTolerance);
                        if (hasLoopSeamContinuity && startsAtLoopStart) {
                            g.gain.setValueAtTime(maxVol, sT);
                        } else {
                            g.gain.setValueAtTime(0, sT); 
                            g.gain.linearRampToValueAtTime(maxVol, sT + 0.02);
                        }
                        g.gain.setValueAtTime(maxVol, eT); 
                        if (hasLoopSeamContinuity && endsAtLoopEnd) {
                            const loopBoundary = Math.min(cycleStart + trackDuration, globalEnd);
                            g.gain.setValueAtTime(maxVol, loopBoundary);
                            g.gain.linearRampToValueAtTime(0, loopBoundary + 0.01);
                        } else {
                            g.gain.linearRampToValueAtTime(0, Math.min(eT + 0.1, globalEnd));
                        }
                        
                        tfPairs.forEach((pair, pairIndex) => {
                            let finalDetune = 0;
                            let playFreq = pair.f;

                            if (brush === "evolve" && evolveProfile) {
                                finalDetune = iv;
                            } else if (brush === "explosion" && explosionProfile) {
                                const driftPhase = Math.sin((pair.cX * 0.038) + (i * 1.27));
                                finalDetune = iv + (driftPhase * explosionProfile.flutterSemitones);
                            } else if (brush === "xenakis") {
                                const offset = i - 2;
                                const waveMod = Math.sin(pair.cX * 0.04 + offset * 1.5);
                                finalDetune = (offset * 0.05) + (waveMod * 0.15);
                            } else if (brush === "chord") {
                                finalDetune = iv;
                            } else if (brush === "overtone") {
                                playFreq = pair.f * iv;
                            } else if (brush === "rorschach" && i === 1) {
                                let mirroredY = 100 - pair.origY;
                                playFreq = mapYToFrequency(mirroredY, 100);
                                if (harmonizeOn) playFreq = quantizeFrequency(playFreq, scaleMode);
                            }

                            const targetF = playFreq * Math.pow(2, finalDetune / 12);
                            if (brush === "evolve" && evolveProfile) {
                                const branchDelay = evolveProfile.branchDelays[i] || 0;
                                const branchStart = pair.t + branchDelay;
                                const nextPair = tfPairs[Math.min(tfPairs.length - 1, pairIndex + 1)];
                                const maxSweep = nextPair && nextPair !== pair
                                    ? Math.max(0.008, ((nextPair.t + branchDelay) - branchStart) * 0.82)
                                    : evolveProfile.branchSweepSec;
                                const sweepSec = Math.min(evolveProfile.branchSweepSec, maxSweep);
                                try {
                                    voice.setValueAtTime(playFreq, branchStart);
                                    voice.linearRampToValueAtTime(targetF, branchStart + sweepSec);
                                } catch (e) {
                                    voice.setTargetAtTime(targetF, branchStart, Math.max(0.004, sweepSec * 0.5));
                                }
                            } else if (brush === "explosion" && explosionProfile) {
                                const nextPair = tfPairs[Math.min(tfPairs.length - 1, pairIndex + 1)];
                                const maxSweep = nextPair && nextPair !== pair
                                    ? Math.max(0.006, (nextPair.t - pair.t) * 0.8)
                                    : explosionProfile.sweepSec;
                                const sweepSec = Math.min(explosionProfile.sweepSec, maxSweep);
                                try {
                                    voice.setValueAtTime(playFreq, pair.t);
                                    voice.linearRampToValueAtTime(targetF, pair.t + sweepSec);
                                } catch (e) {
                                    voice.setTargetAtTime(targetF, pair.t, Math.max(0.003, sweepSec * 0.5));
                                }
                            } else {
                                try { voice.linearRampToValueAtTime(targetF, pair.t); } 
                                catch(e) { voice.setTargetAtTime(targetF, pair.t, 0.01); }
                            }

                            if (brush === "fm" && mod) {
                                const modF = targetF * 2.14;
                                const mIdx = targetF * ((seg.thickness || 5) * 0.4);
                                try {
                                    mod.frequency.linearRampToValueAtTime(modF, pair.t);
                                    modGain.gain.linearRampToValueAtTime(mIdx, pair.t);
                                } catch(e) {
                                    mod.frequency.setTargetAtTime(modF, pair.t, 0.01);
                                    modGain.gain.setTargetAtTime(mIdx, pair.t, 0.01);
                                }
                            }
                        });

                        const carryOverEligible = brush !== "evolve" && brush !== "explosion";
                        const voiceStartAt = Math.max(sT, start);
                        if (carryOverEligible && voiceStartAt > sT && tfPairs.length) {
                            const afterIndex = tfPairs.findIndex(pair => pair.t >= voiceStartAt);
                            const beforeIndex = afterIndex > 0 ? afterIndex - 1 : Math.max(0, tfPairs.length - 1);
                            const prevPair = tfPairs[Math.max(0, beforeIndex)];
                            const nextPair = afterIndex >= 0 ? tfPairs[afterIndex] : null;
                            let prevFreq = prevPair.f;
                            let nextFreq = nextPair ? nextPair.f : prevFreq;

                            if (brush === "xenakis") {
                                const offset = i - 2;
                                const prevWaveMod = Math.sin(prevPair.cX * 0.04 + offset * 1.5);
                                prevFreq = prevPair.f * Math.pow(2, (((offset * 0.05) + (prevWaveMod * 0.15)) / 12));
                                if (nextPair) {
                                    const nextWaveMod = Math.sin(nextPair.cX * 0.04 + offset * 1.5);
                                    nextFreq = nextPair.f * Math.pow(2, (((offset * 0.05) + (nextWaveMod * 0.15)) / 12));
                                }
                            } else if (brush === "chord") {
                                prevFreq = prevPair.f * Math.pow(2, iv / 12);
                                nextFreq = nextPair ? (nextPair.f * Math.pow(2, iv / 12)) : prevFreq;
                            } else if (brush === "overtone") {
                                prevFreq = prevPair.f * iv;
                                nextFreq = nextPair ? (nextPair.f * iv) : prevFreq;
                            } else if (brush === "rorschach" && i === 1) {
                                let mirroredY = 100 - prevPair.origY;
                                prevFreq = mapYToFrequency(mirroredY, 100);
                                if (harmonizeOn) prevFreq = quantizeFrequency(prevFreq, scaleMode);
                                if (nextPair) {
                                    let nextMirroredY = 100 - nextPair.origY;
                                    nextFreq = mapYToFrequency(nextMirroredY, 100);
                                    if (harmonizeOn) nextFreq = quantizeFrequency(nextFreq, scaleMode);
                                } else {
                                    nextFreq = prevFreq;
                                }
                            }

                            let carryFreq = prevFreq;
                            if (nextPair && nextPair !== prevPair && nextPair.t > prevPair.t && voiceStartAt > prevPair.t) {
                                const ratio = Math.max(0, Math.min(1, (voiceStartAt - prevPair.t) / (nextPair.t - prevPair.t)));
                                carryFreq = prevFreq + ((nextFreq - prevFreq) * ratio);
                            }
                            try { voice.setValueAtTime(carryFreq, voiceStartAt); } catch(e) {}
                            g.gain.cancelScheduledValues(voiceStartAt);
                            g.gain.setValueAtTime(maxVol, voiceStartAt);
                        }
                        
                        voice.updateChaos = (newChaos) => {
                            if (brush !== "fractal") return;
                            const now = targetCtx.currentTime;
                            voice.cancelScheduledValues(now); 
                            tfPairs.forEach(pair => {
                                if (pair.t >= now) {
                                    let cY = pair.origY + (pair.rY || 0) * 100 * newChaos;
                                    let f = mapYToFrequency(cY, 100);
                                    if (harmonizeOn) f = quantizeFrequency(f, scaleMode);
                                    try { voice.linearRampToValueAtTime(f, pair.t); } catch(e) { voice.setTargetAtTime(f, pair.t, 0.01); }
                                }
                            });
                        };
                        voice.source.updateChaos = voice.updateChaos;
                        
                        voice.source.onended = () => {
                            activeNodes.delete(voice.source);
                            disconnectCalligraphySkew();
                        };
                        voice.source.start(voiceStartAt); voice.source.stop(Math.min(eT + 0.2, globalEnd + 0.2)); 
                        if (mod) { mod.start(voiceStartAt); mod.stop(Math.min(eT + 0.2, globalEnd + 0.2)); }
                        if (targetCtx === audioCtx) activeNodes.add(voice.source);
                    });
                }
            });
        }
    });

    if (liveScene) {
        if (sceneRole === "scheduled") assignScheduledLiveScene(liveScene);
        else if (sceneRole === "current") assignCurrentLiveScene(liveScene);
        return liveScene;
    }
}

// SETUP DRAWING (inkl. MARQUEE SELECTION, SHIFT-TOGGLE, ALT-CLONE & GRID-SNAP)
function setupDrawing(track) {
    let drawing = false;
    let moving = false;
    let makingSelection = false;
    let hasClonedThisDrag = false; 
    let selStart = {x:0, y:0};
    let lastMousePos = { x: 0, y: 0 };
    let shiftPressedDuringSelection = false;
    let activeTouchId = null;
    let evolve2HoldTimer = null;
    let evolve2LatestPos = null;
    let evolve2PulseIndex = 0;
    let evolve2State = null;

    const stopEvolve2Hold = () => {
        if (evolve2HoldTimer) {
            clearInterval(evolve2HoldTimer);
            evolve2HoldTimer = null;
        }
    };

    const emitEvolve2Pulse = () => {
        if (!drawing || !track.curSeg || track.curSeg.brush !== "evolve2") return;
        const center = track.curSeg.points[0];
        if (!center) return;
        const evolveMod = track.curSeg.evolve || getCurrentEvolveModifier();
        const lengthNorm = Number.isFinite(evolveMod?.lengthNorm) ? evolveMod.lengthNorm : 0.55;
        const branchNorm = Number.isFinite(evolveMod?.branchNorm) ? evolveMod.branchNorm : (Number.isFinite(evolveMod?.timeNorm) ? evolveMod.timeNorm : 0.45);
        const pointer = evolve2LatestPos || center;
        const dx = pointer.x - center.x;
        const dy = pointer.y - center.y;
        const baseAngle = Math.atan2(dy || 0.0001, dx || 0.0001);
        if (!evolve2State) {
            const directionCount = 3 + Math.round(branchNorm * 13);
            evolve2State = {
                branches: Array.from({ length: directionCount }, (_, i) => {
                    const offset = (i / directionCount) * Math.PI * 2;
                    return {
                        id: i,
                        angle: baseAngle + offset,
                        offset,
                        radius: 0,
                        phase: (i + 1) * 0.91
                    };
                })
            };
        } else {
            const desiredCount = 3 + Math.round(branchNorm * 13);
            while (evolve2State.branches.length < desiredCount) {
                const i = evolve2State.branches.length;
                const offset = (i / desiredCount) * Math.PI * 2;
                evolve2State.branches.push({
                    id: i,
                    angle: baseAngle + offset,
                    offset,
                    radius: 0,
                    phase: (i + 1) * 0.91
                });
            }
        }
        const desiredCount = 3 + Math.round(branchNorm * 13);

        const pointerDist = Math.hypot(dx, dy);
        const stepLen = (track.curSeg.thickness || 5) * (0.7 + (lengthNorm * 9.5));
        const growthBoost = 1 + (pointerDist / Math.max(40, track.canvas.width * 0.08));
        const steeringStrength = 0.1 + (branchNorm * 0.1);
        const wanderAmount = 0.03 + (branchNorm * 0.12);
        const desiredRotation = baseAngle;
        const gridSize = getTrackGridStepSize(track);

        const wrapAngleDelta = (a, b) => {
            let d = a - b;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            return d;
        };

        for (const branch of evolve2State.branches.slice(0, desiredCount)) {
            const targetAngle = desiredRotation + branch.offset;
            const steerDelta = wrapAngleDelta(targetAngle, branch.angle);
            const sway = Math.sin((evolve2PulseIndex * 0.32) + branch.phase) * wanderAmount;
            branch.angle += (steerDelta * steeringStrength) + sway;
            branch.radius += stepLen * growthBoost * (0.88 + (0.12 * Math.sin(branch.phase + (evolve2PulseIndex * 0.41))));

            const rawX = center.x + (Math.cos(branch.angle) * branch.radius);
            const rawY = center.y + (Math.sin(branch.angle) * branch.radius);
            const endpointX = track.snap ? Math.round(rawX / gridSize) * gridSize : rawX;
            const endpointY = Math.max(0, Math.min(track.canvas.height, rawY));

            track.curSeg.points.push({
                x: Math.max(0, Math.min(track.canvas.width, endpointX)),
                y: endpointY,
                rX: Math.cos(branch.angle) * 0.5,
                rY: Math.sin(branch.angle) * 0.5,
                e2o: evolve2PulseIndex,
                e2b: branch.id
            });
        }

        evolve2PulseIndex += 1;
        redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
    };
    
    const start = e => {
        const isTouchEvent = e.type.startsWith("touch");
        if (isTouchEvent && activeTouchId !== null) return;
        if (isTouchEvent && e.changedTouches && e.changedTouches.length > 0) {
            activeTouchId = e.changedTouches[0].identifier;
        }
        e.preventDefault(); 
        initAudio(tracks, updateRoutingFromUI); 
        if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
        saveState(); 
        
        activeTrack = track; 
        hasClonedThisDrag = false;
        
        const pos = getPos(e, track.canvas, activeTouchId); 
        if (!pos) return;
        const gridX = getTrackGridStepSize(track);
        const x = track.snap ? Math.round(pos.x / gridX) * gridX : pos.x; 
        
        if (toolSelect.value === "draw") {
            drawing = true; 
            const rX = Math.random() - 0.5;
            const rY = Math.random() - 0.5;
            track.curSeg = { points: [{ x, y: pos.y, rX, rY }], ...buildSegmentMeta(brushSelect.value) };
            track.segments.push(track.curSeg); 
            redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            
            if (brushSelect.value === "particles") {
                triggerParticleGrain(track, pos.y);
                lastParticleTime = performance.now();
            } else if (brushSelect.value === "evolve2") {
                evolve2LatestPos = { x, y: pos.y };
                evolve2PulseIndex = 0;
                evolve2State = null;
                emitEvolve2Pulse();
                const intervalMs = 96;
                evolve2HoldTimer = setInterval(emitEvolve2Pulse, intervalMs);
                startLiveSynth(track, x, pos.y);
            } else {
                startLiveSynth(track, x, pos.y);
            }
        } else if (toolSelect.value === "erase") {
            erase(track, pos.x, pos.y); 
        } else if (toolSelect.value === "select") {
            let clickedSeg = null;
            for (let i = track.segments.length - 1; i >= 0; i--) {
                if (track.segments[i].points.some(p => Math.hypot(p.x - pos.x, p.y - pos.y) < 15)) {
                    clickedSeg = track.segments[i];
                    break;
                }
            }

            if (clickedSeg) {
                if (e.shiftKey) {
                    const idx = track.selectedSegments.indexOf(clickedSeg);
                    if (idx > -1) {
                        track.selectedSegments.splice(idx, 1);
                        moving = false; 
                    } else {
                        track.selectedSegments.push(clickedSeg);
                        moving = true;
                    }
                } else {
                    if (!track.selectedSegments.includes(clickedSeg)) {
                        track.selectedSegments = [clickedSeg];
                    }
                    moving = true;
                }
                lastMousePos = { x: x, y: pos.y };
                redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            } else {
                makingSelection = true;
                shiftPressedDuringSelection = e.shiftKey;
                if (!e.shiftKey) track.selectedSegments = [];
                selStart = { x: x, y: pos.y };
                track.selectionBox = { x: x, y: pos.y, w: 0, h: 0 };
                redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            }
        }
    };

    const move = e => {
        if (!drawing && toolSelect.value !== "erase" && !moving && !makingSelection) return; 
        const pos = getPos(e, track.canvas, activeTouchId); 
        if (!pos) return;
        const gridX = getTrackGridStepSize(track);
        const x = track.snap ? Math.round(pos.x / gridX) * gridX : pos.x; 
        
        if (drawing && track.curSeg) {
            if ((track.curSeg.brush || "standard") === "evolve2") {
                evolve2LatestPos = { x, y: pos.y };
                updateLiveSynth(track, x, pos.y);
                return;
            }
            const lastPt = track.curSeg.points[track.curSeg.points.length - 1];
            const dist = Math.hypot(x - lastPt.x, pos.y - lastPt.y);
            
            if (dist > 3) { 
                const rX = Math.random() - 0.5;
                const rY = Math.random() - 0.5;
                track.curSeg.points.push({ x, y: pos.y, rX, rY }); 
                redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
                
                if (brushSelect.value === "particles") {
                    const now = performance.now();
                    if (now - lastParticleTime > 16) {
                        triggerParticleGrain(track, pos.y);
                        lastParticleTime = now;
                    }
                } else {
                    updateLiveSynth(track, x, pos.y);
                }
            }
        } else if (toolSelect.value === "erase" && (e.buttons === 1 || e.type === "touchmove")) {
            erase(track, pos.x, pos.y); 
        } else if (toolSelect.value === "select") {
            if (makingSelection) {
                track.selectionBox.w = x - selStart.x;
                track.selectionBox.h = pos.y - selStart.y;
                redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            } else if (moving && (e.buttons === 1 || e.type === "touchmove")) {
                
                const dx = x - lastMousePos.x;
                const dy = pos.y - lastMousePos.y;
                
                if (dx !== 0 || dy !== 0) {
                    if (e.altKey && !hasClonedThisDrag) {
                        const clones = JSON.parse(JSON.stringify(track.selectedSegments));
                        track.segments.push(...clones);
                        track.selectedSegments = clones; 
                        hasClonedThisDrag = true;
                    }

                    track.selectedSegments.forEach(seg => {
                        seg.points.forEach(p => { p.x += dx; p.y += dy; });
                    });
                    
                    lastMousePos = { x: x, y: pos.y };
                    redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
                }
            }
        }
    };

    const stop = (e) => { 
        if (e && e.type && e.type.startsWith("touch") && activeTouchId !== null) {
            const changed = e.changedTouches;
            let endedActiveTouch = false;
            if (changed && changed.length) {
                for (let i = 0; i < changed.length; i++) {
                    if (changed[i].identifier === activeTouchId) {
                        endedActiveTouch = true;
                        break;
                    }
                }
            }
            if (!endedActiveTouch) return;
        }
        activeTouchId = null;
        if (drawing) { 
            stopEvolve2Hold();
            if (track.curSeg && track.curSeg.points.length === 1) {
                track.curSeg.points.push({
                    x: track.curSeg.points[0].x + 0.5, y: track.curSeg.points[0].y, 
                    rX: track.curSeg.points[0].rX, rY: track.curSeg.points[0].rY
                });
            }
            drawing = false; 
            track.curSeg = null; 
            evolve2LatestPos = null;
            evolve2PulseIndex = 0;
            evolve2State = null;
            stopLiveSynth(); 
            redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors); 
        }
        
        if (makingSelection) {
            makingSelection = false;
            if (track.selectionBox) {
                let bx = Math.min(selStart.x, selStart.x + track.selectionBox.w);
                let by = Math.min(selStart.y, selStart.y + track.selectionBox.h);
                let bw = Math.abs(track.selectionBox.w);
                let bh = Math.abs(track.selectionBox.h);
                
                const newlySelected = track.segments.filter(seg => 
                    seg.points.some(p => p.x >= bx && p.x <= bx + bw && p.y >= by && p.y <= by + bh)
                );
                
                if (shiftPressedDuringSelection) {
                    newlySelected.forEach(seg => {
                        if (!track.selectedSegments.includes(seg)) track.selectedSegments.push(seg);
                    });
                } else {
                    track.selectedSegments = newlySelected;
                }
                
                track.selectionBox = null;
                redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            }
        }
        
        if (moving) {
            moving = false;
            hasClonedThisDrag = false;
        }
    };

    track.canvas.addEventListener("mousedown", start); 
    track.canvas.addEventListener("mousemove", move); 
    window.addEventListener("mouseup", stop); 
    track.canvas.addEventListener("mouseleave", stop);
    track.canvas.addEventListener("touchstart", start, {passive:false}); 
    track.canvas.addEventListener("touchmove", move, {passive:false}); 
    track.canvas.addEventListener("touchend", stop);
    track.canvas.addEventListener("touchcancel", stop);
}

function erase(t, x, y) { 
    t.segments = t.segments.filter(s => !s.points.some(p => Math.hypot(p.x - x, p.y - y) < 20)); 
    redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors); 
}

function setupMainControls() {
    const helpBtn = document.getElementById("helpBtn");
    const helpOverlay = document.getElementById("help-overlay");
    
    // NEUER BLOCK: Asynchrones Laden der help.html
    if (helpBtn && helpOverlay) {
        helpBtn.addEventListener("click", async () => {
            if (helpOverlay.innerHTML.trim() === "") {
                try {
                    const response = await fetch('help.html');
                    const htmlText = await response.text();
                    helpOverlay.innerHTML = htmlText;
                    
                    const closeHelpBtn = document.getElementById("closeHelpBtn");
                    if (closeHelpBtn) closeHelpBtn.addEventListener("click", () => helpOverlay.style.display = "none");
                    
                    const langLinks = helpOverlay.querySelectorAll('.lang-link');
                    langLinks.forEach(link => {
                        link.addEventListener('click', (e) => {
                            langLinks.forEach(l => { l.classList.remove('active'); l.style.opacity = '0.5'; });
                            e.target.classList.add('active');
                            e.target.style.opacity = '1';
                            
                            const targetLang = e.target.dataset.lang;
                            helpOverlay.querySelectorAll('.help-lang-section').forEach(sec => {
                                sec.style.display = sec.id === `help-${targetLang}` ? 'block' : 'none';
                            });
                        });
                    });
                } catch (error) {
                    console.error("Fehler beim Laden der Hilfedatei:", error);
                    helpOverlay.innerHTML = '<div style="background:white; padding:40px; color:black; text-align:center;">Hilfe konnte nicht geladen werden.</div>';
                }
            }
            helpOverlay.style.display = "flex";
        });

        helpOverlay.addEventListener("click", (e) => { 
            if(e.target === helpOverlay) helpOverlay.style.display = "none"; 
        });
    }
    // ENDE NEUER BLOCK

    initMidiEngine("extSyncBtn", "midiInputSelect", {
        onToggle: (active) => {
            const bpmInput = document.getElementById("bpmInput");
            if (bpmInput) bpmInput.disabled = active;
            if (!active) updatePlaybackDuration();
        },
        onBpm: (exactBpm) => {
            updatePlaybackDuration(exactBpm);
            const bpmInput = document.getElementById("bpmInput");
            if (bpmInput) {
                const displayBpm = Math.round(exactBpm);
                if (bpmInput.value === "" || Math.abs(parseInt(bpmInput.value) - displayBpm) >= 1) {
                    bpmInput.value = displayBpm;
                }
            }
        },
        onStart: (syncInfo) => {
            if (syncInfo?.status === 251 && isPlaying) return;
            if (!isPlaying) {
                initAudio(tracks, updateRoutingFromUI); 
                applyAllFXFromUI(); 
                applyAllVolumes();
                if (audioCtx.state === "suspended") audioCtx.resume();
                updatePlaybackDuration();
                updateActiveMidiLoopSpan(getGlobalLengthSteps());
                const midiState = getMidiClockState();
                if (syncInfo?.status === 250) {
                    rebaseMidiLoopPhase(midiState.absoluteTickCount, getGlobalLengthSteps());
                } else if (!Number.isFinite(midiLoopAnchorTick)) {
                    rebaseMidiLoopPhase(midiState.absoluteTickCount, getGlobalLengthSteps());
                }
                const midiStartTime = midiTimestampMsToAudioTime(syncInfo?.timeStamp);
                playbackStartTime = Math.max(Number.isFinite(midiStartTime) ? midiStartTime : audioCtx.currentTime, audioCtx.currentTime + 0.003); 
                transportStartTime = playbackStartTime;
                isPlaying = true; 
                activeWaveShapers = []; 
                clearNextLoopSchedule();
                lastProcessedBoundaryId = null;
                scheduleTracks(playbackStartTime, audioCtx, masterGain, null, getActivePlaybackSnapshot(), transportStartTime, "current", null); 
                timerWorker.postMessage('start');
            }
        },
        onStop: () => {
            if (isPlaying) document.getElementById("stopButton").click();
        }
    });

    const bpmInput = document.getElementById("bpmInput");
    if (bpmInput) {
        const syncBpmToTransport = () => {
            updatePlaybackDuration();
            if (isPlaying) {
                clearNextLoopSchedule();
                scheduleUpcomingLoopIfNeeded();
            }
        };
        bpmInput.addEventListener("input", syncBpmToTransport);
        bpmInput.addEventListener("change", syncBpmToTransport);
    }

    let mediaRecorder = null;
    let recordedChunks = [];
    const recBtn = document.getElementById("recButton");
    
    if (recBtn) {
        recBtn.addEventListener("click", () => {
            if (!audioCtx) initAudio(tracks, updateRoutingFromUI);
            if (audioCtx.state === "suspended") audioCtx.resume();

            if (mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.stop();
                recBtn.innerHTML = '<span class="rec-dot"></span> REC';
                recBtn.style.color = ""; 
            } else {
                const dest = audioCtx.createMediaStreamDestination();
                (masterLimiter || masterGain).connect(dest);
                mediaRecorder = new MediaRecorder(dest.stream);
                recordedChunks = [];

                mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
                mediaRecorder.onstop = async () => {
                    recBtn.innerHTML = "⏳ Saving...";
                    const webmBlob = new Blob(recordedChunks, { type: "audio/webm" });
                    const arrayBuffer = await webmBlob.arrayBuffer();
                    const decodedAudio = await audioCtx.decodeAudioData(arrayBuffer);
                    const wavBlob = audioBufferToWav(decodedAudio);

                    const url = URL.createObjectURL(wavBlob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "pigeon_live_recording.wav";
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    (masterLimiter || masterGain).disconnect(dest);
                    recBtn.innerHTML = '<span class="rec-dot"></span> REC';
                };

                mediaRecorder.start();
                recBtn.innerHTML = "⏹ Stop Rec";
                recBtn.style.color = "#ff4444";
            }
        });
    }

    const exportWavBtn = document.getElementById("exportWavButton");
    if (exportWavBtn) exportWavBtn.addEventListener("click", async () => {
        if (isExportingWav) return;
        const wavFileName = pendingWavExportFileName || "pigeon_perfect_loop.wav";
        try {
            setExportBusyState(true);
            exportWavBtn.innerText = "⏳ Exporting...";

            const bpm = parseFloat(document.getElementById("bpmInput").value) || 120;
            const anySolo = tracks.some(t => t.solo);
            const activeTracks = tracks.filter(t => {
                if (t.mute) return false;
                return anySolo ? t.solo : true;
            });
            const maxSteps = activeTracks.length
                ? Math.max(1, ...activeTracks.map(t => t.lengthSteps || 32))
                : 32;
            const loopDur = (60 / bpm) * maxSteps;
            const sampleRate = audioCtx ? audioCtx.sampleRate : 44100;
            const lengthInSamples = Math.floor(sampleRate * loopDur);
            const offCtx = new OfflineAudioContext(2, lengthInSamples, sampleRate);
            
            const mDest = offCtx.createGain();
            const offLimiter = offCtx.createDynamicsCompressor();
            offLimiter.threshold.value = -1.0;
            offLimiter.knee.value = 0.0;
            offLimiter.ratio.value = 20.0;
            offLimiter.attack.value = 0.002;
            offLimiter.release.value = 0.12;
            mDest.connect(offLimiter);
            offLimiter.connect(offCtx.destination);
            
            const fxOff = {
                delay: offCtx.createDelay(), delayFbk: offCtx.createGain(),
                vibrato: offCtx.createDelay(), vibLfo: offCtx.createOscillator(), vibDepth: offCtx.createGain(),
                filter: offCtx.createBiquadFilter(), filterDrive: offCtx.createWaveShaper(),
                stutter: offCtx.createGain(), stutterLfo: offCtx.createOscillator(),
                tapestop: offCtx.createDelay(0.05), tapestopLfo: offCtx.createOscillator(),
                tapestopSmoother: offCtx.createBiquadFilter(), tapestopDepth: offCtx.createGain(),
                tapestopBase: offCtx.createConstantSource(), tapestopFlutterLfo: offCtx.createOscillator(),
                tapestopFlutterDepth: offCtx.createGain(), tapestopTone: offCtx.createBiquadFilter()
            };
            
            fxOff.delay.delayTime.value = getKnobVal("DELAY", "TIME") * 1.0;
            fxOff.delayFbk.gain.value = getKnobVal("DELAY", "FDBK") * 0.9;
            fxOff.delay.connect(fxOff.delayFbk); fxOff.delayFbk.connect(fxOff.delay);
            fxOff.delay.connect(mDest);
            
            fxOff.vibrato.delayTime.value = 0.03;
            fxOff.vibLfo.frequency.value = getKnobVal("VIBRATO", "RATE") * 20;
            fxOff.vibDepth.gain.value = getKnobVal("VIBRATO", "DEPTH") * 0.01;
            fxOff.vibLfo.connect(fxOff.vibDepth); fxOff.vibDepth.connect(fxOff.vibrato.delayTime);
            fxOff.vibLfo.start(0); fxOff.vibrato.connect(mDest);

            fxOff.reverbInput = offCtx.createGain();
            fxOff.reverbMix = offCtx.createGain();
            fxOff.reverbMix.gain.value = getKnobVal("REVERB", "MIX") * 1.5;
            fxOff.reverbFilter = offCtx.createBiquadFilter();
            fxOff.reverbFilter.type = 'lowpass';
            fxOff.reverbFilter.frequency.value = 2500;
            
            const revDecay = getKnobVal("REVERB", "DECAY") * 1.0 || 0.5;
            const duration = 0.1 + (revDecay * 4.0);
            const len = Math.floor(sampleRate * duration);
            const impulse = offCtx.createBuffer(2, len, sampleRate);
            for (let i = 0; i < 2; i++) {
                const chan = impulse.getChannelData(i);
                for (let j = 0; j < len; j++) chan[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 3);
            }
            fxOff.reverbConvolver = offCtx.createConvolver();
            fxOff.reverbConvolver.buffer = impulse;

            fxOff.reverbInput.connect(fxOff.reverbConvolver);
            fxOff.reverbConvolver.connect(fxOff.reverbFilter);
            fxOff.reverbFilter.connect(fxOff.reverbMix);
            fxOff.reverbMix.connect(mDest);

            fxOff.filter.type = 'lowpass';
            const fVal = getKnobVal("FILTER", "FREQ");
            const rVal = getKnobVal("FILTER", "RES");
            fxOff.filter.frequency.value = Math.pow(fVal, 3) * 22000;
            fxOff.filter.Q.value = rVal * 15;
            fxOff.filterDrive.curve = getDistortionCurve(rVal * 50); 
            fxOff.filterDrive.connect(fxOff.filter);
            fxOff.filter.connect(mDest);
            fxOff.filterInput = fxOff.filterDrive; 

            fxOff.stutter.gain.value = 0;
            fxOff.stutterLfo.type = 'square';
            fxOff.stutterLfo.frequency.value = (getKnobVal("STUTTER", "RATE") * 15) + 1;
            const stAmp = offCtx.createGain(); stAmp.gain.value = 0.5;
            const stOff = offCtx.createConstantSource(); stOff.offset.value = 0.5; stOff.start(0);
            fxOff.stutterLfo.connect(stAmp); stAmp.connect(fxOff.stutter.gain); stOff.connect(fxOff.stutter.gain);
            fxOff.stutterLfo.start(0);
            fxOff.stutter.connect(mDest);

            const tapeParams = getTapeStopParams(
                getTapeStopStopNorm(),
                getTapeStopStartNorm()
            );
            fxOff.tapestopLfo.type = "sawtooth";
            fxOff.tapestopLfo.frequency.value = tapeParams.normal.lfoHz;
            fxOff.tapestopSmoother.type = "lowpass";
            fxOff.tapestopSmoother.frequency.value = tapeParams.normal.smootherHz;
            fxOff.tapestopDepth.gain.value = tapeParams.normal.depthSec;
            fxOff.tapestopBase.offset.value = tapeParams.normal.baseSec;
            fxOff.tapestopFlutterLfo.type = "triangle";
            fxOff.tapestopFlutterLfo.frequency.value = tapeParams.normal.flutterHz;
            fxOff.tapestopFlutterDepth.gain.value = tapeParams.normal.flutterDepthSec;
            fxOff.tapestopTone.type = "lowpass";
            fxOff.tapestopTone.frequency.value = tapeParams.normal.toneHz;
            fxOff.tapestopTone.Q.value = 1.0;
            fxOff.tapestopLfo.connect(fxOff.tapestopSmoother);
            fxOff.tapestopSmoother.connect(fxOff.tapestopDepth);
            fxOff.tapestopDepth.connect(fxOff.tapestop.delayTime);
            fxOff.tapestopFlutterLfo.connect(fxOff.tapestopFlutterDepth);
            fxOff.tapestopFlutterDepth.connect(fxOff.tapestop.delayTime);
            fxOff.tapestopBase.connect(fxOff.tapestop.delayTime);
            fxOff.tapestopBase.start(0);
            fxOff.tapestopLfo.start(0);
            fxOff.tapestopFlutterLfo.start(0);
            fxOff.tapestop.connect(fxOff.tapestopTone);
            fxOff.tapestopTone.connect(mDest);

            scheduleTracks(0, offCtx, mDest, fxOff);
            
            const renderedBuffer = await offCtx.startRendering();
            const wavBlob = audioBufferToWav(renderedBuffer);
            
            const url = URL.createObjectURL(wavBlob);
            const a = document.createElement("a");
            a.href = url;
            a.download = wavFileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
        } catch(err) {
            console.error("Fehler beim Export:", err);
            alert("Es gab ein Problem beim Exportieren (siehe Konsole).");
        } finally {
            pendingWavExportFileName = null;
            exportWavBtn.innerText = "Export WAV";
            setExportBusyState(false);
        }
    });

    document.getElementById("playButton").addEventListener("click", () => {
        if (isPlaying) return; 
        document.getElementById("playButton").classList.add("is-active-ui");
        initAudio(tracks, updateRoutingFromUI); 
        applyAllFXFromUI(); 
        applyAllVolumes();
        if (audioCtx.state === "suspended") audioCtx.resume();
        updatePlaybackDuration();
        updateActiveMidiLoopSpan(getGlobalLengthSteps());
        playbackStartTime = audioCtx.currentTime + 0.05; 
        transportStartTime = playbackStartTime;
        isPlaying = true; 
        activeWaveShapers = []; 
        clearNextLoopSchedule();
        lastProcessedBoundaryId = null;
        scheduleTracks(playbackStartTime, audioCtx, masterGain, null, null, transportStartTime, "current", null); 
        timerWorker.postMessage('start');
    });
    
    document.getElementById("stopButton").addEventListener("click", () => {
        document.getElementById("playButton").classList.remove("is-active-ui");
        stopTapeStopTrigger(false, true);
        isPlaying = false; 
        timerWorker.postMessage('stop');
        clearNextLoopSchedule();
        lastProcessedBoundaryId = null;
        queuedPattern = null;
        queuedPresetBank = null;
        activeNodes.forEach(n => { try { n.stop(); n.disconnect(); } catch (e) { } });
        activeNodes.clear(); 
        activeWaveShapers = []; 
        disconnectLiveScene(currentLiveScene);
        disconnectLiveScene(scheduledLiveScene);
        currentLiveScene = null;
        scheduledLiveScene = null;
        tracks.forEach(t => {
            t.gainNode = null;
            t.scheduledGainNode = null;
            redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
        });
        pigeonImg.style.transform = "scale(1)"; 
        document.querySelectorAll(".pad.queued").forEach(p => p.classList.remove("queued")); 
    });
    
    document.getElementById("undoButton").addEventListener("click", () => { 
        if (undoStack.length > 0) { 
            const currentStateStr = JSON.stringify(tracks.map(t => t.segments));
            const stateStr = undoStack.pop(); 
            try {
                const state = JSON.parse(stateStr);
                tracks.forEach((t, i) => {
                    t.segments = JSON.parse(JSON.stringify(state[i] || []));
                    t.selectedSegments = [];
                    redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
                });
                redoStack.push(currentStateStr);
                if (redoStack.length > HISTORY_STACK_LIMIT) redoStack.shift();
            } catch (err) {
                console.warn("Undo konnte nicht angewendet werden:", err);
            }
        } 
    });

    document.getElementById("redoButton").addEventListener("click", () => {
        if (redoStack.length > 0) {
            const currentStateStr = JSON.stringify(tracks.map(t => t.segments));
            const stateStr = redoStack.pop();
            try {
                const state = JSON.parse(stateStr);
                tracks.forEach((t, i) => {
                    t.segments = JSON.parse(JSON.stringify(state[i] || []));
                    t.selectedSegments = [];
                    redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
                });
                undoStack.push(currentStateStr);
                if (undoStack.length > HISTORY_STACK_LIMIT) undoStack.shift();
            } catch (err) {
                console.warn("Redo konnte nicht angewendet werden:", err);
            }
        }
    });
    
    document.getElementById("clearButton").addEventListener("click", () => { 
        saveState();
        tracks.forEach(t => {
            t.segments = [];
            t.selectedSegments = [];
            redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
        }); 
    });
    
    harmonizeCheckbox.addEventListener("change", () => {
        scaleSelect.classList.toggle("is-active-ui", !!harmonizeCheckbox.checked);
    });
    scaleSelect.classList.toggle("is-active-ui", !!harmonizeCheckbox.checked);

}

function setupPads() {
    document.querySelectorAll(".pad").forEach(pad => {
        pad.addEventListener("click", () => {
            const bank = pad.dataset.bank;
            const idx = parseInt(pad.dataset.idx, 10);
            if (!bank || Number.isNaN(idx)) return;
            if (consumeSlotTargetPick(bank, idx)) return;
            const hasPattern = !!(patternBanks[bank] && patternBanks[bank][idx]);
            const selectedPatternData = hasPattern
                ? patternBanks[bank][idx]
                : createEmptyPatternSnapshotFromCurrentState();

            if (isPlaying) {
                queuedPattern = { data: selectedPatternData, pad };
                killPreScheduledFutureTrackGraph();
                // Force next boundary to schedule from queued state, not from stale pre-schedule.
                clearNextLoopSchedule();
                document.querySelectorAll(".pad.queued").forEach(p => p.classList.remove("queued"));
                pad.classList.add("queued");
                return;
            }

            loadPatternData(selectedPatternData);
            activatePatternPad(bank, idx, false);
        });
    });
}

function getLinkedFX() {
    ensureFxDomIndex();
    const links = document.querySelectorAll('.fx-xy-link.active');
    let linked = [];
    links.forEach(l => {
        const unit = l.closest(".fx-unit");
        if (!unit) return;
        const fxKey = unit.dataset.fxKey || null;
        if (fxKey && fxKey !== "tapestop") linked.push(fxKey);
    });
    return linked;
}

function isTapeStopEnabled() {
    return tapeStopState !== TAPE_STOP_STATE.BYPASS;
}

function setupTracePad() {
    const crosshair = document.getElementById("trace-crosshair");
    const chH = crosshair ? crosshair.querySelector(".ch-h") : null;
    const chV = crosshair ? crosshair.querySelector(".ch-v") : null;

    let traceTouchId = null;
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const getPadPos = (e) => { 
        const r = tracePad.getBoundingClientRect(); 
        const point = getClientPointFromEvent(e, traceTouchId);
        if (!point) return { x: 0, y: 0 };
        const cx = point.x;
        const cy = point.y;
        
        if (chH && chV) {
            const visualX = cx - r.left;
            const visualY = cy - r.top;
            if (visualX >= 0 && visualX <= r.width && visualY >= 0 && visualY <= r.height) {
                chV.style.left = visualX + "px";
                chH.style.top = visualY + "px";
            }
        }
        const nx = clamp((cx - r.left) / Math.max(1, r.width), 0, 1);
        const ny = clamp((cy - r.top) / Math.max(1, r.height), 0, 1);
        return { x: nx * 750, y: ny * 100 }; 
    };
    const getSynchronizedTraceX = () => {
        if (!audioCtx || !isPlaying) return 0;
        const targetTrack = tracks[currentTargetTrack];
        if (!targetTrack) return 0;
        const transportElapsed = getTransportElapsedTime(audioCtx.currentTime);
        return getTrackHeadX(targetTrack, transportElapsed);
    };
    
    tracePad.addEventListener("mouseenter", () => { if(crosshair) crosshair.style.display = "block"; });
    tracePad.addEventListener("mouseleave", () => { if(crosshair) crosshair.style.display = "none"; });

    tracePad.addEventListener("mousedown", e => {
        e.preventDefault(); if (!isPlaying) return; initAudio(tracks, updateRoutingFromUI); isTracing = true; const pos = getPadPos(e); traceCurrentY = pos.y;
        lastTraceTrackX = null;
        clearNextLoopSchedule();
        saveState(); isEffectMode = document.querySelectorAll('.fx-xy-link.active').length > 0;
        
        if (!isEffectMode) { 
            const currentX = getSynchronizedTraceX();
            const rX = Math.random() - 0.5; const rY = Math.random() - 0.5;
            traceCurrentSeg = { points: [{ x: currentX, y: traceCurrentY, rX, rY }], ...buildSegmentMeta(brushSelect.value) }; 
            tracks[currentTargetTrack].segments.push(traceCurrentSeg); 
            lastTraceTrackX = currentX;
            if (brushSelect.value === "particles") triggerParticleGrain(tracks[currentTargetTrack], traceCurrentY); 
            else startLiveSynth(tracks[currentTargetTrack], currentX, traceCurrentY); 
        } else { traceCurrentSeg = null; }
    });
    
    tracePad.addEventListener("mousemove", e => { 
        if(crosshair && !e.touches) getPadPos(e); 
        if (isTracing) { 
            const pos = getPadPos(e); traceCurrentY = pos.y; 
            if (!isEffectMode) {
                if (brushSelect.value !== "particles") {
                    const localX = getSynchronizedTraceX();
                    updateLiveSynth(tracks[currentTargetTrack], localX, traceCurrentY);
                }
            } 
        } 
    });
    
    window.addEventListener("mouseup", () => { 
        if (isTracing) {
            finalizeTraceSegmentIfNeeded();
            if (!isEffectMode) stopLiveSynth();
            isTracing = false;
            lastTraceTrackX = null;
            clearNextLoopSchedule();
            traceCurrentSeg = null;
            scheduleUpcomingLoopIfNeeded();
            redrawTrack(tracks[currentTargetTrack], undefined, brushSelect.value, chordIntervals, chordColors);
        } 
    });
    
    tracePad.addEventListener("touchstart", (e) => {
        if (traceTouchId === null && e.changedTouches && e.changedTouches.length > 0) {
            traceTouchId = e.changedTouches[0].identifier;
        }
        if(crosshair) crosshair.style.display = "block";
    }, {passive: false});
    tracePad.addEventListener("touchend", (e) => {
        if (traceTouchId !== null) {
            const changed = e.changedTouches;
            let endedActiveTouch = false;
            if (changed && changed.length) {
                for (let i = 0; i < changed.length; i++) {
                    if (changed[i].identifier === traceTouchId) {
                        endedActiveTouch = true;
                        break;
                    }
                }
            }
            if (!endedActiveTouch) return;
        }
        traceTouchId = null;
        if(crosshair) crosshair.style.display = "none";
        if (isTracing) {
            finalizeTraceSegmentIfNeeded();
            if (!isEffectMode) stopLiveSynth();
            isTracing = false;
            lastTraceTrackX = null;
            clearNextLoopSchedule();
            traceCurrentSeg = null;
            scheduleUpcomingLoopIfNeeded();
            redrawTrack(tracks[currentTargetTrack], undefined, brushSelect.value, chordIntervals, chordColors);
        }
    });
    tracePad.addEventListener("touchcancel", () => {
        traceTouchId = null;
        if(crosshair) crosshair.style.display = "none";
    });

    document.querySelectorAll(".picker-btn").forEach(btn => btn.addEventListener("click", () => { document.querySelectorAll(".picker-btn").forEach(b => b.classList.remove("active")); btn.classList.add("active"); currentTargetTrack = parseInt(btn.dataset.target); }));
    
    document.getElementById("traceClearBtn").addEventListener("click", () => { saveState(); tracks[currentTargetTrack].segments = []; redrawTrack(tracks[currentTargetTrack], undefined, brushSelect.value, chordIntervals, chordColors); });
}

function setupFX() {
    buildFxDomIndex();
    document.querySelectorAll('.knob:not(.modify-knob)').forEach(knob => {
        setupKnob(knob, (val) => {
            if (!audioCtx) return; 
            const unit = knob.closest('.fx-unit');
            if (!unit) return;
            const fxKey = unit.dataset.fxKey || null;
            if (!fxKey || !knob.nextElementSibling) return;
            const param = knob.nextElementSibling.textContent.trim();
            
            if (fxKey === "delay") { 
                if (param === "TIME") fxNodes.delay.node.delayTime.setTargetAtTime(val * 1.0, audioCtx.currentTime, 0.05); 
                if (param === "FDBK") fxNodes.delay.feedback.gain.setTargetAtTime(val * 0.9, audioCtx.currentTime, 0.05); 
            }
            else if (fxKey === "reverb") {
                if (param === "MIX") fxNodes.reverb.mix.gain.setTargetAtTime(val * 1.5, audioCtx.currentTime, 0.05);
                if (param === "DECAY") updateReverbDecay(val); 
            }
            else if (fxKey === "vibrato") { 
                if (param === "RATE") fxNodes.vibrato.lfo.frequency.setTargetAtTime(val * 20, audioCtx.currentTime, 0.05); 
                if (param === "DEPTH") fxNodes.vibrato.depthNode.gain.setTargetAtTime(val * 0.01, audioCtx.currentTime, 0.05); 
            }
            else if (fxKey === "filter" && fxNodes.filter && fxNodes.filter.node1) {
                if (param === "FREQ") {
                    const cutoff = Math.pow(val, 3) * 22000;
                    fxNodes.filter.node1.frequency.setTargetAtTime(cutoff, audioCtx.currentTime, 0.05);
                    fxNodes.filter.node2.frequency.setTargetAtTime(cutoff, audioCtx.currentTime, 0.05);
                }
                if (param === "RES") {
                    fxNodes.filter.node1.Q.setTargetAtTime(val * 15, audioCtx.currentTime, 0.05);
                    fxNodes.filter.node2.Q.setTargetAtTime(val * 15, audioCtx.currentTime, 0.05);
                }
            }
            else if (fxKey === "stutter" && fxNodes.stutter) {
                if (param === "RATE") fxNodes.stutter.lfo.frequency.setTargetAtTime((val * 15) + 1, audioCtx.currentTime, 0.05);
                if (param === "MIX") updateRoutingFromUI();
            }
            else if (fxKey === "tapestop" && fxNodes.tapestop) {
                applyTapeStopFromUI(
                    getTapeStopStopNorm(),
                    getTapeStopStartNorm()
                );
            }
            else if (fxKey === "fractal") {
                if (param === "MORPH") {
                    applyFractalMorphRealtime(val);
                }
                if (param === "CHAOS") {
                    applyFractalChaosRealtime(val);
                }
            }
        });
    });
    document.querySelectorAll('.matrix-btn').forEach(btn => btn.addEventListener('click', () => { if (!audioCtx) initAudio(tracks, updateRoutingFromUI); btn.classList.toggle('active'); updateRoutingFromUI(); }));
    document.querySelectorAll('.fx-xy-link').forEach(btn => btn.addEventListener('click', () => btn.classList.toggle('active')));
    document.querySelectorAll('.fx-enable-btn--tapestop').forEach(btn => {
        btn.textContent = 'TRG';
        btn.classList.remove('active');
        const releaseTrigger = () => stopTapeStopTrigger(true, true);
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (!audioCtx) initAudio(tracks, updateRoutingFromUI);
            startTapeStopTriggerHold(
                getTapeStopStopNorm(),
                getTapeStopStartNorm()
            );
            window.addEventListener('pointerup', releaseTrigger, { once: true });
            window.addEventListener('pointercancel', releaseTrigger, { once: true });
        });
        btn.addEventListener('pointerleave', (e) => {
            if ((e.buttons & 1) === 1) return;
            if (isTapeStopEnabled()) releaseTrigger();
        });
    });
}

function updateRoutingFromUI() {
    ensureFxDomIndex();
    if (!audioCtx) return;
    const tapeEnabled = isTapeStopEnabled();
    const tapeStopActive = [];
    const filterActive = []; const stutterActive = [];
    Object.entries(fxDomIndex).forEach(([fxName, fxEntry]) => {
        if (!fxEntry) return;
        fxEntry.matrixButtons.forEach((btn, idx) => { 
            if (!btn) return;
            const active = btn.classList.contains('active');
            const routed = active && !(tracks[idx] && tracks[idx].bp);
            if(trackSends[idx] && trackSends[idx][fxName]){
                if (fxName === "stutter") {
                    stutterActive[idx] = routed;
                    trackSends[idx].stutter.gain.setTargetAtTime(routed ? getKnobVal("STUTTER", "MIX") : 0, audioCtx.currentTime, 0.05);
                } else if (fxName === "filter") {
                    filterActive[idx] = routed;
                    trackSends[idx].filter.gain.setTargetAtTime(routed ? 1 : 0, audioCtx.currentTime, 0.05);
                } else {
                    const isRouted = (fxName === "tapestop") ? (routed && tapeEnabled) : routed;
                    if (fxName === "tapestop") tapeStopActive[idx] = isRouted;
                    trackSends[idx][fxName].gain.setTargetAtTime(isRouted ? 1 : 0, audioCtx.currentTime, 0.05); 
                }
            }
        });
        if (fxEntry.led) {
            const hasMatrixRoute = fxEntry.matrixButtons.some(btn => btn && btn.classList.contains("active"));
            const isOn = (fxName === "tapestop") ? (hasMatrixRoute && tapeEnabled) : hasMatrixRoute;
            fxEntry.led.classList.toggle('on', isOn);
        }
    });

    tracks.forEach((track, idx) => {
        if (trackSends[idx] && trackSends[idx].dry) {
            let dryVol = 1.0;
            if (!track.bp) {
                if (tapeStopActive[idx]) dryVol = 0.0;
                else if (filterActive[idx]) dryVol = 0.0; 
                else if (stutterActive[idx]) { dryVol = 1.0 - getKnobVal("STUTTER", "MIX"); }
            }
            trackSends[idx].dry.gain.setTargetAtTime(dryVol, audioCtx.currentTime, 0.05);
        }
    });
}

function loop() {
    if (!isPlaying) return; 
    scheduleUpcomingLoopIfNeeded();
    let elapsed = audioCtx.currentTime - playbackStartTime;
    let transportElapsed = getTransportElapsedTime(audioCtx.currentTime);

    const boundaryInfo = getUpcomingLoopBoundaryInfo();
    const boundaryTime = nextLoopScheduledFor !== null ? nextLoopScheduledFor : boundaryInfo?.time;
    const boundaryId = nextLoopScheduledBoundaryId !== null ? nextLoopScheduledBoundaryId : boundaryInfo?.id;
    const boundaryProcessKey = getBoundaryProcessKey(boundaryInfo, boundaryId);
    const boundaryReached = Number.isFinite(boundaryTime)
        ? (audioCtx.currentTime >= (boundaryTime - (midiSyncActive ? 0.002 : 0))) && (boundaryProcessKey !== lastProcessedBoundaryId)
        : (elapsed >= playbackDuration);

    if (boundaryReached) {
        const oldDuration = playbackDuration; 
        const boundaryTick = Number(boundaryInfo?.boundaryTick);
        let patternChangedAtBoundary = false;
        const hadPreScheduledForBoundary = Number.isFinite(boundaryTime)
            && nextLoopScheduledFor !== null
            && nextLoopScheduledBoundaryId !== null
            && nextLoopScheduledBoundaryId === boundaryId;

        if (queuedPresetBank) {
            if (!applyLoadedBankPayload(queuedPresetBank)) {
                console.warn("Queued preset bank konnte nicht angewendet werden.");
            }
            queuedPresetBank = null;
            patternChangedAtBoundary = true;
        }
        if (queuedPattern) {
            loadPatternData(queuedPattern.data);
            document.querySelectorAll(".pad").forEach(p => p.classList.remove("active", "queued"));
            queuedPattern.pad.classList.add("active");
            queuedPattern = null;
            patternChangedAtBoundary = true;
        }
        if (document.getElementById("loopCheckbox").checked) { 
            if (boundaryProcessKey) lastProcessedBoundaryId = boundaryProcessKey;
            playbackStartTime = Number.isFinite(boundaryTime) ? boundaryTime : (playbackStartTime + oldDuration);
            if (patternChangedAtBoundary) transportStartTime = playbackStartTime;
            if (midiSyncActive && Number.isFinite(boundaryTick)) {
                rebaseMidiLoopPhase(boundaryTick, getGlobalLengthSteps());
            }
            activeWaveShapers = [];
            elapsed = audioCtx.currentTime - playbackStartTime;
            transportElapsed = getTransportElapsedTime(audioCtx.currentTime);
            if (patternChangedAtBoundary && hadPreScheduledForBoundary) {
                killPreScheduledFutureTrackGraph();
            } else if (hadPreScheduledForBoundary) {
                promoteScheduledTrackGraph();
            }
            clearNextLoopSchedule();
            if (!hadPreScheduledForBoundary || patternChangedAtBoundary) {
                scheduleTracks(
                    Math.max(playbackStartTime, audioCtx.currentTime + 0.003),
                    audioCtx,
                    masterGain,
                    null,
                    getActivePlaybackSnapshot(),
                    transportStartTime,
                    "current",
                    boundaryId
                );
            }
            scheduleUpcomingLoopIfNeeded(true);
            if (isTracing && traceCurrentSeg) { saveState(); traceCurrentSeg = { points: [], ...buildSegmentMeta(brushSelect.value) }; tracks[currentTargetTrack].segments.push(traceCurrentSeg); } 
        } else {
            isPlaying = false;
            document.getElementById("playButton")?.classList.remove("is-active-ui");
            return;
        }
    }
    
    const xGlobal = (elapsed / playbackDuration) * 750; 
    const targetTrack = tracks[currentTargetTrack];
    const targetLocalX = targetTrack ? getTrackHeadX(targetTrack, transportElapsed) : xGlobal;
    if (isTracing && !isEffectMode && traceCurrentSeg) { 
        if (lastTraceTrackX !== null && targetLocalX < (lastTraceTrackX - 100)) {
            saveState();
            // Seam bridge: close previous segment at loop end and start new one at loop start
            // so held notes remain continuous after releasing live tracing.
            const prevSeg = traceCurrentSeg;
            const prevPts = Array.isArray(prevSeg.points) ? prevSeg.points : [];
            if (prevPts.length > 0) {
                const lastPt = prevPts[prevPts.length - 1];
                const endPt = { x: 750, y: traceCurrentY, rX: (lastPt.rX ?? 0), rY: (lastPt.rY ?? 0) };
                if ((lastPt.x ?? 0) < 749) prevPts.push(endPt);
            }

            traceCurrentSeg = {
                points: [{ x: 0, y: traceCurrentY, rX: Math.random() - 0.5, rY: Math.random() - 0.5 }],
                ...buildSegmentMeta(brushSelect.value)
            };
            tracks[currentTargetTrack].segments.push(traceCurrentSeg);
        }
        const rX = Math.random() - 0.5; const rY = Math.random() - 0.5; traceCurrentSeg.points.push({ x: targetLocalX, y: traceCurrentY, rX, rY }); 
        lastTraceTrackX = targetLocalX;
        if (brushSelect.value === "particles") triggerParticleGrain(tracks[currentTargetTrack], traceCurrentY);
    }

    if (isTracing && audioCtx && isEffectMode) {
        const linkedFX = getLinkedFX(); const normX = targetLocalX / 750; const normY = 1.0 - (traceCurrentY / 100); 
        linkedFX.forEach(fx => {
            if(fx === "delay" && fxNodes.delay.node) { fxNodes.delay.node.delayTime.setTargetAtTime(normX * 1.0, audioCtx.currentTime, 0.05); fxNodes.delay.feedback.gain.setTargetAtTime(normY * 0.9, audioCtx.currentTime, 0.05); }
            if(fx === "vibrato" && fxNodes.vibrato.lfo) { fxNodes.vibrato.lfo.frequency.setTargetAtTime(normX * 20, audioCtx.currentTime, 0.05); fxNodes.vibrato.depthNode.gain.setTargetAtTime(normY * 0.01, audioCtx.currentTime, 0.05); }
            if(fx === "reverb" && fxNodes.reverb.mix) { fxNodes.reverb.mix.gain.setTargetAtTime(normY * 1.5, audioCtx.currentTime, 0.05); updateReverbDecay(normX); }
            if(fx === "filter" && fxNodes.filter && fxNodes.filter.node1) { const cutoff = Math.pow(normX, 3) * 22000; fxNodes.filter.node1.frequency.setTargetAtTime(cutoff, audioCtx.currentTime, 0.05); fxNodes.filter.node2.frequency.setTargetAtTime(cutoff, audioCtx.currentTime, 0.05); fxNodes.filter.node1.Q.setTargetAtTime(normY * 15, audioCtx.currentTime, 0.05); fxNodes.filter.node2.Q.setTargetAtTime(normY * 15, audioCtx.currentTime, 0.05); }
            if(fx === "stutter" && fxNodes.stutter) {
                fxNodes.stutter.lfo.frequency.setTargetAtTime((normX * 15) + 1, audioCtx.currentTime, 0.05);
                const stutterEntry = fxDomIndex.stutter;
                const stutterKnobs = stutterEntry ? stutterEntry.knobs : [];
                if (stutterKnobs[1]) { stutterKnobs[1].dataset.val = normY; stutterKnobs[1].style.transform = `rotate(${-135 + (normY * 270)}deg)`; }
                updateRoutingFromUI();
            }
            if(fx === "tapestop" && fxNodes.tapestop) {
                const tapeEntry = fxDomIndex.tapestop;
                const tapeKnobs = tapeEntry ? tapeEntry.knobs : [];
                if (tapeKnobs[0]) { tapeKnobs[0].dataset.val = normX; tapeKnobs[0].style.transform = `rotate(${-135 + (normX * 270)}deg)`; }
                if (tapeKnobs[1]) { tapeKnobs[1].dataset.val = normY; tapeKnobs[1].style.transform = `rotate(${-135 + (normY * 270)}deg)`; }
                applyTapeStopFromUI(normX, normY);
            }
            if(fx === "fractal") {
                setKnobVisual(document.querySelector('.modify-knob[data-mod="fractal-chaos"]'), normX);
                setKnobVisual(document.querySelector('.modify-knob[data-mod="fractal-morph"]'), normY);
                applyFractalMorphRealtime(normY);
                applyFractalChaosRealtime(normX);
            }
        });
    }
    
    const drawModeScan = isDrawOrderPlaybackMode();
    tracks.forEach(t => {
        const forceBase = !!(isTracing && !isEffectMode && t.index === currentTargetTrack);
        if (drawModeScan) {
            const trackDuration = getTrackDuration(t);
            const localElapsed = (isFinite(trackDuration) && trackDuration > 0)
                ? (((transportElapsed % trackDuration) + trackDuration) % trackDuration)
                : 0;
            redrawTrack(
                t,
                { mode: "draw", localElapsed, trackDuration, forceBase },
                brushSelect.value,
                chordIntervals,
                chordColors
            );
        } else {
            const trackDuration = getTrackDuration(t);
            const localElapsed = (isFinite(trackDuration) && trackDuration > 0)
                ? (((transportElapsed % trackDuration) + trackDuration) % trackDuration)
                : 0;
            redrawTrack(t, { mode: "x", hx: getTrackHeadX(t, transportElapsed), localElapsed, trackDuration, forceBase }, brushSelect.value, chordIntervals, chordColors);
        }
    }); 
    const dataArray = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(dataArray);
    let avg = dataArray.reduce((a, b) => a + b) / dataArray.length; let d = avg - lastAvg; lastAvg = avg;
    
    let scaleX = 1 + Math.min(0.2, d / 100); let scaleY = 1 - Math.min(0.5, d / 50); let isFractalPlaying = false;
    if (liveGainNode && brushSelect.value === "fractal") isFractalPlaying = true; 
    
    if (isPlaying) {
        const anySolo = tracks.some(t => t.solo);
        tracks.forEach(track => {
            if (track.mute || (anySolo && !track.solo)) return; 
            track.segments.forEach(seg => {
                if (seg.brush === "fractal" && seg.points.length > 0) {
                    const xs = seg.points.map(p => Number(p.x)).filter(Number.isFinite);
                    if (!xs.length) return;
                    const startX = Math.min(...xs);
                    const endX = Math.max(...xs);
                    const localX = getTrackHeadX(track, transportElapsed);
                    if (localX >= startX && localX <= endX + 10) isFractalPlaying = true;
                }
            });
        });
    }
    
    if (isFractalPlaying) {
        const jitterX = (Math.random() - 0.5) * 15; const jitterY = (Math.random() - 0.5) * 15;
        pigeonImg.style.transform = `scale(${scaleX}, ${scaleY}) translate(${jitterX}px, ${jitterY}px)`;
        pigeonImg.style.filter = `drop-shadow(${jitterX * 1.5}px ${jitterY * 1.5}px 0 rgba(255, 0, 0, 0.8)) drop-shadow(${-jitterX * 1.5}px ${-jitterY * 1.5}px 0 rgba(0, 255, 255, 0.8)) hue-rotate(${Math.random() * 360}deg) contrast(150%)`;
    } else {
        pigeonImg.style.transform = `scale(${scaleX}, ${scaleY}) translate(0px, 0px)`; pigeonImg.style.filter = 'none';
    }
}

function setupTrackControls(t) {
    const cont = t.canvas.closest('.track-container'); if(!cont) return;
    const gridBtn = cont.querySelector(".btn--grid");
    if (gridBtn) {
        setStepButtonValue(gridBtn, t.gridSteps);
        gridBtn.title = `Grid: ${t.gridSteps} steps`;
        gridBtn.addEventListener("click", () => {
            const steps = [8, 16, 32, 64];
            const idx = steps.indexOf(t.gridSteps);
            t.gridSteps = steps[(idx + 1) % steps.length];
            setStepButtonValue(gridBtn, t.gridSteps);
            updateTrackMetaTooltips(t, cont);
            redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
        });
    }
    const lenBtn = cont.querySelector(".btn--len");
    if (lenBtn) {
        setStepButtonValue(lenBtn, t.lengthSteps);
        lenBtn.title = `Loop length: ${t.lengthSteps} steps`;
        lenBtn.addEventListener("click", () => {
            const steps = [8, 16, 32, 64];
            const idx = steps.indexOf(t.lengthSteps);
            t.lengthSteps = steps[(idx + 1) % steps.length];
            setStepButtonValue(lenBtn, t.lengthSteps);
            updateTrackMetaTooltips(t, cont);
            updatePlaybackDuration();
            if (isPlaying) {
                clearNextLoopSchedule();
                scheduleUpcomingLoopIfNeeded();
            }
        });
    }
    cont.querySelectorAll(".wave-btn").forEach(b => b.addEventListener("click", () => {
        const requestedWave = b.dataset.wave;
        if (requestedWave === "noise" && t.wave === "noise") {
            const qSteps = [3, 6, 10, 14];
            const currentIdx = qSteps.indexOf(t.noiseQ);
            t.noiseQ = qSteps[(currentIdx + 1) % qSteps.length];
            updateNoiseButtonLabel(t, cont);
            return;
        }
        t.wave = requestedWave;
        cont.querySelectorAll(".wave-btn").forEach(btn => btn.classList.remove("active"));
        b.classList.add("active");
        updateNoiseButtonLabel(t, cont);
    }));
    const muteBtn = cont.querySelector(".mute-btn"); if(muteBtn) { muteBtn.addEventListener("click", e => { t.mute = !t.mute; muteBtn.classList.toggle("active", t.mute); applyAllVolumes(); }); }
    const soloBtn = cont.querySelector(".btn--solo"); if(soloBtn) { soloBtn.addEventListener("click", e => { t.solo = !t.solo; soloBtn.classList.toggle("active", t.solo); applyAllVolumes(); }); }
    const bpBtn = cont.querySelector(".track__bp-extra"); if (bpBtn) { bpBtn.classList.toggle("active", t.bp); bpBtn.addEventListener("click", () => { t.bp = !t.bp; bpBtn.classList.toggle("active", t.bp); applyAllVolumes(); updateRoutingFromUI(); }); }
    const volSlider = cont.querySelector(".volume-slider"); if(volSlider) volSlider.addEventListener("input", e => { t.vol = parseFloat(e.target.value); applyAllVolumes(); });
    const snapBox = cont.querySelector(".snap-checkbox");
    if (snapBox) {
        snapBox.title = `Snap: ${t.snap ? "on" : "off"}`;
        snapBox.addEventListener("change", e => {
            t.snap = e.target.checked;
            updateTrackMetaTooltips(t, cont);
        });
    }
    updateTrackMetaTooltips(t, cont);
}

const peakDataArray = new Float32Array(256);
const clippingLEDs = [ document.getElementById('peak-t1'), document.getElementById('peak-t2'), document.getElementById('peak-t3'), document.getElementById('peak-t4') ];

function updateClippingLEDs() {
    if (!audioCtx || !trackAnalysers || trackAnalysers.length === 0) { requestAnimationFrame(updateClippingLEDs); return; }
    for (let i = 0; i < 4; i++) {
        const analyser = trackAnalysers[i]; const led = clippingLEDs[i]; if (!analyser || !led) continue;
        analyser.getFloatTimeDomainData(peakDataArray);
        let maxPeak = 0;
        for (let j = 0; j < peakDataArray.length; j++) { const absValue = Math.abs(peakDataArray[j]); if (absValue > maxPeak) maxPeak = absValue; }
        if (maxPeak >= 0.95) { led.classList.add('peak'); led.classList.remove('warning'); } else if (maxPeak >= 0.75) { led.classList.add('warning'); led.classList.remove('peak'); } else { led.classList.remove('peak'); led.classList.remove('warning'); }
        led.style.background = ''; 
    }
    requestAnimationFrame(updateClippingLEDs);
}
updateClippingLEDs();
