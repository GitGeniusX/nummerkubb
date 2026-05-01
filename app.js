// ====================================================
// NUMMERKUBB – Poängräknare
// ====================================================

const STORAGE_KEY = 'nummerkubb-state-v1';

// ---------- STATE ----------
const state = {
  screen: 'setup', // 'setup' | 'game' | 'finished'
  players: [
    { id: 1, name: '', score: 0 },
    { id: 2, name: '', score: 0 },
  ],
  currentPlayerIndex: 0,
  targetScore: 50,
  maxPins: 12,
  overshootRule: 'reset-to-half', // 'reset-to-half' | 'restart' | 'lose-turn'
  overshootValue: 25,
  numberPinThreshold: 1, // 1 = bara 1 pinne räknas som nummer; 2 = upp till 2 pinnar räknas som siffror (summa)
  eliminateOnZeros: true, // 3 nollkast i rad = ute
  zerosToEliminate: 3,
  selectedPins: [], // pinnar markerade för aktuellt kast
  matchNumber: 1, // nuvarande matchnummer i serien
  matchWins: {}, // { [playerId]: antal vunna matcher }
  history: [], // { playerId, playerName, action, points, newScore, prevScore, prevIndex }
  scoreInputMode: 'single', // 'single' | 'multi'
  winnerId: null,
  theme: 'dark', // 'dark' | 'light'
  voiceEnabled: true, // läs upp stora händelser
};

// ---------- PERSIST (in-memory only) ----------
function saveState() { /* state lives in memory only */ }
function loadState() { return false; }
function clearState() { /* no-op */ }

// ---------- HELPERS ----------
function uid() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

// Returnerar listan av pinn-nummer som ger exakt vinst om du slår dem
// (hänsyn till numberPinThreshold-regeln: 1 pinne = pinnens nummer)
function matchPointPins(player) {
  if (!player || player.eliminated) return [];
  const need = state.targetScore - player.score;
  if (need <= 0) return [];
  // En pinne = numret. Om need <= maxPins och need >= 1, finns matchboll.
  if (need >= 1 && need <= state.maxPins) {
    return [need];
  }
  return [];
}

// True om spelaren är en miss bort från elimination
function isLastStrike(player) {
  if (!state.eliminateOnZeros || !player || player.eliminated) return false;
  const streak = player.zeroStreak || 0;
  return streak >= state.zerosToEliminate - 1 && streak < state.zerosToEliminate;
}

// ---------- VOICE & HAPTIC ----------
let _swedishVoice = null;
function getSwedishVoice() {
  if (_swedishVoice) return _swedishVoice;
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  // Föredra svensk röst om tillgänglig
  _swedishVoice = voices.find(v => /^sv/i.test(v.lang)) || null;
  return _swedishVoice;
}

// Browser-policy: speechSynthesis och AudioContext kräver en user-gesture
// först (extra strikt i iframes och på iOS). Vi unlåser båda vid första klick.
let _audioUnlocked = false;
let _audioCtx = null;
let _voiceAvailable = null; // null=okänt, true/false

function unlockAudio() {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  // Unlås SpeechSynthesis: en tom utterance räcker ofta i iframe
  try {
    if ('speechSynthesis' in window) {
      const probe = new SpeechSynthesisUtterance('');
      probe.volume = 0;
      window.speechSynthesis.speak(probe);
      // Trigga voiceschanged: vissa browsers laddar röster lazy
      try { window.speechSynthesis.getVoices(); } catch (e) {}
    }
  } catch (e) {}
  // Unlås WebAudio
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      _audioCtx = new Ctx();
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
    }
  } catch (e) {}
}

// Lyssna på första interaktionen och unlås ljudet
function installAudioUnlock() {
  const handler = () => {
    unlockAudio();
    document.removeEventListener('pointerdown', handler);
    document.removeEventListener('keydown', handler);
    document.removeEventListener('touchstart', handler);
  };
  document.addEventListener('pointerdown', handler, { once: false });
  document.addEventListener('keydown', handler, { once: false });
  document.addEventListener('touchstart', handler, { once: false });
}

// Spåra om röst faktiskt funkar (visar i UI om inte)
function checkVoiceAvailable() {
  if (!('speechSynthesis' in window)) {
    _voiceAvailable = false;
    return;
  }
  // Vissa browsers laddar voices asynkront
  const probe = () => {
    const voices = window.speechSynthesis.getVoices();
    _voiceAvailable = voices.length > 0;
  };
  probe();
  if (_voiceAvailable === false || _voiceAvailable === null) {
    if ('onvoiceschanged' in window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = probe;
    }
    // Fallback: nöjs efter 1.5s
    setTimeout(probe, 1500);
  }
}

function speak(text) {
  if (!state.voiceEnabled) return;
  if (!('speechSynthesis' in window)) return;
  // Säkerställ att ljud är unlåst (om denna anropas från en gesture-handler)
  if (!_audioUnlocked) unlockAudio();
  try {
    // Resume om suspended (iOS pausar ofta utan förvarning)
    if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume();
    window.speechSynthesis.cancel();
    // Vissa browsers vill ha en kort delay efter cancel
    setTimeout(() => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        const voice = getSwedishVoice();
        if (voice) u.voice = voice;
        u.lang = voice ? voice.lang : 'sv-SE';
        u.rate = 1.0;
        u.pitch = 1.0;
        u.volume = 1.0;
        u.onerror = (e) => { _voiceAvailable = false; };
        u.onstart = () => { _voiceAvailable = true; };
        window.speechSynthesis.speak(u);
      } catch (e) {}
    }, 50);
  } catch (e) { /* tyst fail */ }
}

// ===== LJUDMOTOR =====
// Hjälpfunktioner som bygger karaktäristiska ljud med WebAudio.

// Master gain (används för global volym + komprimering mot klippning)
let _masterGain = null;
function _master() {
  if (!_audioCtx) return null;
  if (!_masterGain) {
    _masterGain = _audioCtx.createGain();
    _masterGain.gain.value = 0.6;
    // Mjuk komprimering så sammanlagrade toner inte klipper
    const comp = _audioCtx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.12;
    _masterGain.connect(comp).connect(_audioCtx.destination);
  }
  return _masterGain;
}

