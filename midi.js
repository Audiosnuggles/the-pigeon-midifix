// midi.js - The Pigeon Sync Engine
export let midiSyncActive = false;

const midiClockState = {
    running: false,
    absoluteTickCount: 0,
    lastTickTimeMs: 0,
    smoothedBpm: 0,
    smoothedTickMs: 0
};

export function getMidiClockState() {
    return { ...midiClockState };
}

export async function initMidiEngine(syncBtnId, selectId, callbacks) {
    const syncBtn = document.getElementById(syncBtnId);
    const midiSelect = document.getElementById(selectId);
    let midiAccess = null;

    let lastTickTime = 0;
    let smoothedBpm = 0;
    let bpmSendTickCount = 0;
    let lastSentBpm = 0;

    if (!syncBtn || !midiSelect) return;

    const setSyncUiState = (active) => {
        midiSyncActive = !!active;
        syncBtn.classList.toggle("active", midiSyncActive);
        syncBtn.innerText = midiSyncActive ? "SLAVE MODE" : "EXT SYNC";
        midiSelect.disabled = !midiSyncActive;
        // Keep visual state in CSS only (no inline color overrides).
        midiSelect.style.removeProperty("background");
        midiSelect.style.removeProperty("color");
        if (callbacks.onToggle) callbacks.onToggle(midiSyncActive);
    };

    syncBtn.addEventListener("click", async () => {
        const nextActive = !midiSyncActive;
        if (!nextActive) {
            setSyncUiState(false);
            return;
        }

        if (typeof navigator === "undefined" || typeof navigator.requestMIDIAccess !== "function") {
            console.warn("Web MIDI API nicht verfügbar.");
            setSyncUiState(false);
            return;
        }

        setSyncUiState(true);

        if (!midiAccess) {
            try {
                midiAccess = await navigator.requestMIDIAccess();
                populateDropdown(midiAccess, midiSelect);
                midiAccess.onstatechange = () => populateDropdown(midiAccess, midiSelect);
                midiSelect.addEventListener('change', () => attachListener(midiAccess, midiSelect.value));
                if (midiSelect.options.length > 0) attachListener(midiAccess, midiSelect.value);
            } catch (err) {
                console.error("Web MIDI API blockiert.", err);
                setSyncUiState(false);
            }
        }
    });

    function populateDropdown(access, select) {
        const currentVal = select.value;
        select.innerHTML = '';
        let count = 0;
        for (let input of access.inputs.values()) {
            const opt = document.createElement('option');
            opt.value = input.id;
            opt.text = input.name;
            select.appendChild(opt);
            count++;
        }
        if (count === 0) {
            const opt = document.createElement('option');
            opt.text = "No Devices Found";
            select.appendChild(opt);
        } else if (currentVal && select.querySelector(`option[value="${currentVal}"]`)) {
            select.value = currentVal;
        } else {
            select.value = select.options[0].value;
            if (midiSyncActive) attachListener(access, select.value);
        }
    }

    function attachListener(access, inputId) {
        for (let input of access.inputs.values()) input.onmidimessage = null; 
        if (!inputId) return;
        const input = access.inputs.get(inputId);
        if (input) input.onmidimessage = handleMessage;
    }

    function handleMessage(event) {
        if (!midiSyncActive) return;
        const status = event.data[0];
        const timeStamp = event.timeStamp; 

        if (status === 248) { // CLOCK TICK
            midiClockState.running = true;
            if (lastTickTime > 0) {
                const interval = timeStamp - lastTickTime;
                
                // Filtere extreme Lags raus
                if (interval > 5 && interval < 100) {
                    const currentBpm = 60000 / (interval * 24);
                    
                    if (smoothedBpm === 0) {
                        smoothedBpm = currentBpm;
                    } else {
                        // Adaptive smoothing: react fast to large tempo jumps, stay stable on micro-jitter.
                        const drift = Math.abs(currentBpm - smoothedBpm);
                        const alpha = drift >= 10 ? 0.35 : (drift >= 4 ? 0.22 : 0.12);
                        smoothedBpm += (currentBpm - smoothedBpm) * alpha;
                    }

                    if (midiClockState.smoothedTickMs === 0) {
                        midiClockState.smoothedTickMs = interval;
                    } else {
                        const tickDrift = Math.abs(interval - midiClockState.smoothedTickMs);
                        const tickAlpha = tickDrift >= 8 ? 0.35 : (tickDrift >= 3 ? 0.22 : 0.12);
                        midiClockState.smoothedTickMs += (interval - midiClockState.smoothedTickMs) * tickAlpha;
                    }

                    bpmSendTickCount++;
                    const sentDrift = Math.abs(smoothedBpm - lastSentBpm);
                    // Send faster during tempo transitions, slower during stable clock.
                    const sendEveryTicks = sentDrift >= 4 ? 6 : 12;
                    if (bpmSendTickCount >= sendEveryTicks) {
                        bpmSendTickCount = 0;
                        if (callbacks.onBpm && smoothedBpm > 30 && smoothedBpm < 300) {
                            // Avoid excessive callback churn on tiny changes.
                            if (lastSentBpm === 0 || sentDrift >= 0.1) {
                                lastSentBpm = smoothedBpm;
                                callbacks.onBpm(smoothedBpm);
                            }
                        }
                    }
                }
            }
            lastTickTime = timeStamp;
            midiClockState.absoluteTickCount += 1;
            midiClockState.lastTickTimeMs = timeStamp;
            midiClockState.smoothedBpm = smoothedBpm;
        } 
        else if (status === 250) { // START
            lastTickTime = 0;
            smoothedBpm = 0;
            bpmSendTickCount = 0;
            lastSentBpm = 0;
            midiClockState.running = true;
            midiClockState.absoluteTickCount = 0;
            midiClockState.lastTickTimeMs = timeStamp;
            midiClockState.smoothedBpm = 0;
            midiClockState.smoothedTickMs = 0;
            if (callbacks.onStart) callbacks.onStart({ timeStamp, status });
        } 
        else if (status === 251) { // CONTINUE
            lastTickTime = 0;
            bpmSendTickCount = 0;
            lastSentBpm = 0;
            midiClockState.running = true;
            midiClockState.lastTickTimeMs = timeStamp;
            midiClockState.smoothedBpm = smoothedBpm;
            if (callbacks.onStart) callbacks.onStart({ timeStamp, status });
        }
        else if (status === 252) { // STOP
            midiClockState.running = false;
            if (callbacks.onStop) callbacks.onStop();
        }
    }
}
