export let audioCtx;
export let masterGain;
export let masterLimiter;
export let analyser;
export const fxNodes = { delay: {}, reverb: {}, vibrato: {}, filter: {}, stutter: {}, tapestop: {} };
export const trackSends = [[], [], [], []];
export const trackAnalysers = [];
export const trackMasterGains = [];
const REVERB_CROSSFADE_SEC = 0.08;
const MASTER_LIMITER_SETTINGS = Object.freeze({
    threshold: -2.5,
    knee: 4.0,
    ratio: 12.0,
    attack: 0.0015,
    release: 0.09
});

export function initAudio(tracks, updateRoutingCallback) {
    if (audioCtx) return;
    
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();
    
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.8;
    masterLimiter = audioCtx.createDynamicsCompressor();
    masterLimiter.threshold.value = MASTER_LIMITER_SETTINGS.threshold;
    masterLimiter.knee.value = MASTER_LIMITER_SETTINGS.knee;
    masterLimiter.ratio.value = MASTER_LIMITER_SETTINGS.ratio;
    masterLimiter.attack.value = MASTER_LIMITER_SETTINGS.attack;
    masterLimiter.release.value = MASTER_LIMITER_SETTINGS.release;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    
    masterGain.connect(masterLimiter);
    masterLimiter.connect(analyser);
    analyser.connect(audioCtx.destination);

    // 1. DELAY
    fxNodes.delay.node = audioCtx.createDelay(5.0);
    fxNodes.delay.feedback = audioCtx.createGain();
    fxNodes.delay.input = audioCtx.createGain();
    
    fxNodes.delay.node.delayTime.value = 0.4;
    fxNodes.delay.feedback.gain.value = 0.3;
    
    fxNodes.delay.input.connect(fxNodes.delay.node);
    fxNodes.delay.node.connect(fxNodes.delay.feedback);
    fxNodes.delay.feedback.connect(fxNodes.delay.node);
    fxNodes.delay.node.connect(masterGain);

    // 2. REVERB (Zurück zum dichten Faltungshall, aber warm gefiltert!)
    fxNodes.reverb.convolverA = audioCtx.createConvolver();
    fxNodes.reverb.convolverB = audioCtx.createConvolver();
    fxNodes.reverb.wetA = audioCtx.createGain();
    fxNodes.reverb.wetB = audioCtx.createGain();
    fxNodes.reverb.activeConvolver = "A";
    fxNodes.reverb.mix = audioCtx.createGain();
    fxNodes.reverb.input = audioCtx.createGain();
    
    // Der Dampening-Filter bleibt, damit es warm klingt!
    fxNodes.reverb.filter = audioCtx.createBiquadFilter();
    fxNodes.reverb.filter.type = 'lowpass';
    fxNodes.reverb.filter.frequency.value = 2500; 
    
    fxNodes.reverb.mix.gain.value = 0.2;
    
    fxNodes.reverb.wetA.gain.value = 1;
    fxNodes.reverb.wetB.gain.value = 0;

    // Routing: Input -> dual convolver crossfade -> Filter -> Mix -> Master
    fxNodes.reverb.input.connect(fxNodes.reverb.wetA);
    fxNodes.reverb.input.connect(fxNodes.reverb.wetB);
    fxNodes.reverb.wetA.connect(fxNodes.reverb.convolverA);
    fxNodes.reverb.wetB.connect(fxNodes.reverb.convolverB);
    fxNodes.reverb.convolverA.connect(fxNodes.reverb.filter);
    fxNodes.reverb.convolverB.connect(fxNodes.reverb.filter);
    fxNodes.reverb.filter.connect(fxNodes.reverb.mix);
    fxNodes.reverb.mix.connect(masterGain);
    
    // Reverb Buffer direkt am Anfang einmal befüllen
    updateReverbDecay(0.5);

    // 3. VIBRATO
    fxNodes.vibrato.node = audioCtx.createDelay(1.0);
    fxNodes.vibrato.input = audioCtx.createGain();
    fxNodes.vibrato.lfo = audioCtx.createOscillator();
    fxNodes.vibrato.depthNode = audioCtx.createGain();
    
    fxNodes.vibrato.node.delayTime.value = 0.03;
    fxNodes.vibrato.lfo.frequency.value = 5;
    fxNodes.vibrato.depthNode.gain.value = 0;
    
    fxNodes.vibrato.lfo.connect(fxNodes.vibrato.depthNode);
    fxNodes.vibrato.depthNode.connect(fxNodes.vibrato.node.delayTime);
    fxNodes.vibrato.lfo.start();
    
    fxNodes.vibrato.input.connect(fxNodes.vibrato.node);
    fxNodes.vibrato.node.connect(masterGain);

    // 4. FILTER (Warmer Moog-Style: 24dB Ladder + Soft Saturation)
    fxNodes.filter.input = audioCtx.createGain();
    fxNodes.filter.node1 = audioCtx.createBiquadFilter(); 
    fxNodes.filter.node2 = audioCtx.createBiquadFilter(); 
    fxNodes.filter.drive = audioCtx.createWaveShaper();
    
    fxNodes.filter.node1.type = 'lowpass';
    fxNodes.filter.node2.type = 'lowpass';
    fxNodes.filter.node1.frequency.value = 20000;
    fxNodes.filter.node2.frequency.value = 20000;
    fxNodes.filter.node1.Q.value = 0;
    fxNodes.filter.node2.Q.value = 0;
    
    fxNodes.filter.drive.curve = getWarmDistortionCurve(0);
    fxNodes.filter.drive.oversample = '4x';
    
    fxNodes.filter.input.connect(fxNodes.filter.drive);
    fxNodes.filter.drive.connect(fxNodes.filter.node1);
    fxNodes.filter.node1.connect(fxNodes.filter.node2);
    fxNodes.filter.node2.connect(masterGain);

    // 5. STUTTER GATE (Knacks-frei durch abgerundete Kanten)
    fxNodes.stutter.input = audioCtx.createGain();
    fxNodes.stutter.gate = audioCtx.createGain();
    fxNodes.stutter.lfo = audioCtx.createOscillator();
    
    fxNodes.stutter.lfo.type = 'square';
    fxNodes.stutter.lfo.frequency.value = 8;

    // NEU: Der "Slew Limiter" - Ein Filter, der den LFO abrundet
    fxNodes.stutter.smoother = audioCtx.createBiquadFilter();
    fxNodes.stutter.smoother.type = 'lowpass';
    fxNodes.stutter.smoother.frequency.value = 40; // Sehr tiefe Frequenz rundet die Rechteck-Kanten ab
    
    const stutterAmp = audioCtx.createGain();
    stutterAmp.gain.value = 0.5;
    const stutterOffset = audioCtx.createConstantSource();
    stutterOffset.offset.value = 0.5;
    stutterOffset.start();

    fxNodes.stutter.gate.gain.value = 0;
    
    // Neues LFO-Routing: LFO -> Smoother -> Amp -> Gain Parameter
    fxNodes.stutter.lfo.connect(fxNodes.stutter.smoother);
    fxNodes.stutter.smoother.connect(stutterAmp);
    
    stutterAmp.connect(fxNodes.stutter.gate.gain);
    stutterOffset.connect(fxNodes.stutter.gate.gain);
    fxNodes.stutter.lfo.start();

    fxNodes.stutter.input.connect(fxNodes.stutter.gate);
    fxNodes.stutter.gate.connect(masterGain); 

    // 6. TAPE STOP (Delay-time varispeed style)
    fxNodes.tapestop.input = audioCtx.createGain();
    fxNodes.tapestop.delay = audioCtx.createDelay(0.05);
    fxNodes.tapestop.base = audioCtx.createConstantSource();
    fxNodes.tapestop.lfo = audioCtx.createOscillator();
    fxNodes.tapestop.smoother = audioCtx.createBiquadFilter();
    fxNodes.tapestop.depthNode = audioCtx.createGain();
    fxNodes.tapestop.flutterOsc = audioCtx.createOscillator();
    fxNodes.tapestop.flutterDepth = audioCtx.createGain();
    fxNodes.tapestop.tone = audioCtx.createBiquadFilter();

    fxNodes.tapestop.base.offset.value = 0.001;
    fxNodes.tapestop.lfo.type = 'sawtooth';
    fxNodes.tapestop.lfo.frequency.value = 0.35;
    fxNodes.tapestop.smoother.type = 'lowpass';
    fxNodes.tapestop.smoother.frequency.value = 6;
    fxNodes.tapestop.depthNode.gain.value = 0;
    fxNodes.tapestop.flutterOsc.type = 'triangle';
    fxNodes.tapestop.flutterOsc.frequency.value = 8;
    fxNodes.tapestop.flutterDepth.gain.value = 0;
    fxNodes.tapestop.tone.type = 'lowpass';
    fxNodes.tapestop.tone.frequency.value = 9000;
    fxNodes.tapestop.tone.Q.value = 1.0;

    fxNodes.tapestop.lfo.connect(fxNodes.tapestop.smoother);
    fxNodes.tapestop.smoother.connect(fxNodes.tapestop.depthNode);
    fxNodes.tapestop.depthNode.connect(fxNodes.tapestop.delay.delayTime);
    fxNodes.tapestop.flutterOsc.connect(fxNodes.tapestop.flutterDepth);
    fxNodes.tapestop.flutterDepth.connect(fxNodes.tapestop.delay.delayTime);
    fxNodes.tapestop.base.connect(fxNodes.tapestop.delay.delayTime);
    fxNodes.tapestop.base.start();
    fxNodes.tapestop.lfo.start();
    fxNodes.tapestop.flutterOsc.start();

    fxNodes.tapestop.input.connect(fxNodes.tapestop.delay);
    fxNodes.tapestop.delay.connect(fxNodes.tapestop.tone);
    fxNodes.tapestop.tone.connect(masterGain);

    tracks.forEach((t, i) => {
        // Analyser für diesen Track erstellen (für die LEDs)
        trackAnalysers[i] = audioCtx.createAnalyser();
        trackAnalysers[i].fftSize = 256;
        trackMasterGains[i] = audioCtx.createGain();
        trackMasterGains[i].gain.value = 1.0;
        t.masterGainNode = trackMasterGains[i];

        trackSends[i] = {
            dry: audioCtx.createGain(),
            delay: audioCtx.createGain(),
            reverb: audioCtx.createGain(),
            vibrato: audioCtx.createGain(),
            filter: audioCtx.createGain(),
            stutter: audioCtx.createGain(),
            tapestop: audioCtx.createGain()
        };
        
        trackSends[i].dry.gain.value = 1.0;
        trackSends[i].delay.gain.value = 0;
        trackSends[i].reverb.gain.value = 0;
        trackSends[i].vibrato.gain.value = 0;
        trackSends[i].filter.gain.value = 0;
        trackSends[i].stutter.gain.value = 0;
        trackSends[i].tapestop.gain.value = 0;

        // Routing: Track master -> sends -> analyser/master
        trackMasterGains[i].connect(trackSends[i].dry);
        trackMasterGains[i].connect(trackSends[i].delay);
        trackMasterGains[i].connect(trackSends[i].reverb);
        trackMasterGains[i].connect(trackSends[i].vibrato);
        trackMasterGains[i].connect(trackSends[i].filter);
        trackMasterGains[i].connect(trackSends[i].stutter);
        trackMasterGains[i].connect(trackSends[i].tapestop);

        // Routing: Das Dry-Signal geht erst in den Analyser und von dort in den Master
        trackSends[i].dry.connect(trackAnalysers[i]);
        trackAnalysers[i].connect(masterGain);

        trackSends[i].delay.connect(fxNodes.delay.input);
        trackSends[i].reverb.connect(fxNodes.reverb.input);
        trackSends[i].vibrato.connect(fxNodes.vibrato.input);
        trackSends[i].filter.connect(fxNodes.filter.input);
        trackSends[i].stutter.connect(fxNodes.stutter.input);
        trackSends[i].tapestop.connect(fxNodes.tapestop.input);
    });

    if (updateRoutingCallback) updateRoutingCallback();
}