// Spela en not med ADSR-envelope och eventuell pitch-glide
// opts: { freq, freqEnd, type, startAt, durMs, attack, release, peak, decay }
function _note(opts) {
  if (!_audioCtx) return;
  const ctx = _audioCtx;
  const t0 = (opts.startAt || ctx.currentTime);
  const dur = opts.durMs / 1000;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opts.type || 'sine';
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.freqEnd && opts.freqEnd !== opts.freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t0 + dur);
  }
  const peak = opts.peak != null ? opts.peak : 0.3;
  const attack = opts.attack != null ? opts.attack : 0.008;
  const release = opts.release != null ? opts.release : Math.min(0.3, dur * 0.6);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  if (opts.decay) {
    gain.gain.exponentialRampToValueAtTime(peak * 0.5, t0 + attack + opts.decay);
  }
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(_master());
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
  return { osc, gain };
}

// FM-not: en modulator som böjer bärarens pitch → ger "klockig" eller "perkussiv" känsla
function _fmNote(opts) {
  if (!_audioCtx) return;
  const ctx = _audioCtx;
  const t0 = (opts.startAt || ctx.currentTime);
  const dur = opts.durMs / 1000;
  const carrier = ctx.createOscillator();
  const modulator = ctx.createOscillator();
  const modGain = ctx.createGain();
  const gain = ctx.createGain();
  carrier.type = opts.type || 'sine';
  modulator.type = opts.modType || 'sine';
  carrier.frequency.setValueAtTime(opts.freq, t0);
  if (opts.freqEnd) carrier.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t0 + dur);
  modulator.frequency.setValueAtTime(opts.freq * (opts.ratio || 2), t0);
  modGain.gain.setValueAtTime(opts.modDepth || 200, t0);
  modGain.gain.exponentialRampToValueAtTime(1, t0 + dur);
  modulator.connect(modGain).connect(carrier.frequency);
  const peak = opts.peak != null ? opts.peak : 0.3;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + (opts.attack || 0.005));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  carrier.connect(gain).connect(_master());
  carrier.start(t0); modulator.start(t0);
  carrier.stop(t0 + dur + 0.05); modulator.stop(t0 + dur + 0.05);
}

// Filtrerad brus-burst (“trumma” eller “puff”)
function _noise(opts) {
  if (!_audioCtx) return;
  const ctx = _audioCtx;
  const t0 = (opts.startAt || ctx.currentTime);
  const dur = opts.durMs / 1000;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = opts.filterType || 'bandpass';
  filter.frequency.setValueAtTime(opts.freq || 800, t0);
  if (opts.freqEnd) filter.frequency.exponentialRampToValueAtTime(Math.max(80, opts.freqEnd), t0 + dur);
  filter.Q.value = opts.Q || 4;
  const gain = ctx.createGain();
  const peak = opts.peak != null ? opts.peak : 0.4;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(gain).connect(_master());
  src.start(t0); src.stop(t0 + dur + 0.05);
}

function _ready() {
  if (!state.voiceEnabled || !_audioCtx) return false;
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return true;
}

// ===== KARAKTÄRISTISKA LJUD =====

// Pinneklick: kort "tock" — trumlikt, låg sinus + högpassad brus
function toneClick() {
  if (!_ready()) return;
  const t = _audioCtx.currentTime;
  _note({ freq: 320, freqEnd: 180, type: 'sine', durMs: 80, peak: 0.22, attack: 0.002, startAt: t });
  _noise({ freq: 2200, durMs: 30, peak: 0.10, filterType: 'highpass', Q: 1, startAt: t });
}

// Klart-knapp: mjukt "ding" — belomning utan att vara skrikig
function toneConfirm() {
  if (!_ready()) return;
  const t = _audioCtx.currentTime;
  // Pentaton hopp E-G med klockig FM
  _fmNote({ freq: 659.25, type: 'sine', modType: 'sine', ratio: 3, modDepth: 80, durMs: 220, peak: 0.22, startAt: t });
  _fmNote({ freq: 987.77, type: 'sine', modType: 'sine', ratio: 3, modDepth: 60, durMs: 280, peak: 0.20, startAt: t + 0.07 });
}

// Miss / 0 poäng: humoristiskt "wob-wob" — fallande sinus med vibrato-ish glide
function toneMiss() {
  if (!_ready()) return;
  const t = _audioCtx.currentTime;
  _note({ freq: 440, freqEnd: 220, type: 'triangle', durMs: 220, peak: 0.22, startAt: t });
  _note({ freq: 220, freqEnd: 130, type: 'triangle', durMs: 280, peak: 0.20, startAt: t + 0.18 });
}

// Matchboll: ±1.8s tredelad spelfanfar — tre accelererande arpeggios + klock-ackord
function toneMatchball() {
  if (!_ready()) return;
  const t = _audioCtx.currentTime;
  // 1. Första arpeggio (lågt-medium): C4-E4-G4 - långsamt
  let arp1 = [261.63, 329.63, 392.00];
  arp1.forEach((f, i) => {
    _note({ freq: f, type: 'triangle', durMs: 110, peak: 0.22, startAt: t + i * 0.10 });
  });
  // 2. Andra arpeggio (medium-högt): E5-G5-B5 - snabbare
  let arp2 = [659.25, 783.99, 987.77];
  arp2.forEach((f, i) => {
    _note({ freq: f, type: 'triangle', durMs: 100, peak: 0.24, startAt: t + 0.40 + i * 0.07 });
  });
  // 3. Tredje arpeggio (toppen): G5-C6-E6 - snabbast
  let arp3 = [783.99, 1046.5, 1318.5];
  arp3.forEach((f, i) => {
    _note({ freq: f, type: 'triangle', durMs: 90, peak: 0.26, startAt: t + 0.70 + i * 0.05 });
  });
  // 4. Pulserande klock-ackord på toppen (C6 + E6 + G6 med detune för breddkänsla)
  _fmNote({ freq: 1046.5, type: 'sine', modType: 'sine', ratio: 3, modDepth: 280, durMs: 900, peak: 0.22, startAt: t + 0.90 });
  _fmNote({ freq: 1318.5, type: 'sine', modType: 'sine', ratio: 3, modDepth: 220, durMs: 850, peak: 0.18, startAt: t + 0.95 });
  _fmNote({ freq: 1568.0, type: 'sine', modType: 'sine', ratio: 3, modDepth: 180, durMs: 800, peak: 0.16, startAt: t + 1.00 });
  // 5. Lyrisk lagrad bas (G3) som binder ihop
  _note({ freq: 196.00, type: 'sine', durMs: 1500, peak: 0.18, startAt: t + 0.30 });
  // 6. Final stinger — brus-svisch som leder in i ackordet
  _noise({ freq: 200, freqEnd: 4000, durMs: 250, peak: 0.10, filterType: 'highpass', Q: 1, startAt: t + 0.65 });
}

