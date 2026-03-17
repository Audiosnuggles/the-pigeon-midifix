/**
 * Macht einen Drehregler (Knob) interaktiv.
 */
export function setupKnob(knob, onValueChange) {
    knob.addEventListener('mousedown', (e) => {
        let startY = e.clientY; 
        let startVal = parseFloat(knob.dataset.val || 0);
        document.body.style.cursor = 'ns-resize';
        
        const onMove = (ev) => {
            let newVal = Math.max(0, Math.min(1, startVal + ((startY - ev.clientY) * 0.005)));
            knob.dataset.val = newVal;
            knob.style.transform = `rotate(${-135 + (newVal * 270)}deg)`;
            onValueChange(newVal);
        };
        const onUp = () => { 
            document.body.style.cursor = 'default';
            window.removeEventListener('mousemove', onMove); 
            window.removeEventListener('mouseup', onUp); 
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
}

/**
 * Aktualisiert die "Filled"-Anzeige der Pattern-Pads.
 * Prüft jetzt, ob auch wirklich Pinselstriche (Punkte) vorhanden sind.
 */
export function updatePadUI(patternBanks) {
    document.querySelectorAll(".pad").forEach(pad => {
        const b = pad.dataset.bank;
        const i = parseInt(pad.dataset.idx);
        
        let hasContent = false;
        const pat = patternBanks[b] && patternBanks[b][i];
        
        if (pat) {
            // Die Spuren-Daten holen (unterstützt das alte und neue JSON-Format)
            const tracksData = pat.tracks || pat; 
            
            if (Array.isArray(tracksData)) {
                // Prüfen, ob irgendeine der 4 Spuren ein Segment mit gezeichneten Punkten enthält
                hasContent = tracksData.some(track => 
                    track.segments && track.segments.some(seg => seg.points && seg.points.length > 0)
                );
            }
        }
        
        pad.classList.toggle("filled", hasContent);
    });
}

/**
 * Setzt das FX-Rack visuell auf die Standardwerte zurück.
 */
export function resetFXUI(updateRouting) {
    document.querySelectorAll('.matrix-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.fx-xy-link').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.fx-enable-btn--tapestop').forEach(btn => {
        btn.classList.remove('active');
        btn.textContent = 'TRG';
    });
    document.querySelectorAll('.knob:not(.modify-knob)').forEach(knob => {
        const param = knob.nextElementSibling.innerText;
        let def = (param === "TIME")
            ? 0.4
            : (param === "RATE"
                ? 0.3
                : (param === "STOP"
                    ? 0.55
                    : (param === "START" ? 0.35 : 0.0)));
        knob.dataset.val = def;
        knob.style.transform = `rotate(${-135 + (def * 270)}deg)`;
    });
    if (updateRouting) updateRouting();
}

// Sprach-Umschalter für das Hilfe-Menü (Text-Links: DE | EN | FR)
const helpDe = document.getElementById('help-de');
const helpEn = document.getElementById('help-en');
const helpFr = document.getElementById('help-fr');
const langLinks = document.querySelectorAll('.lang-link');

if (langLinks.length > 0) {
    langLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const selectedLang = e.target.dataset.lang;
            
            // Optische Hervorhebung anpassen (Deckkraft)
            langLinks.forEach(l => {
                l.classList.remove('active');
                l.style.opacity = "0.5";
            });
            e.target.classList.add('active');
            e.target.style.opacity = "1";
            
            // Passendes Hilfe-Div einblenden
            if (helpDe) helpDe.style.display = (selectedLang === 'de') ? 'block' : 'none';
            if (helpEn) helpEn.style.display = (selectedLang === 'en') ? 'block' : 'none';
            if (helpFr) helpFr.style.display = (selectedLang === 'fr') ? 'block' : 'none';
        });
    });
}