let reverbTimer = null;
export function updateReverbDecay(decayVal) {
    if (!audioCtx || !fxNodes.reverb.convolverA || !fxNodes.reverb.convolverB) return;
    
    // Timer zurücksetzen, solange der Regler noch gedreht wird
    if (reverbTimer) clearTimeout(reverbTimer);
    
    // Wartet kurz nach dem Drehen, berechnet dann den dicken Raum neu
    reverbTimer = setTimeout(() => {
        const duration = 0.1 + (decayVal * 4.0); 
        const sr = audioCtx.sampleRate;
        const len = Math.floor(sr * duration);
        const impulse = audioCtx.createBuffer(2, len, sr);
        for (let i = 0; i < 2; i++) {
            const chan = impulse.getChannelData(i);
            for (let j = 0; j < len; j++) chan[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 3);
        }
        const wetAVal = fxNodes.reverb.wetA.gain.value;
        const wetBVal = fxNodes.reverb.wetB.gain.value;
        // Always write new impulse into the currently quieter branch to avoid audible buffer swaps.
        const useAAsInactive = wetAVal <= wetBVal;
        const activeGain = useAAsInactive ? fxNodes.reverb.wetB : fxNodes.reverb.wetA;
        const inactiveGain = useAAsInactive ? fxNodes.reverb.wetA : fxNodes.reverb.wetB;
        const inactiveConvolver = useAAsInactive ? fxNodes.reverb.convolverA : fxNodes.reverb.convolverB;
        const activeConvolver = useAAsInactive ? fxNodes.reverb.convolverB : fxNodes.reverb.convolverA;

        // Ensure inactive branch is silent before replacing buffer.
        inactiveGain.gain.cancelScheduledValues(audioCtx.currentTime);
        inactiveGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.01);
        inactiveConvolver.buffer = impulse;

        const now = audioCtx.currentTime;
        activeGain.gain.cancelScheduledValues(now);
        inactiveGain.gain.cancelScheduledValues(now);
        activeGain.gain.setValueAtTime(activeGain.gain.value, now);
        inactiveGain.gain.setValueAtTime(inactiveGain.gain.value, now);
        activeGain.gain.linearRampToValueAtTime(0, now + REVERB_CROSSFADE_SEC);
        inactiveGain.gain.linearRampToValueAtTime(1, now + REVERB_CROSSFADE_SEC);

        // Keep explicit active-branch state in sync for diagnostics.
        fxNodes.reverb.activeConvolver = activeConvolver === fxNodes.reverb.convolverA ? "A" : "B";
    }, 150);
}