// Sista chansen: ±1.5s accelererande hjärtklappning + larm-FM + lågt rumble
function toneLastStrike() {
  if (!_ready()) return;
  const t = _audioCtx.currentTime;
  // 5 hjärtslag som accelererar (105ms, 95, 85, 75, 65 mellanrum)
  const intervals = [0.220, 0.190, 0.165, 0.140, 0.115];
  let pulseAt = 0;
  intervals.forEach((gap, i) => {
    const start = t + pulseAt;
    // Dubbelpuls: "dunk-dunk" — två låga noter i rad
    _note({ freq: 110, freqEnd: 75, type: 'sine', durMs: 130, peak: 0.34, attack: 0.003, startAt: start });
    _note({ freq: 110, freqEnd: 75, type: 'sine', durMs: 130, peak: 0.34, attack: 0.003, startAt: start + 0.06 });
    _noise({ freq: 180, durMs: 100, peak: 0.12, filterType: 'lowpass', Q: 2, startAt: start });
    pulseAt += gap;
  });
  // Skarp larm-FM som tar över mot slutet (sirenlikt)
  _fmNote({ freq: 880, freqEnd: 1320, type: 'square', modType: 'sine', ratio: 1.5, modDepth: 140, durMs: 700, peak: 0.10, startAt: t + 0.50 });
  // Lågt rumble-brus genom hela
  _noise({ freq: 80, durMs: 1500, peak: 0.06, filterType: 'lowpass', Q: 1, startAt: t });
  // Slutknall — dunk
  _note({ freq: 90, freqEnd: 50, type: 'sine', durMs: 350, peak: 0.30, attack: 0.005, startAt: t + 1.20 });
  _noise({ freq: 120, durMs: 300, peak: 0.18, filterType: 'lowpass', Q: 2, startAt: t + 1.20 });
}

// Vinst: ±2.5s full segerfanfar — pomp + fanfar + klocka + bas + final stinger
function toneWinner() {
  if (!_ready()) return;
  const t = _audioCtx.currentTime;
  // Pomp-intro: tre snabba upp-arpeggios som leder in
  [0.00, 0.18, 0.36].forEach(off => {
    [261.63, 329.63, 392.00].forEach((f, i) => {
      _note({ freq: f, type: 'triangle', durMs: 80, peak: 0.18, startAt: t + off + i * 0.04 });
    });
  });
  // Fanfar-ackord (C-major triad) med olika svans
  _note({ freq: 523.25, type: 'triangle', durMs: 350, peak: 0.26, startAt: t + 0.55 }); // C5
  _note({ freq: 659.25, type: 'triangle', durMs: 350, peak: 0.24, startAt: t + 0.55 }); // E5
  _note({ freq: 783.99, type: 'triangle', durMs: 350, peak: 0.22, startAt: t + 0.55 }); // G5
  // Förhöjning: leder upp till högt C
  _note({ freq: 880,    type: 'triangle', durMs: 220, peak: 0.22, startAt: t + 0.95 });
  _note({ freq: 987.77, type: 'triangle', durMs: 220, peak: 0.22, startAt: t + 1.10 });
  // Topp-not: utdragen C6 med klocka och oktav
  _note({ freq: 1046.5, type: 'triangle', durMs: 1100, peak: 0.26, startAt: t + 1.30 });
  _fmNote({ freq: 1046.5, type: 'sine', modType: 'sine', ratio: 3, modDepth: 320, durMs: 1400, peak: 0.20, startAt: t + 1.30 });
  _fmNote({ freq: 1318.5, type: 'sine', modType: 'sine', ratio: 3, modDepth: 240, durMs: 1300, peak: 0.16, startAt: t + 1.40 });
  _fmNote({ freq: 1568.0, type: 'sine', modType: 'sine', ratio: 3, modDepth: 180, durMs: 1200, peak: 0.14, startAt: t + 1.50 });
  // Bas-grund: lång C2-C3-G2-C3 som bär hela fanfarn
  _note({ freq: 130.81, type: 'sine', durMs: 600, peak: 0.20, startAt: t + 0.55 });
  _note({ freq: 196.00, type: 'sine', durMs: 600, peak: 0.18, startAt: t + 1.10 });
  _note({ freq: 261.63, type: 'sine', durMs: 1100, peak: 0.20, startAt: t + 1.30 });
  // Final stinger — ljus brus-svisch precis innan topp-not
  _noise({ freq: 400, freqEnd: 6000, durMs: 250, peak: 0.10, filterType: 'highpass', Q: 1, startAt: t + 1.05 });
  // Final-puff på slutet
  _noise({ freq: 200, freqEnd: 100, durMs: 200, peak: 0.10, filterType: 'lowpass', Q: 1, startAt: t + 2.30 });
}

// Utslagen: ±2s förlängd sad trombone i fyra steg + slutlig puk
function toneEliminated() {
  if (!_ready()) return;
  const t = _audioCtx.currentTime;
  // Fyra fallande toner med ökande längd och dämpning
  _note({ freq: 466,  freqEnd: 415,  type: 'sawtooth', durMs: 240, peak: 0.22, startAt: t + 0.00 }); // B♭4 → A♭4
  _note({ freq: 392,  freqEnd: 349,  type: 'sawtooth', durMs: 260, peak: 0.22, startAt: t + 0.22 }); // G4 → F4
  _note({ freq: 330,  freqEnd: 277,  type: 'sawtooth', durMs: 320, peak: 0.24, startAt: t + 0.46 }); // E4 → C♯4
  _note({ freq: 247,  freqEnd: 130,  type: 'sawtooth', durMs: 900, peak: 0.28, startAt: t + 0.78 }); // B3 → C3 (lång)
  // “Wah-wah”-vibrato: låg modulerad ton parallellt på slutnoten
  _fmNote({ freq: 196, type: 'sine', modType: 'sine', ratio: 0.5, modDepth: 60, durMs: 800, peak: 0.16, startAt: t + 0.78 });
  // Låg "buu"-puff löpande
  _noise({ freq: 300, freqEnd: 60, durMs: 1200, peak: 0.10, filterType: 'lowpass', Q: 1, startAt: t + 0.40 });
  // Final puk-knall (cymbal-feel)
  _noise({ freq: 800, durMs: 350, peak: 0.18, filterType: 'highpass', Q: 1, startAt: t + 1.65 });
  _note({ freq: 65, freqEnd: 40, type: 'sine', durMs: 400, peak: 0.30, startAt: t + 1.65 });
}

function vibrate(pattern) {
  try {
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  } catch (e) { /* tyst fail */ }
}

function getValidPlayers() {
  return state.players.filter(p => p.name.trim().length > 0);
}

function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2700);
}

// ---------- SETUP ACTIONS ----------
function addPlayer() {
  if (state.players.length >= 8) return;
  state.players.push({ id: uid(), name: '', score: 0 });
  render();
}

function removePlayer(id) {
  if (state.players.length <= 2) return;
  state.players = state.players.filter(p => p.id !== id);
  render();
}

function updatePlayerName(id, name) {
  const p = state.players.find(p => p.id === id);
  if (p) p.name = name;
  // No re-render to keep input focus
  saveState();
  // Update Start-button enabled state manually
  const btn = document.getElementById('start-btn');
  if (btn) btn.disabled = !canStart();
}

function canStart() {
  const valid = getValidPlayers();
  return valid.length >= 2;
}

function startGame() {
  const valid = getValidPlayers();
  if (valid.length < 2) return;
  state.players = valid.map(p => ({ ...p, score: 0, zeroStreak: 0, eliminated: false }));
  state.currentPlayerIndex = 0;
  state.history = [];
  state.winnerId = null;
  state.screen = 'game';
  state.selectedPins = [];
  state.matchNumber = 1;
  state.matchWins = {};
  state.players.forEach(p => { state.matchWins[p.id] = 0; });
  saveState();
  render();
}

// ---------- GAME ACTIONS ----------
function nextActivePlayerIndex(fromIndex) {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    if (!state.players[idx].eliminated) return idx;
  }
  return fromIndex; // fallback
}

function applyScore(action, points) {
  const player = state.players[state.currentPlayerIndex];
  const prevScore = player.score;
  const prevIndex = state.currentPlayerIndex;
  const prevZeroStreak = player.zeroStreak || 0;
  const prevEliminated = !!player.eliminated;
  let newScore = prevScore + points;
  let actualAction = action;
  let actualPoints = points;
  let overshootHappened = false;

  // Check overshoot
  if (newScore > state.targetScore) {
    overshootHappened = true;
    if (state.overshootRule === 'reset-to-half') {
      newScore = state.overshootValue;
      actualAction = `${action} → över ${state.targetScore}, tillbaka till ${state.overshootValue}`;
    } else if (state.overshootRule === 'restart') {
      newScore = 0;
      actualAction = `${action} → över ${state.targetScore}, börjar om`;
    } else if (state.overshootRule === 'lose-turn') {
      newScore = prevScore;
      actualPoints = 0;
      actualAction = `${action} → över ${state.targetScore}, kastet räknas inte`;
    }
  }

  player.score = newScore;

  // Update zero-streak (only count actual misses, not overshoots that reverted)
  let eliminatedNow = false;
  if (state.eliminateOnZeros) {
    if (actualPoints === 0 && !overshootHappened) {
      player.zeroStreak = (player.zeroStreak || 0) + 1;
      if (player.zeroStreak >= state.zerosToEliminate) {
        player.eliminated = true;
        eliminatedNow = true;
        actualAction += ` → ${state.zerosToEliminate} missar i rad, ute ur spelet`;
      }
    } else if (!overshootHappened || state.overshootRule !== 'lose-turn') {
      // Reset on any scoring throw (or overshoot that wasn't "lose-turn")
      player.zeroStreak = 0;
    }
    // For 'lose-turn' overshoot: don't change streak (kastet räknas inte)
  }

  state.history.unshift({
    id: uid(),
    playerId: player.id,
    playerName: player.name,
    action: actualAction,
    points: actualPoints,
    actualScoreChange: newScore - prevScore,
    newScore,
    prevScore,
    prevIndex,
    prevZeroStreak,
    prevEliminated,
    eliminatedNow,
  });

  // Cap history at 50 entries
  if (state.history.length > 50) state.history.length = 50;

  // Bygg en uppläsning av registrerat resultat (används som prefix nedan)
  const scoreChange = newScore - prevScore;
  let scoreSpoken;
  if (actualPoints === 0 && !overshootHappened) {
    scoreSpoken = `Miss för ${player.name}.`;
  } else if (overshootHappened) {
    if (state.overshootRule === 'lose-turn') {
      scoreSpoken = `${player.name} sköt över ${state.targetScore}, kastet räknas inte. Kvar på ${newScore}.`;
    } else {
      scoreSpoken = `${player.name} sköt över ${state.targetScore}, tillbaka till ${newScore}.`;
    }
  } else {
    const poangOrd = actualPoints === 1 ? 'poäng' : 'poäng';
    scoreSpoken = `${actualPoints} ${poangOrd} till ${player.name}. Totalt ${newScore}.`;
  }

  // Check winner
  if (newScore === state.targetScore) {
    state.winnerId = player.id;
    state.screen = 'finished';
    vibrate([80, 60, 80, 60, 200]);
    toneWinner();
    speak(`${actualPoints} poäng. ${player.name} vinner matchen med ${state.targetScore} poäng!`);
    saveState();
    render();
    return;
  }

  // Check if only one active player left → they win by elimination
  const active = state.players.filter(p => !p.eliminated);
  if (active.length === 1 && state.players.length > 1) {
    state.winnerId = active[0].id;
    state.screen = 'finished';
    vibrate([80, 60, 80, 60, 200]);
    toneWinner();
    speak(`${scoreSpoken} ${active[0].name} vinner. Övriga slogs ut.`);
    saveState();
    render();
    return;
  }

  // Eliminering: meddela om någon precis åkte ut
  if (eliminatedNow) {
    vibrate([200, 80, 200]);
    toneEliminated();
    // Inkludera poängbeskedet i samma uppläsning
    speak(`${player.name} åkte ut, ${state.zerosToEliminate} missar i rad.`);
  }

  // Next active player
  state.currentPlayerIndex = nextActivePlayerIndex(state.currentPlayerIndex);
  saveState();
  render();

  // Tillkännage poäng + nästa spelare + ev. matchboll/sista chansen i en mening
  const nextPlayer = state.players[state.currentPlayerIndex];
  if (nextPlayer && !nextPlayer.eliminated && !eliminatedNow) {
    const matchPins = matchPointPins(nextPlayer);
    const lastStrike = isLastStrike(nextPlayer);
    if (matchPins.length > 0) {
      vibrate([40, 40, 40]);
      toneMatchball();
      speak(`${scoreSpoken} Näst på tur, ${nextPlayer.name}. Matchboll. Slå pinne ${matchPins[0]} för att vinna.`);
    } else if (lastStrike) {
      vibrate([60, 50, 60]);
      toneLastStrike();
      speak(`${scoreSpoken} Näst på tur, ${nextPlayer.name}. Sista chansen. En miss till och du åker ut.`);
    } else {
      speak(`${scoreSpoken} Näst på tur, ${nextPlayer.name}.`);
    }
  } else if (eliminatedNow && nextPlayer && !nextPlayer.eliminated) {
    // Efter eliminering: läs upp eliminering + vem som är näst
    speak(`${player.name} åkte ut, ${state.zerosToEliminate} missar i rad. Näst på tur, ${nextPlayer.name}.`);
  }
}