export function connectTrackToFX(trackGain, index) {
    if (!audioCtx || !trackMasterGains[index]) return;
    trackGain.connect(trackMasterGains[index]);
}

export function updateTrackVolume(track) {
    if (track.masterGainNode && audioCtx) {
        track.masterGainNode.gain.setTargetAtTime(track.mute ? 0 : track.vol, audioCtx.currentTime, 0.05);
    }
}

export function getDistortionCurve(amount = 50) {
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
        const x = i * 2 / n_samples - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

export function getWarmDistortionCurve(amount = 0) {
    const k = amount / 10; 
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    for (let i = 0; i < n_samples; ++i) {
        let x = i * 2 / n_samples - 1;
        curve[i] = Math.tanh(x * (1 + k));
    }
    return curve;
}

// Lineare Berechnung wie in The Pigeon 3
export function mapYToFrequency(y, height) {
    return Math.max(20, Math.min(1000 - (y / height) * 920, 20000));
}

// Quantisierungs-Logik und Moll-Pentatonik wie in The Pigeon 3
export function quantizeFrequency(freq, scale) {
    const scales = {
        major: [0, 2, 4, 5, 7, 9, 11],
        minor: [0, 2, 3, 5, 7, 8, 10],
        pentatonic: [0, 3, 5, 7, 10], 
        blues: [0, 3, 5, 6, 7, 10]
    };
    const activeScale = scales[scale] || scales.major;
    
    // A440 Logik
    let m = Math.round(69 + 12 * Math.log2(freq / 440));
    let mod = m % 12;
    let b = activeScale[0];
    let md = 99;
    
    activeScale.forEach(p => {
        if (Math.abs(p - mod) < md) {
            md = Math.abs(p - mod);
            b = p;
        }
    });
    
    return 440 * Math.pow(2, (m - mod + b - 69) / 12);
}