function togglePin(pinNumber) {
  const idx = state.selectedPins.indexOf(pinNumber);
  if (idx >= 0) {
    state.selectedPins.splice(idx, 1);
  } else {
    state.selectedPins.push(pinNumber);
    state.selectedPins.sort((a, b) => a - b);
  }
  toneClick();
  updatePinSelectionUI();
}

function clearPinSelection() {
  state.selectedPins = [];
  updatePinSelectionUI();
}

function confirmThrow() {
  const pins = state.selectedPins;
  if (pins.length === 0) {
    toneMiss();
    applyScore('Miss', 0);
    state.selectedPins = [];
    return;
  }
  toneConfirm();
  const threshold = state.numberPinThreshold;
  let points, action;
  if (pins.length <= threshold) {
    // Sum of pin numbers
    points = pins.reduce((s, n) => s + n, 0);
    action = pins.length === 1
      ? `Slog pinne ${pins[0]}`
      : `Slog pinne ${pins.join(' + ')}`;
  } else {
    // Count of pins
    points = pins.length;
    action = `Slog ${pins.length} pinnar`;
  }
  state.selectedPins = [];
  applyScore(action, points);
}

function updatePinSelectionUI() {
  // Update only the necessary parts in-place to avoid focus/scroll loss
  document.querySelectorAll('.pin-btn[data-pin]').forEach(btn => {
    const n = parseInt(btn.getAttribute('data-pin'));
    btn.classList.toggle('selected', state.selectedPins.includes(n));
  });
  const summary = document.getElementById('throw-summary');
  if (summary) summary.innerHTML = renderThrowSummaryInner();
  const confirmBtn = document.getElementById('confirm-throw-btn');
  if (confirmBtn) confirmBtn.innerHTML = renderConfirmBtnInner();
  const clearBtn = document.getElementById('clear-pins-btn');
  if (clearBtn) clearBtn.style.display = state.selectedPins.length > 0 ? '' : 'none';
}

function renderThrowSummaryInner() {
  const pins = state.selectedPins;
  if (pins.length === 0) {
    return `<div class="throw-summary-empty">Klicka på alla fällda pinnar</div>`;
  }
  const threshold = state.numberPinThreshold;
  let points, formula;
  if (pins.length <= threshold) {
    points = pins.reduce((s, n) => s + n, 0);
    formula = pins.length === 1 ? `Pinne ${pins[0]}` : `${pins.join(' + ')} = ${points}`;
  } else {
    points = pins.length;
    formula = `${pins.length} pinnar`;
  }
  return `
    <div class="throw-summary-formula">${formula}</div>
    <div class="throw-summary-points">+${points} poäng</div>
  `;
}

function renderConfirmBtnInner() {
  return state.selectedPins.length === 0 ? 'Miss / 0 poäng' : 'Klart';
}

function recordMiss() {
  toneMiss();
  applyScore('Miss', 0);
}

function undoLast() {
  if (state.history.length === 0) return;
  const last = state.history.shift();
  const player = state.players.find(p => p.id === last.playerId);
  if (player) {
    player.score = last.prevScore;
    if (typeof last.prevZeroStreak === 'number') player.zeroStreak = last.prevZeroStreak;
    if (typeof last.prevEliminated === 'boolean') player.eliminated = last.prevEliminated;
  }
  state.currentPlayerIndex = last.prevIndex;
  if (state.winnerId) {
    state.winnerId = null;
    state.screen = 'game';
  }
  saveState();
  render();
}

function resetGame() {
  state.screen = 'setup';
  state.history = [];
  state.winnerId = null;
  state.currentPlayerIndex = 0;
  state.players = state.players.map(p => ({ ...p, score: 0, zeroStreak: 0, eliminated: false }));
  state.selectedPins = [];
  state.matchNumber = 1;
  state.matchWins = {};
  saveState();
  render();
}

function startNextMatch() {
  // Tilldela seger till vinnaren av just avslutad match
  if (state.winnerId) {
    state.matchWins[state.winnerId] = (state.matchWins[state.winnerId] || 0) + 1;
  }
  state.matchNumber += 1;
  state.history = [];
  state.winnerId = null;
  // Rotera startspelare
  state.currentPlayerIndex = (state.matchNumber - 1) % state.players.length;
  state.players = state.players.map(p => ({ ...p, score: 0, zeroStreak: 0, eliminated: false }));
  state.screen = 'game';
  state.selectedPins = [];
  saveState();
  render();
}

function endSeries() {
  // Tilldela seger om matchen pǎgick, gå sedan tillbaka till setup
  if (state.winnerId) {
    state.matchWins[state.winnerId] = (state.matchWins[state.winnerId] || 0) + 1;
  }
  state.screen = 'setup';
  state.history = [];
  state.winnerId = null;
  state.currentPlayerIndex = 0;
  state.players = state.players.map(p => ({ ...p, score: 0, zeroStreak: 0, eliminated: false }));
  state.selectedPins = [];
  state.matchNumber = 1;
  state.matchWins = {};
  saveState();
  render();
}

function newGameSamePlayers() {
  state.history = [];
  state.winnerId = null;
  state.currentPlayerIndex = 0;
  state.players = state.players.map(p => ({ ...p, score: 0, zeroStreak: 0, eliminated: false }));
  state.screen = 'game';
  state.selectedPins = [];
  saveState();
  render();
}

function setScoreMode(mode) {
  state.scoreInputMode = mode;
  render();
}

function setOvershootRule(value) {
  state.overshootRule = value;
  saveState();
  render();
}

function setThreshold(value) {
  state.numberPinThreshold = value;
  saveState();
  render();
}

function setEliminationRule(value) {
  if (value === 'off') {
    state.eliminateOnZeros = false;
  } else {
    state.eliminateOnZeros = true;
    state.zerosToEliminate = parseInt(value);
  }
  saveState();
  render();
}

function testSound() {
  // Används från en knapp → garanterat user-gesture
  unlockAudio();
  const wasEnabled = state.voiceEnabled;
  state.voiceEnabled = true;
  // Showcase: spela matchboll-fanfaren med uppläsning ovanpå
  toneMatchball();
  setTimeout(() => speak('Matchboll. Slå pinne ett för att vinna.'), 200);
  if (!wasEnabled) {
    setTimeout(() => { state.voiceEnabled = wasEnabled; render(); }, 2200);
  }
}

function setVoice(enabled) {
  state.voiceEnabled = !!enabled;
  if (!state.voiceEnabled && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  } else if (state.voiceEnabled) {
    // Klicket på switchen är en user-gesture → unlås båda kanalerna
    unlockAudio();
    // Liten bekräftelse när man slår på
    toneConfirm();
  }
  saveState();
  render();
}

// Snabbtoggle från header-knappen
function toggleSound() {
  const next = !state.voiceEnabled;
  if (next) {
    // Slå på: unlås först, ställ sedan true så ljudet faktiskt hörs
    unlockAudio();
    state.voiceEnabled = true;
    toneConfirm();
  } else {
    // Stäng av: tysta direkt
    state.voiceEnabled = false;
    if ('speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch (e) {} }
  }
  saveState();
  render();
}

function radioOption(name, value, label, checked, onclickJs) {
  return `
    <button type="button" class="radio-option ${checked ? 'checked' : ''}" onclick="${onclickJs}">
      <span class="radio-dot"></span>
      <span class="radio-label">${label}</span>
    </button>
  `;
}

// ---------- RENDER ----------
const app = document.getElementById('app');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderHeader() {
  return `
    <div class="app-header">
      <div class="logo">
        <div class="logo-mark">K</div>
        <span>Nummerkubb</span>
      </div>
      <div class="header-actions">
        <button class="sound-toggle ${state.voiceEnabled ? '' : 'is-off'}" onclick="toggleSound()" aria-label="${state.voiceEnabled ? 'Stäng av ljud' : 'Slå på ljud'}" aria-pressed="${state.voiceEnabled}" title="Ljud ${state.voiceEnabled ? 'på' : 'av'}">
          <svg class="icon-sound-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 5L6 9H2v6h4l5 4V5z"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
          </svg>
          <svg class="icon-sound-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 5L6 9H2v6h4l5 4V5z"/>
            <line x1="23" y1="9" x2="17" y2="15"/>
            <line x1="17" y1="9" x2="23" y2="15"/>
          </svg>
        </button>
        <button class="theme-toggle" onclick="toggleTheme()" aria-label="Växla mellan mörkt och ljust läge" title="Växla tema">
          <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
          <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4"/>
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
          </svg>
        </button>
        ${state.screen !== 'setup' ? `
          <button class="icon-btn" onclick="resetGame()" aria-label="Nytt spel">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7"/>
              <path d="M3 4v5h5"/>
            </svg>
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

function renderSetup() {
  return `
    ${renderHeader()}
    <div class="card">
      <h1>Nytt spel</h1>
      <p class="subtitle">Lägg till 2–8 spelare och starta. Först till exakt ${state.targetScore} poäng vinner.</p>

      <div class="setup-section">
        <h3>Spelare (${getValidPlayers().length}/${state.players.length})</h3>
        <div id="players-inputs">
          ${state.players.map((p, i) => `
            <div class="player-input-row">
              <input
                class="player-input"
                type="text"
                placeholder="Spelare ${i + 1}"
                value="${escapeHtml(p.name)}"
                maxlength="20"
                oninput="updatePlayerName(${p.id}, this.value)"
              />
              <button class="remove-btn" onclick="removePlayer(${p.id})" ${state.players.length <= 2 ? 'disabled' : ''} aria-label="Ta bort spelare">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                  <path d="M5 12h14"/>
                </svg>
              </button>
            </div>
          `).join('')}
        </div>
        <button class="add-player-btn" onclick="addPlayer()" ${state.players.length >= 8 ? 'disabled' : ''}>
          + Lägg till spelare
        </button>
      </div>

      <div class="setup-section">
        <h3>Inställningar</h3>
        <div class="settings-grid">
          <div class="setting">
            <label for="target">Målpoäng</label>
            <input id="target" type="number" min="10" max="200" step="1" value="${state.targetScore}"
              onchange="state.targetScore = Math.max(10, Math.min(200, parseInt(this.value) || 50)); saveState();" />
          </div>
          <div class="setting">
            <label for="pins">Antal pinnar</label>
            <input id="pins" type="number" min="2" max="20" step="1" value="${state.maxPins}"
              onchange="state.maxPins = Math.max(2, Math.min(20, parseInt(this.value) || 12)); saveState(); render();" />
          </div>
          <div class="setting setting-full">
            <label>Vid övertramp</label>
            <div class="radio-group">
              ${radioOption('overshoot', 'reset-to-half', 'Tillbaka till poäng', state.overshootRule === 'reset-to-half', 'setOvershootRule(\'reset-to-half\')')}
              ${radioOption('overshoot', 'restart', 'Börja om från 0', state.overshootRule === 'restart', 'setOvershootRule(\'restart\')')}
              ${radioOption('overshoot', 'lose-turn', 'Kastet räknas inte', state.overshootRule === 'lose-turn', 'setOvershootRule(\'lose-turn\')')}
            </div>
          </div>
          <div class="setting ${state.overshootRule === 'reset-to-half' ? '' : 'hidden'}" id="reset-setting">
            <label for="reset">Tillbaka till</label>
            <input id="reset" type="number" min="0" max="100" step="1" value="${state.overshootValue}"
              onchange="state.overshootValue = Math.max(0, parseInt(this.value) || 25); saveState();" />
          </div>
          <div class="setting setting-full">
            <label>Summera siffror upp till</label>
            <div class="radio-group">
              ${radioOption('threshold', '1', '1 pinne (standard)', state.numberPinThreshold === 1, 'setThreshold(1)')}
              ${radioOption('threshold', '2', '1–2 pinnar (summa)', state.numberPinThreshold === 2, 'setThreshold(2)')}
            </div>
          </div>
          <div class="setting setting-full">
            <label>Slag ut vid missar i rad</label>
            <div class="radio-group radio-group-grid">
              ${radioOption('elim', 'off', 'Av', !state.eliminateOnZeros, 'setEliminationRule(\'off\')')}
              ${radioOption('elim', '2', '2 i rad', state.eliminateOnZeros && state.zerosToEliminate === 2, 'setEliminationRule(\'2\')')}
              ${radioOption('elim', '3', '3 i rad', state.eliminateOnZeros && state.zerosToEliminate === 3, 'setEliminationRule(\'3\')')}
              ${radioOption('elim', '4', '4 i rad', state.eliminateOnZeros && state.zerosToEliminate === 4, 'setEliminationRule(\'4\')')}
            </div>
          </div>
          <div class="setting setting-full">
            <div class="setting-toggle">
              <div class="setting-toggle-text">
                <span class="setting-toggle-label">Ljud &amp; röst</span>
                <span class="setting-toggle-hint">Slås på/av i toppen. Tryck Testa för att höra fanfaren.</span>
              </div>
              <button type="button" class="sound-test-btn" onclick="testSound()">
                🔊 Testa
              </button>
            </div>
          </div>
        </div>
      </div>

      <button id="start-btn" class="primary-btn" onclick="startGame()" ${!canStart() ? 'disabled' : ''}>
        Starta spel
      </button>
    </div>
  `;
}

function renderLiveScoreStrip() {
  // Topprad: live-poäng för alla spelare, kompakt
  const currentId = state.players[state.currentPlayerIndex] && state.players[state.currentPlayerIndex].id;
  const items = state.players.map(p => {
    const firstName = (p.name.split(' ')[0] || p.name);
    const isCurrent = p.id === currentId && !p.eliminated;
    const isElim = p.eliminated;
    return `<span class="live-score-item ${isCurrent ? 'current' : ''} ${isElim ? 'eliminated' : ''}">
      <span class="live-score-name">${escapeHtml(firstName)}</span>
      <span class="live-score-value">${p.score}</span>
    </span>`;
  }).join('');
  return `
    <div class="live-score-strip">
      <div class="live-score-list">${items}</div>
    </div>
  `;
}

function renderGame() {
  const current = state.players[state.currentPlayerIndex];
  const remaining = state.targetScore - current.score;
  const pins = Array.from({ length: state.maxPins }, (_, i) => i + 1);
  const activeCount = state.players.filter(p => !p.eliminated).length;
  const matchPins = matchPointPins(current);
  const hasMatchBall = matchPins.length > 0;
  const lastStrike = isLastStrike(current);
  const alertMode = hasMatchBall ? 'matchball' : (lastStrike ? 'laststrike' : '');

  return `
    ${renderHeader()}

    ${renderLiveScoreStrip()}

    ${alertMode === 'matchball' ? `
      <div class="alert-banner alert-matchball" role="alert">
        <span class="alert-icon">✨</span>
        <span class="alert-text">MATCHBOLL — slå pinne <strong>${matchPins[0]}</strong></span>
      </div>
    ` : ''}
    ${alertMode === 'laststrike' ? `
      <div class="alert-banner alert-laststrike" role="alert">
        <span class="alert-icon">⚠</span>
        <span class="alert-text">SISTA CHANSEN — en miss till och du åker ut</span>
      </div>
    ` : ''}

    <div class="current-player-bar ${alertMode ? 'alert-' + alertMode : ''}">
      <div class="current-player-bar-info">
        <div class="current-player-bar-label">Tur • ${activeCount} kvar</div>
        <div class="current-player-bar-name">${escapeHtml(current.name)}</div>
      </div>
      <div class="current-player-bar-score-block">
        <div class="current-player-bar-score">${current.score}</div>
        <div class="current-player-bar-target">${remaining} kvar</div>
      </div>
    </div>
    ${state.eliminateOnZeros && (current.zeroStreak || 0) > 0 && !lastStrike ? `
      <div class="streak-warning streak-warning-bar">
        ${renderStreakDots(current.zeroStreak || 0, state.zerosToEliminate)}
        <span>${current.zeroStreak}/${state.zerosToEliminate} missar i rad</span>
      </div>
    ` : ''}

    <div class="score-section-compact">
      <div id="throw-summary" class="throw-summary throw-summary-compact">
        ${renderThrowSummaryInner()}
      </div>

      <div class="pin-grid pin-grid-compact">
        ${pins.map(n => {
          const isMatchBall = matchPins.includes(n);
          return `<button class="pin-btn pin-btn-compact ${state.selectedPins.includes(n) ? 'selected' : ''} ${isMatchBall ? 'matchball-pin' : ''}" data-pin="${n}" onclick="togglePin(${n})">${n}</button>`;
        }).join('')}
      </div>

      <div class="score-action-row">
        <button id="clear-pins-btn" class="clear-pins-btn" onclick="clearPinSelection()" style="display:${state.selectedPins.length > 0 ? '' : 'none'}">
          Rensa
        </button>
        <button id="confirm-throw-btn" class="confirm-throw-btn confirm-throw-btn-compact" onclick="confirmThrow()">
          ${renderConfirmBtnInner()}
        </button>
      </div>
    </div>

    <div class="below-fold-divider" aria-hidden="true">
      <span>Detaljer</span>
    </div>

    <div class="card">
      <h3>Ställning</h3>
      <div class="players-list">
        ${state.players.map((p, i) => `
          <div class="player-row ${i === state.currentPlayerIndex && !p.eliminated ? 'active' : ''} ${p.eliminated ? 'eliminated' : ''}">
            <div class="player-row-info">
              <div class="player-row-dot"></div>
              <div class="player-row-name">${escapeHtml(p.name)}${p.eliminated ? ' — ute' : ''}</div>
            </div>
            <div class="player-row-score-group">
              <div class="player-row-wins" title="Matchvinster">${state.matchWins[p.id] || 0} W</div>
              <div class="player-row-score">${p.score}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="card">
      <h3>Historik</h3>
      ${state.history.length === 0
        ? `<div class="history-empty">Inga kast ännu</div>`
        : `<div class="history-list">
            ${state.history.slice(0, 50).map(h => {
              const cls = h.actualScoreChange > 0 ? 'positive' : (h.actualScoreChange < 0 ? 'negative' : 'neutral');
              const sign = h.actualScoreChange > 0 ? '+' : '';
              return `
                <div class="history-row">
                  <div class="history-row-info">
                    <div class="history-row-name">${escapeHtml(h.playerName)}</div>
                    <div class="history-row-action">${escapeHtml(h.action)}</div>
                  </div>
                  <div class="history-row-score ${cls}">${sign}${h.actualScoreChange} → ${h.newScore}</div>
                </div>
              `;
            }).join('')}
          </div>`}
      <button class="undo-btn" onclick="undoLast()" ${state.history.length === 0 ? 'disabled' : ''}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7v6h6"/>
          <path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>
        </svg>
        Ångra senaste kast
      </button>
    </div>

    <div class="card">
      <h3>Serie</h3>
      <div class="series-detail">
        <div class="series-detail-row">
          <span class="series-detail-label">Aktuell match</span>
          <span class="series-detail-value">${state.matchNumber}</span>
        </div>
        ${[...state.players].sort((a, b) => (state.matchWins[b.id] || 0) - (state.matchWins[a.id] || 0)).map(p => `
          <div class="series-detail-row">
            <span class="series-detail-label">${escapeHtml(p.name)}</span>
            <span class="series-detail-value">${state.matchWins[p.id] || 0} ${(state.matchWins[p.id] || 0) === 1 ? 'vinst' : 'vinster'}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderWinner() {
  const winner = state.players.find(p => p.id === state.winnerId);
  const wonByScore = winner && winner.score === state.targetScore;
  return `
    ${renderHeader()}

    <div class="card">
      <h3>Match ${state.matchNumber} — Slutställning</h3>
      <div class="players-list">
        ${[...state.players].sort((a, b) => b.score - a.score).map(p => `
          <div class="player-row ${p.id === state.winnerId ? 'winner' : ''} ${p.eliminated ? 'eliminated' : ''}">
            <div class="player-row-info">
              <div class="player-row-dot"></div>
              <div class="player-row-name">${escapeHtml(p.name)}${p.eliminated ? ' — ute' : ''}</div>
            </div>
            <div class="player-row-score">${p.score}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="modal-backdrop">
      <div class="modal">
        <span class="modal-trophy">🏆</span>
        <div class="modal-title">Vinnare av match ${state.matchNumber}</div>
        <div class="modal-winner-name">${escapeHtml(winner ? winner.name : '')}</div>
        <div class="modal-message">${wonByScore
          ? `Nådde exakt ${state.targetScore} poäng`
          : `Sista spelaren kvar — övriga slogs ut`}</div>
        <div class="modal-series-summary">
          ${[...state.players].sort((a, b) => {
            const aw = (state.matchWins[a.id] || 0) + (a.id === state.winnerId ? 1 : 0);
            const bw = (state.matchWins[b.id] || 0) + (b.id === state.winnerId ? 1 : 0);
            return bw - aw;
          }).map(p => {
            const w = (state.matchWins[p.id] || 0) + (p.id === state.winnerId ? 1 : 0);
            return `<div class="modal-series-row ${p.id === state.winnerId ? 'highlight' : ''}">
              <span>${escapeHtml(p.name)}</span>
              <span><strong>${w}</strong> ${w === 1 ? 'vinst' : 'vinster'}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="modal-actions">
          <button class="primary-btn" style="margin-top:0" onclick="startNextMatch()">Nästa match</button>
          <button class="secondary-btn" onclick="endSeries()">Avsluta serien</button>
          <button class="undo-btn" style="margin-top:0" onclick="undoLast()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7v6h6"/>
              <path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>
            </svg>
            Ångra senaste kast
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderStreakDots(current, total) {
  let html = '<div class="streak-dots">';
  for (let i = 0; i < total; i++) {
    const filled = i < current;
    html += `<span class="streak-dot ${filled ? 'filled' : ''}"></span>`;
  }
  html += '</div>';
  return html;
}

function render() {
  if (state.screen === 'setup') {
    app.innerHTML = renderSetup();
  } else if (state.screen === 'game') {
    app.innerHTML = renderGame();
  } else if (state.screen === 'finished') {
    app.innerHTML = renderWinner();
  }
}

// Expose to global for inline handlers
window.addPlayer = addPlayer;
window.removePlayer = removePlayer;
window.updatePlayerName = updatePlayerName;
window.startGame = startGame;
window.recordMiss = recordMiss;
window.togglePin = togglePin;
window.clearPinSelection = clearPinSelection;
window.confirmThrow = confirmThrow;
window.undoLast = undoLast;
window.resetGame = resetGame;
window.newGameSamePlayers = newGameSamePlayers;
window.startNextMatch = startNextMatch;
window.endSeries = endSeries;
window.setOvershootRule = setOvershootRule;
window.setEliminationRule = setEliminationRule;
window.setVoice = setVoice;
window.toggleSound = toggleSound;
window.testSound = testSound;
window.setThreshold = setThreshold;
window.state = state;
window.saveState = saveState;
window.render = render;

// ---------- THEME ----------
function setTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  // Uppdatera browser theme-color meta för status bar
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f5f7fa' : '#0f172a');
}

function toggleTheme() {
  setTheme(state.theme === 'dark' ? 'light' : 'dark');
}

function initTheme() {
  // Respektera systemets fördragna läge vid första start
  let initial = 'dark';
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      initial = 'light';
    }
  } catch (e) { /* fallback dark */ }
  setTheme(initial);
}

window.toggleTheme = toggleTheme;
window.setTheme = setTheme;

// Init
initTheme();
installAudioUnlock();
checkVoiceAvailable();
render();
