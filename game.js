'use strict';

/* =========================================================
   EMPIRE: WARGAME DELUXE
   Rundenbasiertes Strategiespiel im Empire-Stil.
   Mehrspieler (1-4 KI-Gegner, freie Feindschaft, keine Diplomatie),
   Kontinent-/Insel-Karten, Land/See/Luft-Einheiten inkl. Träger,
   Schlacht- und Transportschiffe, Wegpunkt-Marschbefehle,
   Rasten/Warten/Befestigen-Stationsbefehle.
   ========================================================= */

/* ---------- AUDIO: zwei Musikstücke, abwechselnd (zufälliger Start) ---------- */
const MusicEngine = (() => {
  let playing = false;
  let muted = false;
  let trackIndex = 0;

  const TRACKS = ['audio/disciplined-march.mp3', 'audio/march-of-resolve.mp3'];
  const audio = new Audio();
  audio.volume = 0.5;
  audio.addEventListener('ended', () => {
    trackIndex = 1 - trackIndex;
    playCurrent();
  });

  function playCurrent(){
    audio.src = TRACKS[trackIndex];
    if(!muted) audio.play().catch(()=>{});
  }

  return {
    start(){
      if(playing) return;
      playing = true;
      trackIndex = Math.random() < 0.5 ? 0 : 1; // abwechselnd, zufällig beginnend
      playCurrent();
    },
    toggleMute(){
      muted = !muted;
      if(muted) audio.pause();
      else audio.play().catch(()=>{});
      return muted;
    },
    isMuted(){ return muted; }
  };
})();

/* ---------- KONSTANTEN: KARTE ---------- */
let COLS = 26, ROWS = 17;
const BASE_TILE = 48;
const MIN_ZOOM = 0.4, MAX_ZOOM = 2.2;
const DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
const DIRS4 = [[1,0],[-1,0],[0,1],[0,-1]];

// Kartengrößen (vervierfachte Fläche gegenüber der ursprünglichen Version)
const SIZE_PRESETS = {
  small:  { cols:36, rows:24 },
  medium: { cols:52, rows:34 },
  large:  { cols:68, rows:44 },
  huge:   { cols:136, rows:88 }, // vierfache Fläche von "Groß"
  giant:  { cols:192, rows:124 }, // doppelte Fläche von "Sehr Groß"
  archipelago: { cols:192, rows:124 } // doppelte Fläche von "Sehr Groß", feste Größe
};
const CITY_TILES_PER_CITY = { sparse:70, normal:44, dense:28 };

let mapConfig = { mode:'classic', size:'medium', landform:'continent', landAmount:'normal', cities:'normal', aiCount:1, fogOfWar:'off', animEnabled:'on', graphics:'sprites' };
// Grafik-Umschalter für Leute, die den schlichten Vektor-Look bevorzugen — die eigentliche
// Umschaltung passiert dadurch, dass spriteReady()/terrainSpriteReady()/citySpriteReady()
// hierüber gehen: bei 'vector' melden sie einfach "kein Sprite verfügbar", und die überall
// schon vorhandene Vektor-Fallback-Zeichnung greift automatisch, ganz ohne render()-Änderung.
function graphicsEnabled(){ return mapConfig.graphics !== 'vector'; }
// Enhanced ist rein additiv: alle Classic-Funktionen bleiben unverändert, Enhanced schaltet
// per isEnhanced()-Abfrage INNERHALB derselben Funktionen zusätzliches Verhalten frei —
// niemals über eine separate/kopierte Funktion. Dadurch wirken künftige Classic-Änderungen
// automatisch auch im Enhanced-Modus.
function isEnhanced(){ return mapConfig.mode === 'enhanced'; }
let animSpeed = 5; // 1 (langsam) .. 10 (schnell)
let fogEnabled = false;

const T_PLAIN = 'plain';
const T_FOREST = 'forest';
const T_HILLS = 'hills';
const T_MOUNTAIN = 'mountain';
const T_WATER = 'water';
const T_CITY = 'city';
const T_AIRPORT = 'airport';
const T_RADAR = 'radar'; // Enhanced: von Ingenieuren gebaute Struktur, siehe tryCaptureStructure

const MOVE_COST = { [T_PLAIN]:1, [T_FOREST]:2, [T_HILLS]:2, [T_MOUNTAIN]:3, [T_WATER]:1, [T_CITY]:1, [T_AIRPORT]:1, [T_RADAR]:1 };
const SIGHT_RANGE = { ground:2, air:4 };
const RADAR_SIGHT_RANGE = 12; // Enhanced: Radius, den eine Radarstation dauerhaft aufdeckt

/* ---------- KONSTANTEN: SPIELER ---------- */
const OWNER_PLAYER = 'player';
const OWNER_NEUTRAL = 'neutral';
const AI_OWNER_POOL = ['ai1','ai2','ai3','ai4'];
const OWNER_LABEL = { player:'Du', ai1:'KI 1', ai2:'KI 2', ai3:'KI 3', ai4:'KI 4', neutral:'Neutral' };
const OWNER_COLORS = {
  player: '#3fa9f5',
  ai1:    '#f5473f',
  ai2:    '#f5a63f',
  ai3:    '#b06bf0',
  ai4:    '#3ff0a6',
  neutral:'#8a8f9a'
};

let aiOwners = ['ai1'];       // je nach Gegneranzahl gesetzt
let turnOrder = [OWNER_PLAYER, 'ai1'];
let turnIndex = 0;

/* ---------- KONSTANTEN: EINHEITEN ---------- */
const EFFECTIVENESS = ['fresh','rested','ready','used','tired','exhausted'];
const EFFECTIVENESS_NAME = { fresh:'Frisch', rested:'Ausgeruht', ready:'Bereit', used:'Beansprucht', tired:'Müde', exhausted:'Erschöpft' };
const EXPERIENCE = ['green','proven','hardened'];
const EXPERIENCE_NAME = { green:'Grün', proven:'Erprobt', hardened:'Abgehärtet' };
const EXPERIENCE_CAP = { green:2, proven:1, hardened:0 };
const EXPERIENCE_WINS_NEEDED = { proven:3, hardened:6 };

// power/defense = Trefferchance-Faktoren, dmg = Schaden/Treffer, hp = Trefferpunkte.
// Werte grob am Original "Empire" orientiert (eigene, angepasste Balance).
const UNIT_STATS = {
  infantry:   { name:'Infanterie',    label:'I', category:'ground', subclass:'land', move:3,  dmg:1, power:50, defense:50, hp:3,  cost:10, range:0, canDigIn:true },
  tank:       { name:'Panzer',        label:'T', category:'ground', subclass:'land', move:6,  dmg:2, power:65, defense:55, hp:5,  cost:20, range:0, canDigIn:true, captureMorph:'infantry' },
  artillery:  { name:'Artillerie',    label:'A', category:'ground', subclass:'land', move:3,  dmg:2, power:55, defense:35, hp:3,  cost:18, range:2, canDigIn:true, canDefensiveFire:true },
  destroyer:  { name:'Zerstörer',     label:'D', category:'ground', subclass:'sea',  move:6,  dmg:2, power:60, defense:50, hp:6,  cost:22, range:1, canDefensiveFire:true, portageCapacity:1, canCarry:['infantry','artillery'] },
  transport:  { name:'Transportschiff', label:'X', category:'ground', subclass:'sea', move:5, dmg:1, power:25, defense:30, hp:5,  cost:22, range:0, portageCapacity:4, canCarry:['infantry','tank','artillery'] },
  battleship: { name:'Schlachtschiff', label:'B', category:'ground', subclass:'sea', move:5,  dmg:4, power:70, defense:65, hp:12, cost:46, range:2, canDefensiveFire:true },
  carrier:    { name:'Träger',        label:'C', category:'ground', subclass:'sea',  move:5,  dmg:1, power:35, defense:50, hp:9,  cost:42, range:0, portageCapacity:3, canCarry:['fighter','helicopter'] },
  submarine:  { name:'U-Boot',        label:'U', category:'ground', subclass:'sea',  move:5,  dmg:2, power:70, defense:30, hp:4,  cost:24, range:0, canDive:true },
  helicopter: { name:'Helikopter',    label:'H', category:'air',    subclass:null,   move:6,  dmg:1, power:50, defense:40, hp:3,  cost:18, range:0, noMountain:true },
  fighter:    { name:'Jäger',         label:'F', category:'air',    subclass:null,   move:10, dmg:1, power:60, defense:30, hp:2,  cost:25, range:0, fuel:8 },
  // Enhanced-exklusiv: kein Angriff (dmg:0 -> gewinnt nie einen Kampf, siehe selectUnit),
  // baut Straßen/Eisenbahn/Festungen/Radar/Flughäfen, siehe advanceConstruction.
  engineer:   { name:'Ingenieur',     label:'E', category:'ground', subclass:'land', move:3,  dmg:0, power:10, defense:25, hp:2,  cost:15, range:0, canBuild:true }
};
const BUILD_ORDER = ['infantry','tank','artillery','destroyer','transport','battleship','carrier','submarine','helicopter','fighter'];
// Enhanced hängt den Ingenieur zusätzlich an — überall dort verwenden, wo Baumenü/KI-
// Gewichtung/Einheiten-Übersicht die buildbaren Typen auflisten, statt BUILD_ORDER direkt.
function buildOrderFor(){ return isEnhanced() ? [...BUILD_ORDER, 'engineer'] : BUILD_ORDER; }

// Enhanced: Stadt-Spezialisierung — passende Einheitentypen werden 20% günstiger/schneller
// gebaut. Umbauzeit: 10 Runden bei erstmaliger Wahl, 15 Runden beim Wechsel einer
// bestehenden Spezialisierung; in der Zeit läuft keine Produktion (siehe processCityProduction).
const CITY_SPECIALIZATIONS = {
  arms:    { name:'Rüstungsindustrie', icon:'⚔️', types:['infantry','tank','artillery'] },
  airbase: { name:'Flugwerft',         icon:'🛩️', types:['fighter','helicopter'] },
  harbor:  { name:'Hafen',             icon:'⚓', types:['destroyer','transport','battleship','carrier','submarine'] }
};
function effectiveBuildCost(tile, type){
  const base = UNIT_STATS[type].cost;
  if(isEnhanced() && tile.specialization && CITY_SPECIALIZATIONS[tile.specialization].types.includes(type)){
    return Math.max(1, Math.round(base * 0.8));
  }
  return base;
}

const CITY_PRODUCTION = 3;
const CAPITAL_PRODUCTION = 5;

const LEVEL_TARGETS = {
  air:    ['air','ground'],
  ground: ['air','ground','sub'],
  sub:    ['ground','sub']
};

/* ---------- SPIELZUSTAND ---------- */
let map = [];
let landmassId = [];        // -1 = Wasser, sonst Landmassen-Index (für KI-Transportlogik)
let units = [];
let unitIdCounter = 1;
let currentTurnOwner = OWNER_PLAYER;
let turnNumber = 1;
let selectedUnit = null;
let reachableTiles = [];
let reachDist = {};
let attackableTiles = [];
let rangedTiles = [];
let rangeRadiusTiles = []; // alle Felder innerhalb der Fernkampf-Reichweite, unabhängig von einem Ziel dort
let unloadTiles = [];
let unloadingCargoUnit = null;
let gameOver = false;
let coalitionAgainst = null; // Enhanced: owner-id, gegen den sich alle anderen verbünden
let lastStandActive = false; // Enhanced: ab 80% Städtekontrolle einer Partei aktiv
let selectedBuildCity = null;
let awaitingWaypointClick = false;
let awaitingPatrolStep = 0; // 0=inaktiv, 1=wartet auf Punkt A, 2=wartet auf Punkt B
let patrolPointA = null;
let awaitingRallyClick = null; // {x,y} der Stadt, für die gerade ein Sammelpunkt gesetzt wird
let awaitingEngineerOrder = null; // Enhanced: {kind:'road'|'rail'}, wartet auf Zielklick
let dragPreviewTarget = null;
const ENGINEER_BUILD_LABEL = { road:'Straße', rail:'Eisenbahn', fortress:'Festung', radar:'Radar', airport:'Flughafen', rebuild:'Wiederaufbau' };

const camera = { x:0, y:0, zoom:1 };

/* ---------- CANVAS SETUP ---------- */
const gameCanvas = document.getElementById('game-canvas');
const gctx = gameCanvas.getContext('2d');
const mapWrap = document.getElementById('map-wrap');
const minimapCanvas = document.getElementById('minimap-canvas');
const mctx = minimapCanvas.getContext('2d');

function worldW(){ return COLS * BASE_TILE; }
function worldH(){ return ROWS * BASE_TILE; }
function key(x,y){ return x+','+y; }

function worldToScreen(wx, wy){
  return { x: (wx - camera.x) * camera.zoom, y: (wy - camera.y) * camera.zoom };
}
function screenToWorld(sx, sy){
  return { x: camera.x + sx / camera.zoom, y: camera.y + sy / camera.zoom };
}

function clampCamera(){
  const viewW = gameCanvas.width / camera.zoom;
  const viewH = gameCanvas.height / camera.zoom;
  const maxX = Math.max(0, worldW() - viewW);
  const maxY = Math.max(0, worldH() - viewH);
  camera.x = Math.min(Math.max(camera.x, 0), maxX);
  camera.y = Math.min(Math.max(camera.y, 0), maxY);
  if(worldW() <= viewW) camera.x = (worldW() - viewW) / 2;
  if(worldH() <= viewH) camera.y = (worldH() - viewH) / 2;
}

function resizeCanvas(){
  gameCanvas.width = mapWrap.clientWidth;
  gameCanvas.height = mapWrap.clientHeight;
  clampCamera();
  render();
}
window.addEventListener('resize', resizeCanvas);

function zoomAt(factor, sx, sy){
  const before = screenToWorld(sx, sy);
  camera.zoom = Math.min(Math.max(camera.zoom * factor, MIN_ZOOM), MAX_ZOOM);
  const after = screenToWorld(sx, sy);
  camera.x += (before.x - after.x);
  camera.y += (before.y - after.y);
  clampCamera();
  render();
}

function centerCameraOn(wx, wy){
  camera.x = wx - (gameCanvas.width / camera.zoom) / 2;
  camera.y = wy - (gameCanvas.height / camera.zoom) / 2;
  clampCamera();
  render();
}

function inBounds(x,y){ return x>=0 && x<COLS && y>=0 && y<ROWS; }

// Straßen/Schienen-Autotiling: liefert die Himmelsrichtungen, in denen ein Nachbar
// mit demselben Feld (road/rail) existiert, damit render() pro Kachel nur Segmente von
// der Mitte zu den tatsächlich verbundenen Kanten zeichnet — dasselbe Segment-Set ergibt
// automatisch Geraden (2 gegenüberliegende Richtungen), Kurven (2 benachbarte), Abzweige
// und Sackgassen, ohne Sonderfälle pro Form.
const CONNECT_DIRS = [{dx:0,dy:-1},{dx:0,dy:1},{dx:1,dy:0},{dx:-1,dy:0}];
function connectedDirs(x, y, field){
  const dirs = [];
  for(const d of CONNECT_DIRS){
    const nx = x+d.dx, ny = y+d.dy;
    if(inBounds(nx,ny) && map[ny][nx][field]) dirs.push(d);
  }
  return dirs;
}
function activeOwners(){ return [OWNER_PLAYER, ...aiOwners]; }

/* ---------- BEWEGUNGSANIMATION ---------- */
// Rein kosmetisch: der Spielzustand hat die Einheit bereits an ihrer echten Zielposition,
// hier wird nur ein kurzes Hingleiten von der alten zur neuen Position animiert.
function animEnabledNow(){ return mapConfig.animEnabled !== 'off'; }
function animDurationMs(){ return Math.round(700 - (animSpeed-1) * 58); } // Stufe 1≈700ms, Stufe 10≈178ms
let animRafRunning = false;
function ensureAnimLoop(){
  if(animRafRunning) return;
  animRafRunning = true;
  function loop(){
    // Ablaufene Animationen hier zentral für ALLE Einheiten beenden, nicht erst beim
    // Zeichnen (drawUnit) — sonst bleibt _animFrom für Einheiten außerhalb des
    // Kamera-Ausschnitts oder unter Nebel des Krieges (die nie gezeichnet werden) für
    // immer hängen, obwohl ihre Animation längst vorbei ist.
    const now = performance.now();
    let stillAnimating = dustParticles.length > 0;
    for(const u of units){
      if(!u._animFrom) continue;
      if(now - u._animStart < u._animDuration) stillAnimating = true;
      else u._animFrom = null;
    }
    render();
    if(stillAnimating) requestAnimationFrame(loop);
    else animRafRunning = false;
  }
  requestAnimationFrame(loop);
}
function queueMoveAnim(unit, fromX, fromY){
  if(!animEnabledNow()) return;
  if(fromX===unit.x && fromY===unit.y) return;
  unit._animFrom = {x:fromX, y:fromY};
  unit._animStart = performance.now();
  unit._animDuration = animDurationMs();
  ensureAnimLoop();
  spawnDustTrail(unit, fromX, fromY);
}

// Ambiente Dauerschleife nur für den Wasser-Schimmer, unabhängig von Einheiten-Animation
// (die läuft nur bei tatsächlicher Bewegung) — bewusst auf ~6 Bilder/Sekunde gedrosselt
// statt volle Framerate, und stoppt sich selbst, sobald der Spielbildschirm verlassen wird.
let shimmerRafRunning = false;
const SHIMMER_INTERVAL_MS = 160;
function ensureShimmerLoop(){
  if(shimmerRafRunning) return;
  shimmerRafRunning = true;
  let lastTick = 0;
  function loop(){
    if(document.getElementById('game-screen').classList.contains('hidden')){
      shimmerRafRunning = false;
      return;
    }
    const now = performance.now();
    if(now - lastTick >= SHIMMER_INTERVAL_MS){
      lastTick = now;
      if(!animRafRunning) render(); // Bewegungs-Loop rendert ohnehin schon jeden Frame
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

/* ---------- BEWEGUNGS-STAUBWOLKE ---------- */
// Rein kosmetisch, wie die Bewegungsanimation: ein paar kurzlebige, verblassende Punkte
// hinter Boden-Einheiten beim Loslaufen. Läuft über denselben ensureAnimLoop() mit, der
// beim Zeichnen (drawUnit) noch weitere Staub-Punkte entlang des Animationswegs nachlegt
// und beendet sich automatisch, sobald sowohl Einheiten-Animation als auch Staub fertig sind.
let dustParticles = [];
function spawnDustTrail(unit, fromX, fromY){
  if(!graphicsEnabled()) return;
  const s = UNIT_STATS[unit.type];
  if(s.subclass !== 'land') return; // nur Infanterie/Panzer/Artillerie/Ingenieur wirbeln Staub auf
  spawnDustAt(fromX, fromY);
}
function spawnDustAt(tx, ty){
  const now = performance.now();
  for(let i=0;i<3;i++){
    dustParticles.push({
      x: tx + 0.5 + (Math.random()-0.5)*0.4,
      y: ty + 0.5 + (Math.random()-0.5)*0.4,
      start: now,
      duration: 380 + Math.random()*220,
      dx: (Math.random()-0.5)*0.5,
      dy: (Math.random()-0.5)*0.5,
      size: 0.14 + Math.random()*0.1
    });
  }
}
function drawDustParticles(now){
  if(dustParticles.length===0) return;
  for(const p of dustParticles){
    const t = (now - p.start) / p.duration;
    if(t>=1) continue;
    const wx = (p.x + p.dx*t) * BASE_TILE;
    const wy = (p.y + p.dy*t) * BASE_TILE;
    const scr = worldToScreen(wx, wy);
    const tsz = BASE_TILE * camera.zoom;
    const alpha = 0.35 * (1-t);
    const r = tsz * p.size * (0.6 + 0.4*t);
    gctx.fillStyle = `rgba(196,172,132,${alpha.toFixed(3)})`;
    gctx.beginPath();
    gctx.arc(scr.x, scr.y, r, 0, Math.PI*2);
    gctx.fill();
  }
  dustParticles = dustParticles.filter(p => (now - p.start) < p.duration);
}

/* ---------- KAMPF-DARSTELLUNG (Sound + Blinken), nur bei Spieleraktionen ---------- */
// Blockiert Eingaben kurz, damit man das Kampfgeschehen sehen kann, statt dass sofort
// zur nächsten Einheit weitergesprungen wird.
let inputLocked = false;
let combatFx = null; // { a:{x,y,type,owner}, d:{x,y,type,owner}, blinkOn }

const COMBAT_SOUND = {
  fighter: 'audio/combat-aircraft.mp3',
  helicopter: 'audio/combat-helicopter.mp3',
  artillery: 'audio/combat-artillery.mp3',
  infantry: 'audio/combat-infantry.mp3',
  tank: 'audio/combat-tank.mp3',
  destroyer: 'audio/combat-naval.mp3',
  transport: 'audio/combat-naval.mp3',
  battleship: 'audio/combat-naval.mp3',
  carrier: 'audio/combat-naval.mp3',
  submarine: 'audio/combat-submarine.mp3'
};

function playCombatSound(attackerType){
  const src = COMBAT_SOUND[attackerType];
  if(!src) return;
  const sfx = new Audio(src);
  sfx.volume = 0.75;
  sfx.play().catch(()=>{});
}

// Zeigt eine kurze Kampf-Sequenz (2,5s Blinken + Sound, danach 1s Pause) und ruft erst
// danach onDone() auf — nur für vom Spieler ausgelöste Kämpfe (siehe Aufrufer).
function playCombatSequence(attackerSnap, defenderSnap, onDone){
  inputLocked = true;
  combatFx = { a: attackerSnap, d: defenderSnap, blinkOn: true };
  playCombatSound(attackerSnap.type);
  render();
  const blinkTimer = setInterval(() => {
    combatFx.blinkOn = !combatFx.blinkOn;
    render();
  }, 180);
  setTimeout(() => {
    clearInterval(blinkTimer);
    combatFx = null;
    render();
    setTimeout(() => {
      inputLocked = false;
      onDone();
    }, 1000);
  }, 2600);
}

function snapshotUnit(u){
  return { id:u.id, x:u.x, y:u.y, type:u.type, owner:u.owner };
}

/* ---------- KARTE GENERIEREN ---------- */
// rail/fortress/ruined/specialization-Felder sind reine Enhanced-Overlays — in Classic
// bleiben sie immer auf ihrem Default und werden nirgends gelesen/gesetzt.
function newTile(type){
  return { type, owner:null, buildPoints:0, buildType:'infantry', capital:false, road:false,
    rail:false, fortress:false, ruined:false,
    specialization:null, pendingSpecialization:null, specializationTimer:0 };
}

function rollTerrain(){
  const r = Math.random();
  if(r<0.08) return T_MOUNTAIN;
  if(r<0.18) return T_FOREST;
  if(r<0.28) return T_HILLS;
  return T_PLAIN;
}

function generateBaseGrid(fillType){
  const grid = [];
  for(let y=0;y<ROWS;y++){
    const row = [];
    for(let x=0;x<COLS;x++) row.push(newTile(fillType===T_WATER ? T_WATER : rollTerrain()));
    grid.push(row);
  }
  return grid;
}

// Kontinent: eine große Landmasse, Rand + ein paar Buchten werden zu Wasser.
// Landmasse-Menge: "hoch" = weniger Wasser (Kontinent) bzw. größere Inseln, "niedrig" =
// mehr Wasser bzw. kleinere Inseln. Zusätzlich zur Landform (Kontinent/Inseln) wählbar.
const LAND_AMOUNT_FACTOR = { low:0.62, normal:1.0, high:1.55 };
function landAmountFactor(){
  return LAND_AMOUNT_FACTOR[mapConfig.landAmount] !== undefined ? LAND_AMOUNT_FACTOR[mapConfig.landAmount] : 1.0;
}

function carveContinentCoastline(){
  const factor = landAmountFactor();
  const border = Math.max(1, Math.round(Math.min(COLS,ROWS)*0.05 / factor));
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const distEdge = Math.min(x, y, COLS-1-x, ROWS-1-y);
      if(distEdge < border) map[y][x].type = T_WATER;
    }
  }
  const bays = Math.max(1, Math.round((Math.round((COLS*ROWS)/900) + 3) / factor));
  for(let i=0;i<bays;i++){
    const edge = Math.floor(Math.random()*4);
    let x,y;
    if(edge===0){ x=border; y=2+Math.floor(Math.random()*Math.max(1,ROWS-4)); }
    else if(edge===1){ x=COLS-1-border; y=2+Math.floor(Math.random()*Math.max(1,ROWS-4)); }
    else if(edge===2){ x=2+Math.floor(Math.random()*Math.max(1,COLS-4)); y=border; }
    else { x=2+Math.floor(Math.random()*Math.max(1,COLS-4)); y=ROWS-1-border; }
    const len = Math.max(2, Math.round((5 + Math.random() * Math.min(COLS,ROWS) * 0.18) / factor));
    for(let s=0;s<len;s++){
      if(inBounds(x,y)) map[y][x].type = T_WATER;
      const dir = DIRS4[Math.floor(Math.random()*4)];
      x = Math.min(COLS-2, Math.max(1, x+dir[0]));
      y = Math.min(ROWS-2, Math.max(1, y+dir[1]));
    }
  }
}

// Inseln: alles Wasser, dann N Landmassen wachsen lassen (eine pro Spieler + Extras).
function carveIslands(totalPlayers){
  for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) map[y][x].type = T_WATER;
  const extra = mapConfig.cities==='dense' ? 5 : (mapConfig.cities==='sparse' ? 1 : 3);
  const islandCount = totalPlayers + extra;
  const minSep = Math.max(6, Math.round(Math.min(COLS,ROWS) / (Math.sqrt(islandCount)+0.5)));
  // Wachstum je Insel wird auf einen Radius um ihr Zentrum begrenzt, sonst verschmelzen
  // benachbarte Inseln durch einen unbegrenzten Random-Walk zu einer Landmasse. Die
  // Landmasse-Menge skaliert diesen Radius (mehr Land = größere Inseln), aber nie so groß,
  // dass benachbarte Inseln ineinanderlaufen (Deckel bei ~48% des Mindestabstands).
  const factor = landAmountFactor();
  const maxRadius = Math.min(Math.round(minSep*0.48), Math.max(3, Math.round(minSep*0.4*factor)));
  const margin = maxRadius+2;
  const centers = [];
  let attempts = 0;
  while(centers.length < islandCount && attempts < 4000){
    attempts++;
    const cx = margin + Math.floor(Math.random()*Math.max(1,COLS-2*margin));
    const cy = margin + Math.floor(Math.random()*Math.max(1,ROWS-2*margin));
    if(centers.some(c => Math.hypot(c.x-cx, c.y-cy) < minSep)) continue;
    centers.push({x:cx, y:cy});
  }
  const stepsPerIsland = Math.round(maxRadius*maxRadius*2.4);
  for(const c of centers){
    let x = c.x, y = c.y;
    for(let s=0; s<stepsPerIsland; s++){
      if(inBounds(x,y)) map[y][x].type = rollTerrain();
      let dir = DIRS8[Math.floor(Math.random()*8)];
      let nx = x+dir[0], ny = y+dir[1];
      if(Math.hypot(nx-c.x, ny-c.y) > maxRadius){
        dir = [Math.sign(c.x-x), Math.sign(c.y-y)];
        if(dir[0]===0 && dir[1]===0) dir = DIRS8[Math.floor(Math.random()*8)];
        nx = x+dir[0]; ny = y+dir[1];
      }
      x = Math.min(COLS-2, Math.max(1, nx));
      y = Math.min(ROWS-2, Math.max(1, ny));
    }
  }
  return centers;
}

// Lässt von (cx,cy) aus per Random-Walk eine Landmasse wachsen, begrenzt auf `radius` um
// ihr Zentrum (wie beim Insel-Wachstum in carveIslands) — gemeinsam genutzt für den
// Archipel-Zentralkontinent und dessen Ring-Inseln.
function growBlob(cx, cy, radius, steps){
  let x=cx, y=cy;
  for(let s=0; s<steps; s++){
    const ix=Math.round(x), iy=Math.round(y);
    if(inBounds(ix,iy)) map[iy][ix].type = rollTerrain();
    let dir = DIRS8[Math.floor(Math.random()*8)];
    let nx = x+dir[0], ny = y+dir[1];
    if(Math.hypot(nx-cx, ny-cy) > radius){
      dir = [Math.sign(cx-x), Math.sign(cy-y)];
      if(dir[0]===0 && dir[1]===0) dir = DIRS8[Math.floor(Math.random()*8)];
      nx = x+dir[0]; ny = y+dir[1];
    }
    x = Math.min(COLS-2, Math.max(1, nx));
    y = Math.min(ROWS-2, Math.max(1, ny));
  }
}

// Archipel: ein großer Kontinent in der Mitte (neutrales Kerngebiet), umgeben von 8
// Inseln im Ring, auf denen Spieler und KI-Gegner starten. Gibt die 8 Insel-Zentren
// zurück, damit generateMap() die Hauptstädte gezielt nur dorthin setzen kann (nie auf
// den Zentralkontinent).
function carveArchipelago(){
  for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) map[y][x].type = T_WATER;
  const factor = landAmountFactor();
  const cx = COLS/2, cy = ROWS/2;

  const baseIslandRadius = Math.max(4, Math.round(Math.min(COLS,ROWS)*0.07));
  const islandRadius = Math.max(4, Math.round(baseIslandRadius * Math.min(1.3, factor)));

  // Kontinentradius so begrenzen, dass zwischen ihm und dem Kartenrand noch genug Platz
  // für den Insel-Ring (inkl. Sicherheitsabstand) bleibt — unabhängig von der gewählten
  // Landmasse-Menge, damit die Inseln nie über den Kartenrand hinausragen.
  const available = Math.min(COLS,ROWS)/2 - islandRadius - 6;
  const continentRadius = Math.max(10, Math.round(Math.min(available*0.62, Math.min(COLS,ROWS)*0.30*factor)));
  const ringRadius = Math.min(continentRadius + islandRadius + 8, Math.min(COLS,ROWS)/2 - islandRadius - 3);

  growBlob(cx, cy, continentRadius, Math.round(continentRadius*continentRadius*3.0));

  const islandSteps = Math.round(islandRadius*islandRadius*2.4);
  const islandCenters = [];
  for(let i=0;i<8;i++){
    const angle = (i/8)*Math.PI*2 + (Math.random()-0.5)*0.25;
    let icx = cx + Math.cos(angle)*ringRadius;
    let icy = cy + Math.sin(angle)*ringRadius;
    icx = Math.min(COLS-islandRadius-2, Math.max(islandRadius+2, icx));
    icy = Math.min(ROWS-islandRadius-2, Math.max(islandRadius+2, icy));
    growBlob(icx, icy, islandRadius, islandSteps);
    islandCenters.push({x:Math.round(icx), y:Math.round(icy)});
  }
  return islandCenters;
}

// Verbundene Landmassen ermitteln (8-Richtungen) — Basis für Insel-Hauptstadtverteilung
// und die KI-Transportlogik ("gehört Ziel X zur selben Landmasse wie Einheit Y?").
function computeLandmasses(){
  const id = [];
  for(let y=0;y<ROWS;y++) id.push(new Array(COLS).fill(-1));
  const components = [];
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      if(map[y][x].type===T_WATER || id[y][x]!==-1) continue;
      const compId = components.length;
      const tiles = [];
      const queue = [{x,y}];
      id[y][x] = compId;
      while(queue.length){
        const cur = queue.shift();
        tiles.push(cur);
        for(const [dx,dy] of DIRS8){
          const nx=cur.x+dx, ny=cur.y+dy;
          if(!inBounds(nx,ny) || map[ny][nx].type===T_WATER || id[ny][nx]!==-1) continue;
          id[ny][nx] = compId;
          queue.push({x:nx,y:ny});
        }
      }
      components.push(tiles);
    }
  }
  return { id, components };
}

function isCoastal(x,y){
  return DIRS4.some(([dx,dy]) => {
    const nx=x+dx, ny=y+dy;
    return inBounds(nx,ny) && map[ny][nx].type===T_WATER;
  });
}

function clearMountainsAround(cx, cy){
  for(let dy=-1; dy<=1; dy++){
    for(let dx=-1; dx<=1; dx++){
      const x=cx+dx, y=cy+dy;
      if(inBounds(x,y) && map[y][x].type===T_MOUNTAIN) map[y][x].type = T_PLAIN;
    }
  }
}

// Vergrößert die Landmasse um `spot` (Hauptstadt), falls sie zu klein ist, um überhaupt
// Platz für weitere Städte zu bieten (z.B. ein durch Bay-/Insel-Carving abgeschnittenes
// 1-3-Feld-Fragment). Wandelt schrittweise das der Hauptstadt nächstgelegene angrenzende
// Wasserfeld in Land um, bis die Landmasse groß genug ist.
function growLandmassAroundSpot(spot, minSize){
  let { id, components } = computeLandmasses();
  let comp = components[id[spot.y][spot.x]] || [spot];
  let guard = 0;
  while(comp.length < minSize && guard < 400){
    guard++;
    let bestWater = null, bestDist = Infinity;
    for(const t of comp){
      for(const [dx,dy] of DIRS8){
        const nx=t.x+dx, ny=t.y+dy;
        if(!inBounds(nx,ny) || map[ny][nx].type!==T_WATER) continue;
        const d = Math.abs(nx-spot.x)+Math.abs(ny-spot.y);
        if(d < bestDist){ bestDist = d; bestWater = {x:nx,y:ny}; }
      }
    }
    if(!bestWater) break; // keine angrenzende Wasserkante mehr erreichbar
    map[bestWater.y][bestWater.x].type = T_PLAIN;
    comp.push(bestWater);
  }
}

// Platziert bis zu `count` zusätzliche neutrale Städte auf einer bestimmten Landmasse
// (Land-Zugang-Garantie). Wählt je Stadt das freie Landfeld mit dem größten
// Mindestabstand zu allen bereits vorhandenen Städten (global + bereits hier platzierte),
// damit sie sich auch auf kleinen Inseln so gut wie möglich verteilen statt zu klumpen.
function placeAdditionalCitiesOnComponent(comp, existingCities, count){
  const added = [];
  for(let n=0; n<count; n++){
    let best=null, bestScore=-1;
    const allExisting = existingCities.concat(added);
    for(const t of comp){
      if(map[t.y][t.x].type===T_CITY) continue;
      let minDist = Infinity;
      for(const c of allExisting) minDist = Math.min(minDist, Math.abs(c.x-t.x)+Math.abs(c.y-t.y));
      if(minDist > bestScore){ bestScore = minDist; best = t; }
    }
    if(!best) break; // Landmasse hat keinen Platz mehr
    clearMountainsAround(best.x, best.y);
    map[best.y][best.x] = Object.assign(newTile(T_CITY), { owner: OWNER_NEUTRAL });
    added.push({x:best.x, y:best.y});
  }
  return added;
}

function buildRoadPath(a, b){
  let x = a.x, y = a.y;
  const markRoad = (px,py) => { if(inBounds(px,py) && map[py][px].type!==T_WATER) map[py][px].road = true; };
  markRoad(x,y);
  while(x !== b.x){ x += x < b.x ? 1 : -1; markRoad(x,y); }
  while(y !== b.y){ y += y < b.y ? 1 : -1; markRoad(x,y); }
}

function generateMap(){
  const totalPlayers = 1 + aiOwners.length;
  map = generateBaseGrid(T_PLAIN);

  let archipelagoIslandCenters = null;
  if(mapConfig.landform === 'archipelago'){
    archipelagoIslandCenters = carveArchipelago();
  } else if(mapConfig.landform === 'islands'){
    carveIslands(totalPlayers);
  } else {
    carveContinentCoastline();
  }

  const { id: landId, components } = computeLandmasses();
  components.sort((a,b) => b.length - a.length);

  // Beim Archipel dürfen Hauptstädte NUR auf den 8 Ring-Inseln landen, nie auf dem
  // großen Zentralkontinent (der bleibt neutrales Kerngebiet zum Erobern).
  let capitalCandidates = components;
  if(archipelagoIslandCenters){
    const islandComps = [...new Set(
      archipelagoIslandCenters
        .map(c => components[landId[c.y][c.x]])
        .filter(Boolean)
    )];
    if(islandComps.length>0) capitalCandidates = islandComps;
  }

  // Hauptstadt-Plätze: größte (Kandidaten-)Landmassen zuerst, je Landmasse den Punkt mit
  // größtem Mindestabstand zu bereits gewählten Hauptstädten (verteilt sie gut).
  const capitalSpots = [];
  for(let i=0; i<totalPlayers; i++){
    const comp = capitalCandidates.length ? capitalCandidates[i % capitalCandidates.length] : null;
    if(!comp || comp.length===0){ capitalSpots.push({x:1,y:1}); continue; }
    let best=null, bestScore=-1;
    for(const t of comp){
      let minDist = Infinity;
      for(const s of capitalSpots) minDist = Math.min(minDist, Math.abs(s.x-t.x)+Math.abs(s.y-t.y));
      const score = capitalSpots.length===0 ? (Math.abs(t.x-COLS/2)+Math.abs(t.y-ROWS/2)) : minDist;
      if(score > bestScore){ bestScore = score; best = t; }
    }
    capitalSpots.push(best || comp[Math.floor(comp.length/2)]);
  }

  const owners = activeOwners();
  const cityList = [];
  for(let i=0;i<totalPlayers;i++){
    const spot = capitalSpots[i];
    clearMountainsAround(spot.x, spot.y);
    map[spot.y][spot.x] = Object.assign(newTile(T_CITY), { owner: owners[i], capital:true });
    cityList.push({x:spot.x, y:spot.y});
  }

  // Zu kleine Hauptstadt-Landmassen (z.B. durch Bay-/Insel-Carving abgeschnittene
  // 1-3-Feld-Fragmente wie im gemeldeten Fall) vergrößern, BEVOR Städte verteilt werden —
  // sonst gibt es später schlicht keinen Platz für weitere Städte auf dieser Landmasse.
  const MIN_CAPITAL_LANDMASS = 16; // grob genug Raum für Hauptstadt + 3 weitere Städte
  for(let i=0;i<totalPlayers;i++){
    growLandmassAroundSpot(capitalSpots[i], MIN_CAPITAL_LANDMASS);
  }

  const tilesPerCity = CITY_TILES_PER_CITY[mapConfig.cities] !== undefined ? CITY_TILES_PER_CITY[mapConfig.cities] : 44;
  const neutralCount = Math.max(4, Math.min(60, Math.round((COLS*ROWS) / tilesPerCity)));
  let placed = 0, attempts = 0;
  while(placed < neutralCount && attempts < 4000){
    attempts++;
    const x = 2 + Math.floor(Math.random() * Math.max(1,COLS-4));
    const y = 2 + Math.floor(Math.random() * Math.max(1,ROWS-4));
    if(map[y][x].type === T_WATER) continue;
    let tooClose = false;
    for(const c of cityList) if(Math.abs(c.x-x)+Math.abs(c.y-y) < 4) tooClose = true;
    if(tooClose) continue;
    clearMountainsAround(x,y);
    map[y][x] = Object.assign(newTile(T_CITY), { owner: OWNER_NEUTRAL });
    cityList.push({x,y});
    placed++;
  }

  // Garantie: Wenn Wasser existiert, aber zufällig keine Stadt daran liegt, eine
  // zusätzliche Küstenstadt erzwingen (sonst sind Seeeinheiten nirgends baubar).
  const hasWater = cityList.length>0 && (mapConfig.landform==='islands' || true) &&
    (() => { for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) if(map[y][x].type===T_WATER) return true; return false; })();
  if(hasWater && !cityList.some(c => isCoastal(c.x,c.y))){
    let bestSpot=null, attempts2=0;
    while(!bestSpot && attempts2<600){
      attempts2++;
      const x = 2 + Math.floor(Math.random()*Math.max(1,COLS-4));
      const y = 2 + Math.floor(Math.random()*Math.max(1,ROWS-4));
      if(map[y][x].type===T_WATER || map[y][x].type===T_CITY || !isCoastal(x,y)) continue;
      let tooClose=false;
      for(const c of cityList) if(Math.abs(c.x-x)+Math.abs(c.y-y)<3) tooClose=true;
      if(tooClose) continue;
      bestSpot = {x,y};
    }
    if(bestSpot){
      clearMountainsAround(bestSpot.x, bestSpot.y);
      map[bestSpot.y][bestSpot.x] = Object.assign(newTile(T_CITY), { owner: OWNER_NEUTRAL });
      cityList.push(bestSpot);
    }
  }

  // Zugangs-Garantie: jede Hauptstadt braucht auf ihrer eigenen Landmasse (zu Fuß/über
  // Land erreichbar, unabhängig von zufälliger Nachbarstadt-Platzierung) mindestens drei
  // weitere Städte — sonst kann eine kleine/abgeschnittene Landmasse eine isolierte
  // Hauptstadt ohne jede Ausbaumöglichkeit ergeben. Landmassen frisch neu berechnen, da
  // sich das Terrain seit dem Sortieren oben (Wachstum kleiner Fragmente) verändert hat.
  const { id: freshLandId, components: freshComponents } = computeLandmasses();
  for(let i=0; i<totalPlayers; i++){
    const spot = capitalSpots[i];
    const comp = freshComponents[freshLandId[spot.y][spot.x]];
    if(!comp || comp.length===0) continue;
    const compKeys = new Set(comp.map(t=>key(t.x,t.y)));
    const onComponent = cityList.filter(c => compKeys.has(key(c.x,c.y)));
    const needed = 4 - onComponent.length; // die Hauptstadt selbst zählt schon mit
    if(needed > 0){
      const added = placeAdditionalCitiesOnComponent(comp, cityList, needed);
      cityList.push(...added);
    }
  }

  // Straßennetz: jede Stadt mit ihrer nächsten Nachbarstadt verbinden (nur über Land)
  for(const c of cityList){
    let nearest=null, bestD=Infinity;
    for(const o of cityList){
      if(o===c) continue;
      const d = Math.abs(o.x-c.x)+Math.abs(o.y-c.y);
      if(d<bestD){ bestD=d; nearest=o; }
    }
    if(nearest) buildRoadPath(c, nearest);
  }

  landmassId = computeLandmasses().id;

  return { capitalSpots, owners };
}

/* ---------- EINHEITEN: GRUNDFUNKTIONEN ---------- */
function spawnUnit(owner, type, x, y){
  const stats = UNIT_STATS[type];
  const u = {
    id: unitIdCounter++,
    owner, type, x, y,
    hp: stats.hp,
    movesLeft: stats.move,
    moved: false,
    firedThisTurn: false,
    actedAtAll: false,
    foughtThisTurn: false,
    fuel: stats.fuel !== undefined ? stats.fuel : null,
    dugIn: false,
    digPending: null,
    subLevel: stats.subclass==='sea' && type==='submarine' ? 'surface' : null,
    orderState: null,          // null | 'resting' | 'waiting'
    destination: null,         // {x,y} Wegpunkt-Marschziel
    patrol: null,              // {a:{x,y}, b:{x,y}, target:'a'|'b'} Patrouillenbefehl
    effectiveness: EXPERIENCE_CAP.green,
    experience: 'green',
    xpWins: 0,
    hostId: null,
    cargo: stats.portageCapacity ? [] : null,
    buildOrder: null,          // Enhanced: Ingenieur-Bauauftrag {type, path?, turnsLeft}
    killXp: 0,                 // Enhanced: Veteranen-System, siehe grantExperience
    level: 0
  };
  units.push(u);
  return u;
}

function unitsAt(x,y){ return units.filter(u => u.x===x && u.y===y && u.hp>0 && !u.hostId); }
function unitsOf(owner){ return units.filter(u => u.owner===owner && u.hp>0 && !u.hostId); }
function allUnitsOf(owner){ return units.filter(u => u.owner===owner && u.hp>0); }
function citiesOf(owner){
  const list = [];
  for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++)
    if(map[y][x].type===T_CITY && map[y][x].owner===owner) list.push({x,y});
  return list;
}
function adjacentTiles(x,y){
  return DIRS8.map(([dx,dy])=>({x:x+dx,y:y+dy})).filter(p=>inBounds(p.x,p.y));
}
function getLevel(u){
  const s = UNIT_STATS[u.type];
  if(s.category==='air') return 'air';
  if(u.subLevel==='deep') return 'sub';
  return 'ground';
}
function effName(u){ return EFFECTIVENESS_NAME[EFFECTIVENESS[u.effectiveness]]; }
function isCrippled(u){ return u.hp <= effStat(u,'hp')/2; }
function isEliminated(owner){ return citiesOf(owner).length===0 && allUnitsOf(owner).length===0; }
function ownerLabel(owner){ return OWNER_LABEL[owner] || owner; }

/* ---------- TERRAIN / BEWEGUNG ---------- */
function terrainAllowed(tile, unit){
  const s = UNIT_STATS[unit.type];
  if(s.category==='air'){
    if(s.noMountain && tile.type===T_MOUNTAIN) return false;
    return true;
  }
  if(unit.subLevel==='deep') return tile.type===T_WATER;
  if(s.subclass==='sea') return tile.type===T_WATER || tile.type===T_CITY;
  return tile.type !== T_WATER;
}

function terrainCost(tile, unit){
  const s = UNIT_STATS[unit.type];
  if(s.category==='air') return 1;
  if(isEnhanced() && tile.rail && s.subclass==='land') return 0.25;
  if(tile.road) return 1;
  return MOVE_COST[tile.type];
}

/* ---------- ENHANCED: INGENIEUR-BAUAUFTRÄGE ---------- */
// Bauzeit (Runden) je Untergrund für Straßen; Eisenbahn kostet bei bereits vorhandener
// Straße pauschal 2 Runden, sonst den Straßenpreis + 2 (siehe engineerTileCost).
const ROAD_BUILD_COST = { [T_PLAIN]:2, [T_FOREST]:3, [T_HILLS]:4, [T_MOUNTAIN]:5 };
function engineerTileCost(kind, tileType, hasRoad){
  const base = ROAD_BUILD_COST[tileType] !== undefined ? ROAD_BUILD_COST[tileType] : 2;
  if(kind==='rail') return hasRoad ? 2 : base + 2;
  return base;
}

// Startet einen einfachen (pfadlosen) Bauauftrag: Festung, Radar, Flughafen, Wiederaufbau.
function startEngineerBuild(unit, type, turns){
  unit.buildOrder = { type, turnsLeft: turns };
  unit.moved = true;
  updateInfoPanel(`Bauauftrag gestartet (${turns} Runde${turns===1?'':'n'}).`);
  finishUnitTurn(unit);
}

// Bricht einen laufenden Bauauftrag ab und gibt die Einheit an den Spieler zurück (kein
// Bewegungsverlust, da noch nichts vollendet wurde).
function cancelEngineerBuild(unit){
  unit.buildOrder = null;
  unit.moved = false;
  renderUnitActions();
  updateSelectionInfo();
  render();
}

// Schließt die aktuelle Baustufe eines Ingenieur-Bauauftrags ab (ein Feld bei Straße/
// Eisenbahn, oder den gesamten Auftrag bei Festung/Radar/Flughafen/Wiederaufbau).
function completeConstructionStep(unit){
  const order = unit.buildOrder;
  const tile = map[unit.y][unit.x];
  if(order.type==='road'){
    tile.road = true;
  } else if(order.type==='rail'){
    tile.road = true; tile.rail = true;
  } else if(order.type==='fortress'){
    tile.fortress = true;
    unit.buildOrder = null; unit.moved = false;
    updateInfoPanel('Festung fertiggestellt.');
    return;
  } else if(order.type==='radar'){
    const owner = unit.owner;
    const keepRoad = tile.road, keepRail = tile.rail;
    map[unit.y][unit.x] = Object.assign(newTile(T_RADAR), { owner, road:keepRoad, rail:keepRail });
    unit.buildOrder = null; unit.moved = false;
    updateInfoPanel('Radarstation fertiggestellt.');
    if(fogEnabled) recomputeVisibility();
    return;
  } else if(order.type==='airport'){
    tile.type = T_AIRPORT; tile.owner = unit.owner;
    unit.buildOrder = null; unit.moved = false;
    updateInfoPanel('Flughafen fertiggestellt.');
    return;
  } else if(order.type==='rebuild'){
    tile.ruined = false; tile.owner = unit.owner; tile.buildPoints = 0; tile.buildType = 'infantry';
    unit.buildOrder = null; unit.moved = false;
    updateInfoPanel('Stadt wiederaufgebaut.');
    return;
  }
  // Straße/Eisenbahn: nächstes Feld im Pfad in Angriff nehmen, sonst fertig.
  if(order.path && order.path.length>0){
    const next = order.path.shift();
    unit.x = next.x; unit.y = next.y;
    const nextTile = map[unit.y][unit.x];
    order.turnsLeft = engineerTileCost(order.type, nextTile.type, nextTile.road);
  } else {
    unit.buildOrder = null;
    unit.moved = false;
    updateInfoPanel(`${order.type==='road' ? 'Straßenbau' : 'Eisenbahnbau'} abgeschlossen.`);
  }
}

// Rundenende-Verarbeitung für Ingenieur-Bauaufträge (Aufruf analog zu advanceWaypoint/
// advancePatrol). Feindkontakt bricht den Bau ab — der Ingenieur kann sich nicht wehren.
function advanceConstruction(unit){
  const order = unit.buildOrder;
  if(!order || unit.hp<=0) return;
  if(adjacentTiles(unit.x,unit.y).some(t => pickDefenderAt(t.x,t.y,unit))){
    updateInfoPanel(`${ownerLabel(unit.owner)}: Ingenieur hat Feindkontakt — Bauauftrag unterbrochen.`);
    unit.buildOrder = null;
    unit.moved = false;
    return;
  }
  order.turnsLeft--;
  if(order.turnsLeft <= 0) completeConstructionStep(unit);
}

// Ausnahme "kann sonst unpassierbares Feld betreten, um an Bord zu gehen":
// Landeinheiten -> Schiffe mit canCarry; Lufteinheiten -> Träger mit canCarry.
function findLoadHost(unit, x, y){
  const s = UNIT_STATS[unit.type];
  if(s.subclass === 'sea') return null; // Schiffe werden nie selbst transportiert
  const host = units.find(o => o.x===x && o.y===y && o.hp>0 && !o.hostId && o.owner===unit.owner &&
    UNIT_STATS[o.type].canCarry && UNIT_STATS[o.type].canCarry.includes(unit.type));
  if(host && host.cargo.length < UNIT_STATS[host.type].portageCapacity) return host;
  return null;
}

// Rückgabe: true = frei, 'combat' = Gegner blockiert (Kampfziel), false = belegt/kein Platz
function slotStatus(x,y,unit){
  const lvl = getLevel(unit);
  const occupants = units.filter(u => u.x===x && u.y===y && u.hp>0 && !u.hostId && getLevel(u)===lvl);
  const enemy = occupants.find(o => o.owner!==unit.owner);
  if(enemy) return 'combat';
  if(lvl==='ground'){
    const tile = map[y][x];
    if(tile.type===T_CITY || tile.type===T_AIRPORT) return true; // Städte/Flughäfen: unbegrenzte Garnison
    const cap = tile.road ? 2 : 1;
    return occupants.length < cap;
  }
  return occupants.length < 1;
}

// Bewegungsreichweite für DIESE Runde (u.movesLeft als Budget, nicht der volle Basiswert —
// dadurch kann eine Einheit über mehrere Klicks hinweg ihre Restpunkte weiter verbrauchen).
function computeReachable(unit){
  const budget = unit.movesLeft;
  const dist = { [key(unit.x,unit.y)]: 0 };
  const frontier = [{x:unit.x,y:unit.y,d:0}];
  const result = [];
  while(frontier.length){
    frontier.sort((a,b)=>a.d-b.d);
    const cur = frontier.shift();
    if(dist[key(cur.x,cur.y)] < cur.d) continue;
    for(const [dx,dy] of DIRS8){
      const nx=cur.x+dx, ny=cur.y+dy;
      if(!inBounds(nx,ny)) continue;
      const tile = map[ny][nx];
      const loadHost = findLoadHost(unit, nx, ny);
      if(!loadHost){
        if(!terrainAllowed(tile, unit)) continue;
        const status = slotStatus(nx,ny,unit);
        if(status !== true) continue;
      }
      const nd = cur.d + terrainCost(tile, unit);
      if(nd > budget) continue;
      const k = key(nx,ny);
      if(dist[k] !== undefined && dist[k] <= nd) continue;
      dist[k] = nd;
      frontier.push({x:nx,y:ny,d:nd});
      result.push({x:nx,y:ny});
    }
  }
  const seen = new Set(), final = [];
  for(const r of result){ const k=key(r.x,r.y); if(!seen.has(k)){ seen.add(k); final.push(r); } }
  return { tiles: final, dist };
}

// Vollständiger Pfad zu einem Ziel OHNE Rundenbudget-Deckel (für KI-Marsch über mehrere
// Runden und für Spieler-Wegpunktbefehle). Gegner blockieren den Weg (außer als Zielfeld).
function computePathTowards(unit, target){
  const dist = { [key(unit.x,unit.y)]: 0 };
  const prev = {};
  const frontier = [{x:unit.x,y:unit.y,d:0}];
  let reachedTarget = false;
  while(frontier.length){
    frontier.sort((a,b)=>a.d-b.d);
    const cur = frontier.shift();
    if(dist[key(cur.x,cur.y)] < cur.d) continue;
    if(cur.x===target.x && cur.y===target.y){ reachedTarget = true; break; }
    for(const [dx,dy] of DIRS8){
      const nx=cur.x+dx, ny=cur.y+dy;
      if(!inBounds(nx,ny)) continue;
      const isTarget = nx===target.x && ny===target.y;
      const tile = map[ny][nx];
      if(!terrainAllowed(tile, unit)) continue;
      if(!isTarget){
        const status = slotStatus(nx,ny,unit);
        if(status !== true) continue;
      }
      const nd = cur.d + terrainCost(tile, unit);
      const k = key(nx,ny);
      if(dist[k] !== undefined && dist[k] <= nd) continue;
      dist[k] = nd;
      prev[k] = {x:cur.x,y:cur.y};
      frontier.push({x:nx,y:ny,d:nd});
    }
  }
  if(!reachedTarget) return null;
  const path = [];
  let cur = {x:target.x,y:target.y};
  while(!(cur.x===unit.x && cur.y===unit.y)){
    path.unshift(cur);
    const p = prev[key(cur.x,cur.y)];
    if(!p) return null;
    cur = p;
  }
  return path;
}

/* ---------- KAMPF ---------- */
function effDiff(defender, attacker){
  return defender.effectiveness - attacker.effectiveness;
}

// Enhanced: Waffengattungs-Duelle mit Vor-/Nachteil (Prozentpunkte Trefferchance),
// zusätzlich zur normalen Angriff/Verteidigung-Rechnung unten.
const ENHANCED_MATCHUPS = {
  submarine:  { battleship:15, transport:15, carrier:15 },
  destroyer:  { submarine:15 },
  helicopter: { submarine:15 },
  fighter:    { helicopter:15, battleship:-15, destroyer:-15 }
};

// Enhanced: Positionen aller Radarstationen, einmal pro Zugwechsel aktualisiert (siehe
// refreshRadarPositions/advanceTurn) — vermeidet einen kompletten Kartenscan bei JEDER
// Trefferchancen-Berechnung bzw. jeder KI-Ingenieur-Entscheidung, was auf großen Karten
// (z.B. "Riesig", 192x124 Felder) spürbar zu Buche schlug.
let radarPositions = [];
function refreshRadarPositions(){
  radarPositions = [];
  if(!isEnhanced()) return;
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      if(map[y][x].type===T_RADAR) radarPositions.push({x, y, owner:map[y][x].owner});
    }
  }
}

// Enhanced: gibt es eine eigene Radarstation der Einheit im Umkreis RADAR_SIGHT_RANGE?
function isNearOwnRadar(unit){
  return radarPositions.some(r => r.owner===unit.owner &&
    Math.max(Math.abs(r.x-unit.x), Math.abs(r.y-unit.y)) <= RADAR_SIGHT_RANGE);
}

function hitChance(attacker, defender, attackerCrippled){
  const a = UNIT_STATS[attacker.type], d = UNIT_STATS[defender.type];
  let chance = 50 + (effStat(attacker,'power') - effStat(defender,'defense')) * 0.6;
  chance += effDiff(defender, attacker) * 5;
  if(defender.dugIn) chance -= 15;
  if(attackerCrippled) chance -= 15;
  if(isEnhanced()){
    const matchup = ENHANCED_MATCHUPS[attacker.type] && ENHANCED_MATCHUPS[attacker.type][defender.type];
    if(matchup) chance += matchup;
    // Festung: erhöht die Verteidigung des dort stehenden Verteidigers (+5, eingegrabene
    // Infanterie +10) — die virtuelle Stadtverteidigung hat keine Koordinaten und wird
    // dadurch automatisch ausgeschlossen.
    if(defender.x !== undefined && defender.y !== undefined && map[defender.y] && map[defender.y][defender.x] && map[defender.y][defender.x].fortress){
      chance -= (defender.dugIn && defender.type==='infantry') ? 10 : 5;
    }
    // Radar: eigene Flugzeuge im Umkreis haben einen Vorteil gegen feindliche Flugzeuge.
    if(fogEnabled && a.category==='air' && d.category==='air'){
      if(attacker.x !== undefined && isNearOwnRadar(attacker)) chance += 10;
      if(defender.x !== undefined && isNearOwnRadar(defender)) chance -= 10;
    }
  }
  return Math.min(99, Math.max(1, Math.round(chance)));
}

function grantExperience(u){
  u.xpWins++;
  if(u.experience==='green' && u.xpWins >= EXPERIENCE_WINS_NEEDED.proven) u.experience='proven';
  else if(u.experience==='proven' && u.xpWins >= EXPERIENCE_WINS_NEEDED.hardened) u.experience='hardened';
  // Enhanced-Veteranensystem läuft parallel zum bestehenden Grün/Erprobt/Abgehärtet-System
  // und wird an derselben Stelle ausgelöst (jeder echte Einheiten-Kill) — Classic bleibt
  // unverändert, da grantKillXp() bei !isEnhanced() sofort zurückkehrt.
  if(isEnhanced()) grantKillXp(u);
}

// 20 XP je besiegtem Gegner, alle 100 XP ein Levelaufstieg (max. Level 20). Jedes Level
// erhöht abwechselnd Angriff (power), Verteidigung (defense), Lebenspunkte (hp) und
// Bewegung (move) um 1 — siehe effStat() für die Anwendung. Ein HP-Levelaufstieg heilt
// die Einheit zusätzlich um den Zuwachs, sonst "hinkt" ihr aktuelles HP dem neuen Max hinterher.
const LEVEL_STAT_CYCLE = ['power','defense','hp','move'];
function grantKillXp(u){
  if(u.killXp===undefined) return; // Sicherheitsnetz für ältere Speicherstände ohne das Feld
  u.killXp += 20;
  while(u.killXp >= 100 && u.level < 20){
    u.killXp -= 100;
    u.level++;
    if(LEVEL_STAT_CYCLE[(u.level-1) % 4]==='hp') u.hp += 1;
  }
}

// Effektiver Statwert inkl. Enhanced-Levelbonus. In Classic (oder für Einheiten ohne
// level-Feld, z.B. die virtuelle Stadtverteidigung) identisch zum UNIT_STATS-Basiswert.
function effStat(unit, stat){
  const base = UNIT_STATS[unit.type][stat];
  if(!isEnhanced() || !unit.level) return base;
  let bonus = 0;
  for(let lvl=1; lvl<=unit.level; lvl++){
    if(LEVEL_STAT_CYCLE[(lvl-1)%4]===stat) bonus++;
  }
  return base + bonus;
}

function destroyUnit(u){
  units = units.filter(x => x!==u);
  if(u.cargo){
    for(const cid of u.cargo) units = units.filter(x => x.id!==cid);
  }
}

function resolveMeleeAttack(attacker, defender, noEntry){
  attacker.foughtThisTurn = true;
  defender.foughtThisTurn = true;
  const attackerCrippled = isCrippled(attacker);
  let rounds = 0;
  while(attacker.hp>0 && defender.hp>0 && rounds<200){
    rounds++;
    const chance = hitChance(attacker, defender, attackerCrippled);
    const roll = Math.random()*100;
    if(roll < chance) defender.hp -= UNIT_STATS[attacker.type].dmg;
    else attacker.hp -= UNIT_STATS[defender.type].dmg;
  }
  if(defender.hp <= 0){
    destroyUnit(defender);
    grantExperience(attacker);
    return { winner:'attacker', entered: !noEntry };
  } else {
    destroyUnit(attacker);
    grantExperience(defender);
    return { winner:'defender', entered:false };
  }
}

// HINWEIS: setzt bewusst NICHT attacker.moved/movesLeft — das übernimmt der jeweilige
// Aufrufer. Bei offensivem Fernkampf (Spieler-Klick, KI-Zug) soll das die Einheit für
// den Rest der eigenen Runde verbrauchen; bei Defensivfeuer (Reaktion während der
// gegnerischen Runde) darf es NICHT die nächste eigene Runde der Einheit blockieren.
function resolveRangedAttack(attacker, defender){
  attacker.firedThisTurn = true;
  attacker.foughtThisTurn = true;
  const attackerCrippled = isCrippled(attacker);
  let hitAny = false;
  while(defender.hp>0){
    const chance = hitChance(attacker, defender, attackerCrippled);
    const roll = Math.random()*100;
    if(roll < chance){ defender.hp -= UNIT_STATS[attacker.type].dmg; hitAny = true; }
    else break;
  }
  if(defender.hp<=0){
    destroyUnit(defender);
    grantExperience(attacker);
    return { destroyed:true };
  }
  defender.foughtThisTurn = true;
  return { destroyed:false, hitAny };
}

// deferMorph: bei Spieler-Angriffen (mit Kampf-Blink-Sequenz) soll der sichtbare
// Panzer→Infanterie-Tausch (captureMorph) erst NACH der Sequenz passieren, sonst stünde
// die neue Garnisonseinheit schon während des Blinkens sichtbar in der Stadt. In dem Fall
// wird der Tausch nur vorgemerkt (unit.pendingCaptureMorph) statt sofort ausgeführt.
function captureCity(x,y, owner, capturingUnit, deferMorph){
  const tile = map[y][x];
  if(tile.type !== T_CITY) return;
  tile.owner = owner;
  tile.buildPoints = 0;
  tile.buildType = 'infantry';
  tile.rallyPoint = null;
  const stats = UNIT_STATS[capturingUnit.type];
  if(stats.captureMorph && capturingUnit.hp >= effStat(capturingUnit,'hp')){
    if(deferMorph) capturingUnit.pendingCaptureMorph = { owner, x, y, type: stats.captureMorph };
    else { destroyUnit(capturingUnit); spawnUnit(owner, stats.captureMorph, x, y); }
  }
}

function applyPendingCaptureMorph(unit){
  if(!unit || !unit.pendingCaptureMorph) return;
  const { owner, x, y, type } = unit.pendingCaptureMorph;
  destroyUnit(unit);
  spawnUnit(owner, type, x, y);
}

// Enhanced: Verbrannte Erde — der Eigentümer selbst zerstört seine Stadt, bevor der Gegner
// sie einnehmen kann. Die Ruine ist danach niemandes Stadt mehr (keine Produktion, keine
// Eroberung per Kampf, siehe tryCaptureStructure/attackableTiles) und kann nur von einem
// Ingenieur wiederaufgebaut werden (siehe completeConstructionStep 'rebuild').
function destroyCity(unit){
  const tile = map[unit.y][unit.x];
  if(tile.type!==T_CITY || tile.ruined || tile.owner!==unit.owner) return;
  tile.owner = null;
  tile.ruined = true;
  tile.buildPoints = 0;
  tile.buildType = 'infantry';
  tile.rallyPoint = null;
  tile.specialization = null;
  tile.pendingSpecialization = null;
  tile.specializationTimer = 0;
  updateInfoPanel('Stadt niedergebrannt — nur ein Ingenieur kann sie wiederaufbauen.');
  unit.moved = true; unit.movesLeft = 0; unit.actedAtAll = true;
  finishUnitTurn(unit);
}

// Unbesetzte Städte verteidigen sich wie eine Infanterie-Einheit ("natürliche Verteidigung").
// Gibt zurück, ob der Angreifer den Kampf überlebt hat.
function resolveCityDefenseCombat(attacker){
  const virtualDefender = { type:'infantry', hp:UNIT_STATS.infantry.hp, effectiveness:EXPERIENCE_CAP.green, dugIn:false };
  const attackerCrippled = isCrippled(attacker);
  let rounds = 0;
  while(attacker.hp>0 && virtualDefender.hp>0 && rounds<200){
    rounds++;
    const chance = hitChance(attacker, virtualDefender, attackerCrippled);
    const roll = Math.random()*100;
    if(roll < chance) virtualDefender.hp -= UNIT_STATS[attacker.type].dmg;
    else attacker.hp -= UNIT_STATS.infantry.dmg;
  }
  if(virtualDefender.hp <= 0) return true;
  destroyUnit(attacker);
  return false;
}

// Versucht, eine unbesetzte gegnerische/neutrale Stadt oder einen Flughafen zu übernehmen
// (Flughäfen ohne eigene Verteidigung, Städte mit virtuellem Infanterie-Kampf).
// Gibt zurück, ob der Angreifer den Vorgang überlebt hat.
function tryCaptureStructure(unit, x, y, deferMorph){
  const tile = map[y][x];
  // Radarstationen (Enhanced) verhalten sich wie Flughäfen: keine eigene Verteidigung,
  // Landeinheiten übernehmen sie kampflos.
  if((tile.type===T_AIRPORT || tile.type===T_RADAR) && tile.owner!==unit.owner){
    tile.owner = unit.owner;
    return true;
  }
  // Verbrannte Erde (Enhanced): eine zerstörte Stadt ist nur noch Trümmerfeld — keine
  // Verteidigung, keine Eroberung per Kampf. Nur ein Ingenieur kann sie wiederaufbauen
  // (siehe completeConstructionStep 'rebuild').
  if(tile.type===T_CITY && !tile.ruined && tile.owner!==unit.owner){
    const survived = resolveCityDefenseCombat(unit);
    MusicEngine.start();
    if(survived) captureCity(x, y, unit.owner, unit, deferMorph);
    return survived;
  }
  return true;
}

function refuelIfOnOwnCity(u){
  if(u.type !== 'fighter') return;
  const tile = map[u.y][u.x];
  if((tile.type===T_CITY || tile.type===T_AIRPORT) && tile.owner===u.owner) u.fuel = UNIT_STATS.fighter.fuel;
}

/* ---------- WER DARF WEN ANGREIFEN (Welt-Ebenen-Priorität + Typ-Einschränkungen) ---------- */
// U-Boot/Zerstörer/Träger/Transportschiff können keine Landeinheiten angreifen (nur das
// Schlachtschiff kann Küsten-/Landziele bekämpfen). Infanterie kann keine Seeeinheiten
// angreifen (dafür braucht es Panzer/Artillerie oder eigene Schiffe).
const NO_LAND_ATTACK = ['submarine','destroyer','carrier','transport'];
// `defender` ist die volle Einheit (nicht nur der Typ), damit getauchte U-Boote anhand
// von subLevel erkannt werden können: die sind nur für Zerstörer ortbar/angreifbar.
function canAttackTargetType(attackerType, defender){
  const d = UNIT_STATS[defender.type];
  if(NO_LAND_ATTACK.includes(attackerType) && d.subclass==='land') return false;
  if(attackerType==='infantry' && d.subclass==='sea') return false;
  if(defender.subLevel==='deep'){
    // Enhanced: Hubschrauber orten getauchte U-Boote in ihrem Bewegungsradius (die
    // eigentliche Radius-Prüfung übernimmt bereits die normale Reichweiten-/Adjazenz-Logik
    // beim Angriff selbst) und dürfen sie deshalb zusätzlich zum Zerstörer angreifen.
    const allowed = isEnhanced() ? (attackerType==='destroyer' || attackerType==='helicopter') : attackerType==='destroyer';
    if(!allowed) return false;
  }
  return true;
}

function pickDefenderAt(x,y, attacker){
  const attackerLevel = getLevel(attacker);
  const allowedLevels = LEVEL_TARGETS[attackerLevel];
  const occupantsByLevel = { air:[], ground:[], sub:[] };
  for(const u of units){
    if(u.x===x && u.y===y && u.hp>0 && !u.hostId) occupantsByLevel[getLevel(u)].push(u);
  }
  const eligible = (list) => list
    .filter(o => o.owner!==attacker.owner && !areAllied(attacker.owner, o.owner) && canAttackTargetType(attacker.type, o))
    .sort((a,b) => a.id-b.id); // Stapel (z.B. in Städten) wird stabil von der ältesten Einheit an abgearbeitet

  if(allowedLevels.includes('air')){
    const hits = eligible(occupantsByLevel.air);
    if(hits.length>0) return { target: hits[0], noEntry: true };
  }
  if(allowedLevels.includes('ground')){
    const hits = eligible(occupantsByLevel.ground);
    if(hits.length>0) return { target: hits[0], noEntry: false };
  }
  if(allowedLevels.includes('sub')){
    const hits = eligible(occupantsByLevel.sub);
    if(hits.length>0) return { target: hits[0], noEntry: false };
  }
  return null;
}

/* ---------- WEGPUNKT-MARSCHBEFEHLE ---------- */
// Setzt/validiert ein mehrrundiges Marschziel. Gibt true zurück, wenn angenommen.
function setDestination(unit, x, y, silent, fromRally){
  if(x===unit.x && y===unit.y){ unit.destination = null; return true; }
  const path = computePathTowards(unit, {x,y});
  if(!path){
    if(!silent) updateInfoPanel('Zielpunkt ist auf diesem Weg nicht erreichbar.');
    return false;
  }
  unit.destination = {x,y, fromRally: !!fromRally};
  unit.orderState = null;
  if(!silent) updateInfoPanel(`Marschziel gesetzt (${path.length} Feld(er) Weg) — Einheit bewegt sich über mehrere Runden selbständig dorthin.`);
  return true;
}

// Führt den Automarsch einer Einheit für die aktuelle Runde aus (bis Budget verbraucht,
// Ziel erreicht oder Feindkontakt). Bricht bei Feindkontakt ab und gibt der Einheit die
// Kontrolle zurück, statt automatisch anzugreifen.
function advanceWaypoint(unit){
  if(!unit.destination || unit.moved || unit.hp<=0) return;
  const stats = UNIT_STATS[unit.type];
  const animFromX = unit.x, animFromY = unit.y;
  let guard = 0;
  while(unit.destination && unit.movesLeft>0 && guard<50){
    guard++;
    if(unit.x===unit.destination.x && unit.y===unit.destination.y){
      const arrivedFromRally = !!unit.destination.fromRally;
      unit.destination=null;
      const arrTile = map[unit.y][unit.x];
      // Nur per SAMMELPUNKT in eine eigene Stadt geschickte Infanterie/Panzer/Artillerie
      // gehen dort automatisch in Warten. Ein manuell gesetztes Marschziel [G] lässt die
      // Einheit nach Ankunft weiter frei wählbar, genau wie eine normale Bewegung per Klick.
      if(arrivedFromRally && (arrTile.type===T_CITY || arrTile.type===T_AIRPORT) && arrTile.owner===unit.owner &&
         (unit.type==='infantry' || unit.type==='tank' || unit.type==='artillery')){
        unit.orderState = 'waiting';
        unit.moved = true; unit.movesLeft = 0;
      }
      break;
    }
    const path = computePathTowards(unit, unit.destination);
    if(!path || path.length===0){
      updateInfoPanel(`${ownerLabel(unit.owner)}: Marschbefehl abgebrochen — kein Weg zum Ziel.`);
      unit.destination = null;
      break;
    }
    const step = path[0];
    const def = pickDefenderAt(step.x, step.y, unit);
    if(def){
      updateInfoPanel(`${ownerLabel(unit.owner)}: Einheit hat Feindkontakt — Marschbefehl unterbrochen.`);
      unit.destination = null;
      break;
    }
    const cost = terrainCost(map[step.y][step.x], unit);
    if(cost > unit.movesLeft) break;
    unit.movesLeft -= cost;
    unit.x = step.x; unit.y = step.y;
    unit.actedAtAll = true;
    refuelIfOnOwnCity(unit);
    const tile = map[step.y][step.x];
    if((tile.type===T_CITY || tile.type===T_AIRPORT || tile.type===T_RADAR) && tile.owner!==unit.owner && stats.subclass==='land'){
      if(!tryCaptureStructure(unit, step.x, step.y)){ queueMoveAnim(unit, animFromX, animFromY); return; } // Einheit an Stadtverteidigung gescheitert
    }
    // Adjazenter Feind nach dem Schritt -> ebenfalls abbrechen (Feindkontakt)
    if(adjacentTiles(unit.x,unit.y).some(t => pickDefenderAt(t.x,t.y,unit))){
      unit.destination = null;
      break;
    }
  }
  if(unit.movesLeft<=0) unit.moved = true;
  queueMoveAnim(unit, animFromX, animFromY);
}

// Gibt es eine feindliche Einheit innerhalb des vollen Bewegungsradius (Chebyshev-Distanz)?
function enemyWithinRadius(unit, radius){
  return units.some(o => o.owner!==unit.owner && o.hp>0 && !o.hostId &&
    Math.max(Math.abs(o.x-unit.x), Math.abs(o.y-unit.y)) <= radius);
}

// Patrouille: pendelt selbständig zwischen zwei Wegpunkten (A/B), bricht ab, sobald eine
// feindliche Einheit in den vollen Bewegungsradius der patrouillierenden Einheit kommt
// (nicht erst bei direktem Kontakt).
function advancePatrol(unit){
  if(!unit.patrol || unit.moved || unit.hp<=0) return;
  const stats = UNIT_STATS[unit.type];
  if(enemyWithinRadius(unit, effStat(unit,'move'))){
    updateInfoPanel(`${ownerLabel(unit.owner)}: Patrouille unterbrochen — Feind im Bewegungsradius.`);
    unit.patrol = null;
    return;
  }
  const animFromX = unit.x, animFromY = unit.y;
  let guard = 0;
  while(unit.patrol && unit.movesLeft>0 && guard<50){
    guard++;
    const tgt = unit.patrol[unit.patrol.target];
    if(unit.x===tgt.x && unit.y===tgt.y){
      unit.patrol.target = unit.patrol.target==='a' ? 'b' : 'a';
      continue;
    }
    const path = computePathTowards(unit, tgt);
    if(!path || path.length===0){
      updateInfoPanel(`${ownerLabel(unit.owner)}: Patrouille abgebrochen — kein Weg zum Wegpunkt.`);
      unit.patrol = null;
      break;
    }
    const step = path[0];
    const def = pickDefenderAt(step.x, step.y, unit);
    if(def){
      updateInfoPanel(`${ownerLabel(unit.owner)}: Einheit auf Patrouille hat Feindkontakt — Befehl unterbrochen.`);
      unit.patrol = null;
      break;
    }
    const cost = terrainCost(map[step.y][step.x], unit);
    if(cost > unit.movesLeft) break;
    unit.movesLeft -= cost;
    unit.x = step.x; unit.y = step.y;
    unit.actedAtAll = true;
    refuelIfOnOwnCity(unit);
    const tile = map[step.y][step.x];
    if((tile.type===T_CITY || tile.type===T_AIRPORT || tile.type===T_RADAR) && tile.owner!==unit.owner && stats.subclass==='land'){
      if(!tryCaptureStructure(unit, step.x, step.y)){ queueMoveAnim(unit, animFromX, animFromY); return; }
    }
    if(enemyWithinRadius(unit, effStat(unit,'move'))){
      updateInfoPanel(`${ownerLabel(unit.owner)}: Patrouille unterbrochen — Feind im Bewegungsradius.`);
      unit.patrol = null;
      break;
    }
  }
  if(unit.movesLeft<=0) unit.moved = true;
  queueMoveAnim(unit, animFromX, animFromY);
}

/* ---------- SPIELERZUG: AUSWAHL & HIGHLIGHTS ---------- */
function selectUnit(u){
  if(u.orderState || ((u.destination || u.patrol) && u.moved)){
    u.orderState = null;
    u.destination = null;
    u.patrol = null;
    // Volle Bewegungspunkte gibt es beim Reaktivieren nur, wenn die Einheit diese Runde
    // noch gar nichts getan hat (Stand-Befehl kam aus einer Vorrunde). Hat sie diese Runde
    // schon (teilweise) bewegt und wurde DANACH z.B. auf Warten gesetzt, bleiben die
    // bereits verbrauchten Bewegungspunkte verbraucht — kein Nachschub durchs Aufwecken.
    if(!u.actedAtAll){
      const fullMove = effStat(u,'move');
      u.movesLeft = isCrippled(u) ? Math.max(1, Math.floor(fullMove/2)) : fullMove;
    }
    u.moved = u.movesLeft<=0;
  }
  selectedUnit = u;
  closeBuildPanel();
  unloadingCargoUnit = null;
  const reach = (u.dugIn || u.movesLeft<=0) ? { tiles: [], dist: { [key(u.x,u.y)]: 0 } } : computeReachable(u);
  reachableTiles = reach.tiles;
  reachDist = reach.dist;
  attackableTiles = [];
  rangedTiles = [];
  rangeRadiusTiles = [];
  unloadTiles = [];
  const stats = UNIT_STATS[u.type];

  // Angriffsziele: von JEDER innerhalb der Restreichweite erreichbaren Position aus,
  // nicht nur von der Startposition — so kann sich eine Einheit nähern und im selben
  // Zug noch zuschlagen. Waffenlose Einheiten (dmg<=0, z.B. der Ingenieur) bekommen
  // keine Angriffsziele — sie könnten ohnehin nie einen Kampf gewinnen.
  const origins = [{x:u.x,y:u.y,d:0}, ...reachableTiles.map(t=>({x:t.x,y:t.y,d:reachDist[key(t.x,t.y)]}))];
  const seenAttack = new Set();
  if(stats.dmg > 0){
    for(const o of origins){
      for(const t of adjacentTiles(o.x,o.y)){
        const tk = key(t.x,t.y);
        if(seenAttack.has(tk)) continue;
        const def = pickDefenderAt(t.x,t.y,u);
        if(def){
          const entryCost = o.d + terrainCost(map[t.y][t.x], u);
          if(entryCost <= u.movesLeft){ attackableTiles.push(t); seenAttack.add(tk); }
          continue;
        }
        const tile = map[t.y][t.x];
        const occ = unitsAt(t.x,t.y);
        // Verbrannte/zerstörte Städte (Enhanced) sind reine Trümmerfelder ohne Verteidigung
        // — kein Angriffsziel, einfach begehbares Gelände (nur ein Ingenieur kann sie
        // wiederaufbauen).
        if(occ.length===0 && ((tile.type===T_CITY && !tile.ruined) || tile.type===T_AIRPORT || tile.type===T_RADAR) && tile.owner!==u.owner && stats.subclass==='land'){
          attackableTiles.push(t);
          seenAttack.add(tk);
        }
      }
    }
  }

  // Fernkampf ist unabhängig von der Bewegung: die Einheit darf vorher schon (teilweise)
  // gezogen sein, solange noch mindestens ein Bewegungspunkt übrig ist. Das Ziel muss nur
  // innerhalb der Feuerreichweite um die aktuelle Position liegen, nicht in Zugreichweite.
  if(stats.range > 0 && u.movesLeft > 0){
    for(let dy=-stats.range; dy<=stats.range; dy++){
      for(let dx=-stats.range; dx<=stats.range; dx++){
        if(dx===0 && dy===0) continue;
        if(Math.max(Math.abs(dx),Math.abs(dy)) > stats.range) continue;
        const nx=u.x+dx, ny=u.y+dy;
        if(!inBounds(nx,ny)) continue;
        rangeRadiusTiles.push({x:nx,y:ny});
        const def = pickDefenderAt(nx,ny,u);
        if(def) rangedTiles.push({x:nx,y:ny});
      }
    }
  }

  renderUnitActions();
  updateSelectionInfo();
  centerCameraOn(u.x*BASE_TILE+BASE_TILE/2, u.y*BASE_TILE+BASE_TILE/2);
  render();
}

// Ist diese Einheit für die Auto-Auswahl "erledigt" (kein offener Befehl mehr)?
// Rasten/Warten, ein gesetztes Marschziel/Patrouille und befestigte Einheiten zählen
// als erledigt — sie sollen nicht erneut vorgeschlagen werden, sind aber weiterhin per
// Klick erreichbar (z.B. um den Befehl aufzuheben oder auszugraben).
function isUnitPending(u){
  return !u.moved && !u.orderState && !u.destination && !u.patrol && !u.dugIn;
}

// Nächste eigene Einheit, die noch keinen Befehl für diese Runde hat. Ist eine
// Referenzposition (die zuletzt bewegte Einheit) angegeben, gewinnt die räumlich nächste
// Einheit — bei mehreren gleich weit entfernten entscheidet wie zuvor die zyklische
// ID-Reihenfolge. Ohne Referenzposition (z.B. Rundenbeginn) gilt nur die ID-Zyklik.
function findNextIdleUnit(afterId, fromPos){
  const list = unitsOf(OWNER_PLAYER).filter(isUnitPending).sort((a,b)=>a.id-b.id);
  if(list.length===0) return null;
  const cyclic = (candidates) => {
    if(afterId==null) return candidates[0];
    const idx = candidates.findIndex(u=>u.id>afterId);
    return idx>=0 ? candidates[idx] : candidates[0];
  };
  if(!fromPos) return cyclic(list);
  const distSq = (u) => (u.x-fromPos.x)**2 + (u.y-fromPos.y)**2;
  const minDist = Math.min(...list.map(distSq));
  return cyclic(list.filter(u => distSq(u)===minDist));
}

// TAB: zyklisch durch wirklich unerledigte Einheiten wechseln — identisch zur
// Auto-Auswahl-Warteschlange. Rasten/Warten/Befestigt UND Einheiten mit laufendem
// Marschziel/Patrouille sind ausgeschlossen: die sind bereits unterwegs bzw. geparkt,
// TAB soll nicht damit nerven.
function findNextInactiveUnit(afterId, fromPos){
  return findNextIdleUnit(afterId, fromPos);
}

// Schließt die Aktion einer Einheit ab und wählt automatisch die dieser Einheit räumlich
// nächste unerledigte Einheit des Spielers aus (falls noch eine übrig ist).
function finishUnitTurn(unit){
  const finishedId = unit ? unit.id : null;
  const fromPos = unit ? {x:unit.x, y:unit.y} : null;
  deselect();
  checkGameOver();
  updateHud();
  if(!gameOver && currentTurnOwner===OWNER_PLAYER){
    const next = findNextIdleUnit(finishedId, fromPos);
    if(next) selectUnit(next);
  }
}

// Wie finishUnitTurn, wartet aber zuerst, bis eine laufende Bewegungsanimation dieser
// Einheit fertig ist — so bleibt der Fokus/die Kamera auf der Einheit, bis sie ihr Ziel
// sichtbar erreicht hat, statt schon während des Gleitens zur nächsten zu springen.
function finishUnitTurnAfterAnim(unit){
  if(unit && unit._animFrom){
    const remaining = unit._animDuration - (performance.now() - unit._animStart);
    if(remaining > 0){
      setTimeout(() => finishUnitTurnAfterAnim(unit), remaining + 20);
      return;
    }
  }
  finishUnitTurn(unit);
}

// Bewusst auf die Basics beschränkt — Farbcodes/Hotkeys stehen schon auf den Buttons,
// eine Wiederholung als Text kostet nur Platz.
function updateSelectionInfo(){
  if(!selectedUnit){ updateInfoPanel('Wähle eine Einheit aus, um sie zu bewegen oder anzugreifen.'); return; }
  const u = selectedUnit, s = UNIT_STATS[u.type];
  let parts = [`${s.name} ausgewählt`, `HP ${u.hp}/${effStat(u,'hp')}`, `Bew ${u.movesLeft}/${effStat(u,'move')}`, effName(u), EXPERIENCE_NAME[u.experience]];
  if(isEnhanced() && u.level>0) parts.push(`Lvl ${u.level} (${u.killXp}/100 XP)`);
  if(s.fuel !== undefined) parts.push(`Sprit ${u.fuel}/${s.fuel}`);
  if(u.dugIn) parts.push('Befestigt');
  if(isCrippled(u)) parts.push('Angeschlagen');
  if(u.subLevel==='deep') parts.push('Getaucht');
  if(u.cargo && u.cargo.length) parts.push(`Fracht ${u.cargo.length}/${s.portageCapacity}`);
  if(u.destination) parts.push('Marschbefehl aktiv');
  if(u.patrol) parts.push('Patrouille aktiv');
  updateInfoPanel(parts.join(' | '));
}

function deselect(){
  selectedUnit = null;
  reachableTiles = [];
  attackableTiles = [];
  rangedTiles = [];
  rangeRadiusTiles = [];
  unloadTiles = [];
  unloadingCargoUnit = null;
  awaitingWaypointClick = false;
  awaitingPatrolStep = 0;
  patrolPointA = null;
  renderUnitActions();
  render();
}

/* ---------- AKTIONSLEISTE ---------- */
function renderUnitActions(){
  const bar = document.getElementById('unit-actions');
  bar.innerHTML = '';
  if(!selectedUnit || currentTurnOwner!==OWNER_PLAYER){ return; }
  const u = selectedUnit, s = UNIT_STATS[u.type];

  // Buttons zeigen nur Icon (+ Hotkey, falls vorhanden) — die volle Beschreibung steht im
  // title-Tooltip. Die Tastenbelegung ist ohnehin auf dem Button selbst sichtbar, ein
  // ausgeschriebenes Label daneben kostet auf kleinen Bildschirmen nur Platz.
  const addBtn = (label, onClick, toggled, title) => {
    const b = document.createElement('button');
    b.className = 'unit-action-btn' + (toggled?' toggled':'');
    b.textContent = label;
    if(title) b.title = title;
    if(onClick) b.addEventListener('click', onClick);
    bar.appendChild(b);
  };

  // Ein laufender Ingenieur-Bauauftrag blockiert wie jeder andere Standbefehl die
  // restlichen Aktionen, bekommt aber (als einzige Ausnahme zu u.moved) einen
  // Abbrechen-Button, damit der Auftrag jederzeit aufgehoben werden kann.
  if(u.buildOrder){
    const turnsLeft = Math.ceil(u.buildOrder.turnsLeft);
    addBtn(`🚧${turnsLeft} ✕`, () => cancelEngineerBuild(u), false,
      `Baut ${ENGINEER_BUILD_LABEL[u.buildOrder.type]||''}... (${turnsLeft} Runde${turnsLeft===1?'':'n'}) — Klicken zum Abbrechen`);
    return;
  }
  if(u.moved) return;

  addBtn('🎯 G', () => {
    awaitingWaypointClick = true;
    updateInfoPanel('Zielpunkt auf der Karte anklicken (auch außerhalb der Reichweite)...');
  }, awaitingWaypointClick, 'Marschziel setzen [G]');

  addBtn('🔁 P', () => {
    awaitingPatrolStep = 1;
    patrolPointA = null;
    updateInfoPanel('Patrouille: ersten Wegpunkt anklicken...');
  }, awaitingPatrolStep>0, 'Patrouille [P]');

  addBtn('💤 R', () => commandOrderState(u, 'resting'), false, 'Rasten [R]');
  addBtn('⏸ W', () => commandOrderState(u, 'waiting'), false, 'Warten [W]');
  addBtn('⏭ X', () => commandPass(u), false, 'Diese Runde aussetzen [X]');

  if(s.canDigIn && !u.dugIn && u.digPending!=='in'){
    addBtn('⛏ B', () => commandFortify(u), false, 'Befestigen (Eingraben) [B]');
  }
  if(u.type==='infantry' && [T_PLAIN,T_FOREST,T_HILLS].includes(map[u.y][u.x].type)){
    addBtn('🛬', () => {
      const tile = map[u.y][u.x];
      tile.type = T_AIRPORT;
      tile.owner = u.owner;
      updateInfoPanel('Flughafen errichtet — die Infanterie wurde dabei aufgelöst.');
      destroyUnit(u);
      finishUnitTurn(u);
    }, false, 'Flughafen bauen (Infanterie wird dabei aufgelöst)');
  }
  if(u.dugIn){
    addBtn('⛏↩', () => {
      u.digPending = 'out';
      u.moved = true; u.movesLeft = 0; u.actedAtAll = true;
      updateInfoPanel('Gräbt sich aus — nächste Runde wieder beweglich.');
      finishUnitTurn(u);
    }, false, 'Ausgraben');
  }
  if(s.range > 0 && rangedTiles.length>0){
    addBtn('🏹', null, true, 'Fernkampf aktiv');
  }
  if(s.canDive){
    if(u.subLevel==='surface'){
      addBtn('🌊', () => {
        u.subLevel = 'deep';
        u.moved = true; u.movesLeft = 0; u.actedAtAll = true;
        updateInfoPanel('U-Boot taucht ab — nur noch von Boden-/U-Boot-Einheiten angreifbar.');
        finishUnitTurn(u);
      }, false, 'Tauchen');
    } else {
      addBtn('⬆', () => {
        u.subLevel = 'surface';
        u.moved = true; u.movesLeft = 0; u.actedAtAll = true;
        updateInfoPanel('U-Boot taucht auf.');
        finishUnitTurn(u);
      }, false, 'Auftauchen');
    }
  }
  if(u.cargo && u.cargo.length>0){
    for(const cid of u.cargo){
      const cu = units.find(x=>x.id===cid);
      if(!cu) continue;
      const cuName = UNIT_STATS[cu.type].name;
      addBtn(`📦 ${cuName.slice(0,3)}`, () => startUnload(u, cu), false, `Entladen: ${cuName}`);
    }
  }

  if(isEnhanced() && s.subclass==='land'){
    const homeTile = map[u.y][u.x];
    if(homeTile.type===T_CITY && !homeTile.ruined && homeTile.owner===u.owner){
      addBtn('🔥', () => destroyCity(u), false, 'Verbrannte Erde: Stadt niederbrennen (nur ein Ingenieur kann sie wiederaufbauen)');
    }
  }

  if(isEnhanced() && u.type==='engineer'){
    const eTile = map[u.y][u.x];
    const buildableGround = [T_PLAIN,T_FOREST,T_HILLS,T_MOUNTAIN].includes(eTile.type);
    addBtn('🛣️', () => {
      awaitingEngineerOrder = { kind:'road' };
      updateInfoPanel('Zielpunkt für die Straße anklicken...');
    }, awaitingEngineerOrder && awaitingEngineerOrder.kind==='road', 'Straße bauen');
    addBtn('🚆', () => {
      awaitingEngineerOrder = { kind:'rail' };
      updateInfoPanel('Zielpunkt für die Eisenbahn anklicken...');
    }, awaitingEngineerOrder && awaitingEngineerOrder.kind==='rail', 'Eisenbahn bauen');
    if(buildableGround && !eTile.fortress){
      addBtn('🏰', () => startEngineerBuild(u, 'fortress', 5), false, 'Festung bauen (5 Runden)');
    }
    if(fogEnabled && buildableGround && eTile.type!==T_RADAR){
      addBtn('📡', () => startEngineerBuild(u, 'radar', 5), false, 'Radar bauen (5 Runden)');
    }
    if([T_PLAIN,T_FOREST,T_HILLS].includes(eTile.type)){
      addBtn('🛬', () => startEngineerBuild(u, 'airport', 2), false, 'Flughafen bauen (2 Runden)');
    }
    if(eTile.type===T_CITY && eTile.ruined){
      addBtn('🏗️', () => startEngineerBuild(u, 'rebuild', 15), false, 'Stadt wiederaufbauen (15 Runden)');
    }
  }
}

function commandOrderState(u, state){
  u.orderState = state;
  u.moved = true; u.movesLeft = 0;
  updateInfoPanel(`${UNIT_STATS[u.type].name} ${state==='resting' ? 'rastet' : 'wartet'} — bei Feindkontakt reaktiviert${state==='resting' ? ', heilt in Städten vollständig aus' : ''}.`);
  finishUnitTurn(u);
}

// Pass: setzt nur DIESE Runde aus (kein dauerhafter Status wie Rasten/Warten) — ab der
// nächsten Runde wird die Einheit wieder normal in die Auswahl-Reihenfolge aufgenommen.
function commandPass(u){
  u.moved = true; u.movesLeft = 0;
  updateInfoPanel(`${UNIT_STATS[u.type].name} setzt diese Runde aus.`);
  finishUnitTurn(u);
}

function commandFortify(u){
  u.digPending = 'in';
  u.moved = true; u.movesLeft = 0; u.actedAtAll = true;
  updateInfoPanel('Gräbt sich ein — wird nächste Runde wirksam und bleibt auch bei Feindkontakt befestigt.');
  finishUnitTurn(u);
}

function startUnload(hostUnit, cargoUnit){
  unloadingCargoUnit = { host: hostUnit, cargo: cargoUnit };
  unloadTiles = adjacentTiles(hostUnit.x, hostUnit.y).filter(t => {
    const tile = map[t.y][t.x];
    if(!terrainAllowed(tile, cargoUnit)) return false;
    return slotStatus(t.x,t.y,cargoUnit) === true;
  });
  reachableTiles = []; attackableTiles = []; rangedTiles = []; rangeRadiusTiles = [];
  updateInfoPanel(`Entladeziel für ${UNIT_STATS[cargoUnit.type].name} wählen (markierte Felder).`);
  render();
}

/* ---------- MAUS-STEUERUNG ---------- */
let isDragging = false, dragMoved = false, unitDragMode = false;
let dragStart = {x:0,y:0}, camStart = {x:0,y:0};
const DRAG_THRESHOLD = 6;

gameCanvas.addEventListener('mousedown', (evt) => {
  if(evt.button !== 0 || inputLocked) return;
  isDragging = true;
  dragMoved = false;
  dragStart = {x:evt.clientX, y:evt.clientY};
  camStart = {x:camera.x, y:camera.y};

  unitDragMode = false;
  if(selectedUnit && currentTurnOwner===OWNER_PLAYER && !selectedUnit.moved){
    const rect = gameCanvas.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (gameCanvas.width/rect.width);
    const sy = (evt.clientY - rect.top) * (gameCanvas.height/rect.height);
    const world = screenToWorld(sx, sy);
    const tx = Math.floor(world.x/BASE_TILE), ty = Math.floor(world.y/BASE_TILE);
    if(tx===selectedUnit.x && ty===selectedUnit.y) unitDragMode = true;
  }
});

window.addEventListener('mousemove', (evt) => {
  if(!isDragging) return;
  const dx = evt.clientX - dragStart.x;
  const dy = evt.clientY - dragStart.y;
  if(Math.hypot(dx,dy) > DRAG_THRESHOLD) dragMoved = true;
  if(!dragMoved) return;

  if(unitDragMode){
    const rect = gameCanvas.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (gameCanvas.width/rect.width);
    const sy = (evt.clientY - rect.top) * (gameCanvas.height/rect.height);
    const world = screenToWorld(sx, sy);
    dragPreviewTarget = { x: Math.floor(world.x/BASE_TILE), y: Math.floor(world.y/BASE_TILE) };
    render();
  } else {
    gameCanvas.classList.add('dragging');
    camera.x = camStart.x - dx / camera.zoom;
    camera.y = camStart.y - dy / camera.zoom;
    clampCamera();
    render();
  }
});

window.addEventListener('mouseup', (evt) => {
  if(!isDragging) return;
  isDragging = false;
  gameCanvas.classList.remove('dragging');
  const rect = gameCanvas.getBoundingClientRect();
  const sx = (evt.clientX - rect.left) * (gameCanvas.width/rect.width);
  const sy = (evt.clientY - rect.top) * (gameCanvas.height/rect.height);
  const inCanvas = sx>=0 && sy>=0 && sx<=gameCanvas.width && sy<=gameCanvas.height;

  if(unitDragMode && dragMoved && inCanvas && selectedUnit){
    const world = screenToWorld(sx, sy);
    const tx = Math.floor(world.x/BASE_TILE), ty = Math.floor(world.y/BASE_TILE);
    dragPreviewTarget = null;
    unitDragMode = false;
    if(inBounds(tx,ty)){
      if(reachableTiles.some(t=>t.x===tx && t.y===ty) || attackableTiles.some(t=>t.x===tx && t.y===ty)){
        handleGameClick(sx, sy);
      } else if(tx!==selectedUnit.x || ty!==selectedUnit.y){
        setDestination(selectedUnit, tx, ty);
        render();
      }
    }
    return;
  }
  unitDragMode = false;
  dragPreviewTarget = null;

  if(!dragMoved && inCanvas){
    handleGameClick(sx, sy);
  } else {
    render();
  }
});

gameCanvas.addEventListener('wheel', (evt) => {
  evt.preventDefault();
  const rect = gameCanvas.getBoundingClientRect();
  const sx = (evt.clientX - rect.left) * (gameCanvas.width/rect.width);
  const sy = (evt.clientY - rect.top) * (gameCanvas.height/rect.height);
  const factor = evt.deltaY < 0 ? 1.15 : 1/1.15;
  zoomAt(factor, sx, sy);
}, { passive:false });

document.getElementById('zoom-in-btn').addEventListener('click', () => zoomAt(1.25, gameCanvas.width/2, gameCanvas.height/2));
document.getElementById('zoom-out-btn').addEventListener('click', () => zoomAt(1/1.25, gameCanvas.width/2, gameCanvas.height/2));
document.getElementById('home-btn').addEventListener('click', () => {
  const caps = citiesOf(OWNER_PLAYER).filter(c => map[c.y][c.x].capital);
  const cap = caps[0] || citiesOf(OWNER_PLAYER)[0];
  if(cap) centerCameraOn(cap.x*BASE_TILE + BASE_TILE/2, cap.y*BASE_TILE + BASE_TILE/2);
});
let minimapVisible = true;
document.getElementById('minimap-toggle-btn').addEventListener('click', () => {
  minimapVisible = !minimapVisible;
  document.getElementById('minimap-canvas').classList.toggle('hidden', !minimapVisible);
});

window.addEventListener('keydown', (evt) => {
  if(document.getElementById('game-screen').classList.contains('hidden')) return;
  if(inputLocked) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if(tag==='INPUT' || tag==='TEXTAREA') return;
  const panStep = 60 / camera.zoom;
  const k = evt.key;

  if(k===' ' || k==='Spacebar' || evt.code==='Space'){
    evt.preventDefault();
    endPlayerTurn();
    return;
  }
  if(k==='Tab' && currentTurnOwner===OWNER_PLAYER){
    evt.preventDefault();
    const next = findNextInactiveUnit(selectedUnit ? selectedUnit.id : null);
    if(next) selectUnit(next);
    return;
  }
  if(currentTurnOwner===OWNER_PLAYER && selectedUnit && !selectedUnit.moved){
    if(k==='r' || k==='R'){ commandOrderState(selectedUnit, 'resting'); return; }
    if(k==='w' || k==='W'){ commandOrderState(selectedUnit, 'waiting'); return; }
    if(k==='x' || k==='X'){ commandPass(selectedUnit); return; }
    if((k==='b' || k==='B') && UNIT_STATS[selectedUnit.type].canDigIn && !selectedUnit.dugIn){ commandFortify(selectedUnit); return; }
    if(k==='g' || k==='G'){ awaitingWaypointClick = true; updateInfoPanel('Zielpunkt auf der Karte anklicken...'); renderUnitActions(); return; }
    if(k==='p' || k==='P'){ awaitingPatrolStep = 1; patrolPointA = null; updateInfoPanel('Patrouille: ersten Wegpunkt anklicken...'); renderUnitActions(); return; }
  }
  if(k==='ArrowLeft'){ camera.x -= panStep; clampCamera(); render(); }
  else if(k==='ArrowRight'){ camera.x += panStep; clampCamera(); render(); }
  else if(k==='ArrowUp'){ camera.y -= panStep; clampCamera(); render(); }
  else if(k==='ArrowDown'){ camera.y += panStep; clampCamera(); render(); }
  else if(k==='+' || k==='='){ zoomAt(1.2, gameCanvas.width/2, gameCanvas.height/2); }
  else if(k==='-'){ zoomAt(1/1.2, gameCanvas.width/2, gameCanvas.height/2); }
});

minimapCanvas.addEventListener('click', (evt) => {
  const rect = minimapCanvas.getBoundingClientRect();
  const mx = (evt.clientX - rect.left) * (minimapCanvas.width/rect.width);
  const my = (evt.clientY - rect.top) * (minimapCanvas.height/rect.height);
  const scale = minimapCanvas.width / worldW();
  centerCameraOn(mx/scale, my/scale);
});

/* ---------- KLICK-LOGIK ---------- */
function handleGameClick(sx, sy){
  if(gameOver || inputLocked) return;
  const world = screenToWorld(sx, sy);
  const x = Math.floor(world.x / BASE_TILE);
  const y = Math.floor(world.y / BASE_TILE);
  if(!inBounds(x,y)) return;
  if(currentTurnOwner !== OWNER_PLAYER) return;

  // Sammelpunkt-Modus (Baumenü) hat die höchste Priorität
  if(awaitingRallyClick){
    const city = awaitingRallyClick;
    awaitingRallyClick = null;
    map[city.y][city.x].rallyPoint = {x,y};
    if(selectedBuildCity && selectedBuildCity.x===city.x && selectedBuildCity.y===city.y) renderBuildPanel();
    updateInfoPanel('Sammelpunkt gesetzt — neu gebaute Einheiten marschieren automatisch dorthin.');
    render();
    return;
  }

  // Ingenieur-Straßen-/Eisenbahnbau (Enhanced): Zielpunkt anklicken, der Ingenieur wählt
  // den Weg selbst (wie beim Marschziel) und bebaut jedes Feld auf dem Weg der Reihe nach.
  if(awaitingEngineerOrder && selectedUnit){
    const kind = awaitingEngineerOrder.kind;
    awaitingEngineerOrder = null;
    const unit = selectedUnit;
    const path = computePathTowards(unit, {x,y});
    if(!path || path.length===0){
      updateInfoPanel('Zielpunkt für den Bauauftrag ist nicht erreichbar.');
    } else {
      const fullPath = [{x:unit.x,y:unit.y}, ...path];
      const firstTile = map[fullPath[0].y][fullPath[0].x];
      unit.buildOrder = { type:kind, path: fullPath.slice(1), turnsLeft: engineerTileCost(kind, firstTile.type, firstTile.road) };
      unit.moved = true;
      updateInfoPanel(`${kind==='road'?'Straßenbau':'Eisenbahnbau'} gestartet (${fullPath.length} Feld(er)).`);
      finishUnitTurn(unit);
      return;
    }
    renderUnitActions();
    render();
    return;
  }

  // Marschziel-Modus (Taste G oder Aktionsleiste) hat höchste Priorität. Die Einheit
  // marschiert sofort los, genau wie bei einem normalen Klick innerhalb der Reichweite.
  if(awaitingWaypointClick && selectedUnit){
    awaitingWaypointClick = false;
    const unit = selectedUnit;
    if(setDestination(unit, x, y)){
      advanceWaypoint(unit);
      const stillSelectable = units.includes(unit) && !unit.moved;
      if(stillSelectable){
        deselect();
        selectUnit(unit);
        checkGameOver(); updateHud();
      } else {
        finishUnitTurnAfterAnim(unit);
      }
    } else {
      renderUnitActions();
      render();
    }
    return;
  }

  // Patrouillen-Modus (Taste P oder Aktionsleiste): zwei Wegpunkte nacheinander wählen
  if(awaitingPatrolStep>0 && selectedUnit){
    const pStats = UNIT_STATS[selectedUnit.type];
    const pTile = map[y][x];
    if(pStats.category==='air' && (![T_CITY,T_AIRPORT].includes(pTile.type) || pTile.owner!==selectedUnit.owner)){
      updateInfoPanel('Flugzeuge müssen an einer EIGENEN Stadt oder einem Flughafen patrouillieren.');
      return;
    }
    if(awaitingPatrolStep===1){
      patrolPointA = {x,y};
      awaitingPatrolStep = 2;
      updateInfoPanel('Patrouille: zweiten Wegpunkt anklicken...');
      return;
    }
    awaitingPatrolStep = 0;
    const unit = selectedUnit;
    unit.patrol = { a: patrolPointA, b: {x,y}, target: 'b' };
    unit.destination = null;
    patrolPointA = null;
    updateInfoPanel('Patrouille eingerichtet — Einheit pendelt selbständig zwischen beiden Punkten.');
    advancePatrol(unit);
    const stillSelectable = units.includes(unit) && !unit.moved;
    if(stillSelectable){
      deselect();
      selectUnit(unit);
      checkGameOver(); updateHud();
    } else {
      finishUnitTurnAfterAnim(unit);
    }
    return;
  }

  // Entlade-Modus
  if(unloadingCargoUnit){
    if(unloadTiles.some(t=>t.x===x && t.y===y)){
      const { host, cargo } = unloadingCargoUnit;
      cargo.x = x; cargo.y = y;
      cargo.hostId = null;
      cargo.orderState = null;
      cargo.moved = true; cargo.movesLeft = 0; cargo.actedAtAll = true;
      host.cargo = host.cargo.filter(id=>id!==cargo.id);
      updateInfoPanel(`${UNIT_STATS[cargo.type].name} entladen.`);
      unloadingCargoUnit = null; unloadTiles = [];
      const stillThere = units.includes(host) && !host.moved;
      deselect();
      if(stillThere) selectUnit(host);
      checkGameOver(); updateHud();
      return;
    }
    unloadingCargoUnit = null; unloadTiles = [];
    render();
    return;
  }

  closeBuildPanel();
  const tile = map[y][x];

  // Bau-Hotspot (Zahnrad oben rechts in eigener Stadt)
  if(tile.type===T_CITY && tile.owner===OWNER_PLAYER){
    const scr = worldToScreen(x*BASE_TILE, y*BASE_TILE);
    const size = BASE_TILE * camera.zoom;
    const hs = size * 0.4;
    if(sx >= scr.x+size-hs && sx <= scr.x+size && sy >= scr.y && sy <= scr.y+hs){
      openBuildPanel(x,y);
      return;
    }
  }

  if(selectedUnit){
    const stats = UNIT_STATS[selectedUnit.type];

    if(rangedTiles.some(t=>t.x===x && t.y===y)){
      const def = pickDefenderAt(x,y,selectedUnit);
      if(def){
        const attackerSnap = snapshotUnit(selectedUnit);
        const defenderSnap = snapshotUnit(def.target);
        const res = resolveRangedAttack(selectedUnit, def.target);
        updateInfoPanel(res.destroyed ? 'Ziel durch Fernkampf zerstört!' : (res.hitAny ? 'Treffer, Ziel überlebt.' : 'Fernkampf verfehlt.'));
        if(units.includes(selectedUnit)){ selectedUnit.moved = true; selectedUnit.movesLeft = 0; selectedUnit.actedAtAll = true; }
        const finishedUnit = selectedUnit;
        playCombatSequence(attackerSnap, defenderSnap, () => finishUnitTurn(finishedUnit));
        return;
      }
    }

    if(attackableTiles.some(t=>t.x===x && t.y===y)){
      const animFromX = selectedUnit.x, animFromY = selectedUnit.y;
      const def = pickDefenderAt(x,y,selectedUnit);
      if(def){
        const attackerSnap = snapshotUnit(selectedUnit);
        const defenderSnap = snapshotUnit(def.target);
        const res = resolveMeleeAttack(selectedUnit, def.target, def.noEntry);
        let canEnter = false;
        if(res.winner==='attacker'){
          const destTile = map[y][x];
          // Landeinheiten dürfen Wassereinheiten (und umgekehrt Schiffe Landfelder) nie
          // tatsächlich betreten, auch wenn sie den Kampf gewinnen — Angriff ja, Einzug nein.
          canEnter = res.entered && terrainAllowed(destTile, selectedUnit);
          if(canEnter){
            if(((destTile.type===T_CITY && !destTile.ruined) || destTile.type===T_AIRPORT || destTile.type===T_RADAR) && destTile.owner!==selectedUnit.owner && stats.subclass==='land'){
              if(destTile.type===T_CITY) captureCity(x,y, selectedUnit.owner, selectedUnit, true);
              else destTile.owner = selectedUnit.owner;
            }
            updateInfoPanel('Gegner besiegt, Feld eingenommen!');
          } else {
            updateInfoPanel('Gegner besiegt — Einheit bleibt auf ihrem Feld.');
          }
          if(units.includes(selectedUnit)){ selectedUnit.moved = true; selectedUnit.movesLeft = 0; selectedUnit.actedAtAll = true; }
        } else {
          updateInfoPanel('Eigene Einheit im Kampf verloren!');
        }
        const finishedUnit = selectedUnit;
        // Sowohl die Positionsänderung als auch die Bewegungsanimation erfolgen erst NACH
        // der Kampfsequenz — sonst stünde die Einheit optisch schon im eroberten Feld,
        // während der Ausgang (Blinken) noch offen ist.
        playCombatSequence(attackerSnap, defenderSnap, () => {
          if(canEnter && units.includes(finishedUnit)){
            if(finishedUnit.pendingCaptureMorph){
              applyPendingCaptureMorph(finishedUnit);
            } else {
              finishedUnit.x = x; finishedUnit.y = y;
              queueMoveAnim(finishedUnit, animFromX, animFromY);
            }
          }
          finishUnitTurnAfterAnim(finishedUnit);
        });
        return;
      }
      // Unbesetzte gegnerische/neutrale Stadt oder Flughafen: Städte verteidigen sich wie
      // eine Infanterie-Einheit (natürliche Verteidigung) — das ist ein echter Kampf und
      // bekommt daher dieselbe Blink+Sound-Sequenz wie ein Kampf gegen eine Einheit.
      const attackerSnap = snapshotUnit(selectedUnit);
      const cityOwnerBefore = map[y][x].owner;
      const wasAirport = map[y][x].type===T_AIRPORT || map[y][x].type===T_RADAR;
      const defenderSnap = { x, y, type:'infantry', owner: cityOwnerBefore };
      const survived = tryCaptureStructure(selectedUnit, x, y, true);
      const capturedType = map[y][x].type;
      if(survived){
        updateInfoPanel(capturedType===T_AIRPORT ? 'Flughafen erobert!' : (capturedType===T_RADAR ? 'Radarstation erobert!' : 'Stadt erobert!'));
      } else {
        updateInfoPanel('Angriff auf die Stadtverteidigung gescheitert — Einheit verloren!');
      }
      if(units.includes(selectedUnit)){ selectedUnit.moved = true; selectedUnit.movesLeft = 0; selectedUnit.actedAtAll = true; }
      const finishedUnit = selectedUnit;
      const enterField = () => {
        if(!survived || !units.includes(finishedUnit)) return;
        if(finishedUnit.pendingCaptureMorph){
          applyPendingCaptureMorph(finishedUnit);
        } else {
          finishedUnit.x = x; finishedUnit.y = y;
          queueMoveAnim(finishedUnit, animFromX, animFromY);
        }
      };
      if(wasAirport){
        // Flughäfen haben keine eigene Verteidigung — kein Kampf, die Bewegung darf sofort
        // gezeigt werden.
        enterField();
        finishUnitTurnAfterAnim(finishedUnit);
      } else {
        // Auch hier: erst blinken/kämpfen lassen, danach erst der sichtbare Einzug.
        playCombatSequence(attackerSnap, defenderSnap, () => {
          enterField();
          finishUnitTurnAfterAnim(finishedUnit);
        });
      }
      return;
    }

    // Bewegen (inkl. Laden auf Schiff/Träger) — verbraucht nur die tatsächlichen
    // Bewegungspunkte; bei Restpunkten bleibt die Einheit für weitere Klicks wählbar.
    if(reachableTiles.some(t=>t.x===x && t.y===y)){
      const animFromX = selectedUnit.x, animFromY = selectedUnit.y;
      const hostAtDest = units.find(o => o.x===x && o.y===y && o.hp>0 && o.owner===selectedUnit.owner &&
        UNIT_STATS[o.type].canCarry && UNIT_STATS[o.type].canCarry.includes(selectedUnit.type));
      const costUsed = reachDist[key(x,y)] || 0;
      selectedUnit.movesLeft = Math.max(0, selectedUnit.movesLeft - costUsed);
      selectedUnit.actedAtAll = true;
      if(selectedUnit.movesLeft<=0) selectedUnit.moved = true;
      if(selectedUnit.destination) selectedUnit.destination = null;

      let cityCombat = null; // {attackerSnap, defenderSnap} falls eine Stadtverteidigung bekämpft wurde
      let deferMoveAnim = false; // true, solange der sichtbare Einzug erst nach dem Kampf gezeigt werden soll
      if(hostAtDest && hostAtDest.cargo.length < UNIT_STATS[hostAtDest.type].portageCapacity){
        selectedUnit.hostId = hostAtDest.id;
        selectedUnit.orderState = null;
        selectedUnit.x = hostAtDest.x; selectedUnit.y = hostAtDest.y;
        selectedUnit.moved = true; selectedUnit.movesLeft = 0;
        hostAtDest.cargo.push(selectedUnit.id);
        updateInfoPanel(`${stats.name} an Bord von ${UNIT_STATS[hostAtDest.type].name} geladen.`);
      } else {
        const destTile = map[y][x];
        if(destTile.type===T_CITY && !destTile.ruined && destTile.owner!==selectedUnit.owner && stats.subclass==='land'){
          // Auch beim Reinlaufen in eine unbesetzte Stadt kämpft die Einheit gegen deren
          // Grundverteidigung — das soll genauso wie ein echter Kampf sichtbar sein. Die
          // Einheit betritt die Stadt daher (wie bei echtem Kampf) erst NACH dem Ausgang,
          // damit sie nicht schon während der Blink-Sequenz dort steht.
          const attackerSnap = snapshotUnit(selectedUnit); // noch an der alten Position
          const defenderSnap = { x, y, type:'infantry', owner: destTile.owner };
          const survived = tryCaptureStructure(selectedUnit, x, y, true);
          // Positionswechsel bewusst NICHT hier, sondern erst im finish()-Callback nach der
          // Kampfsequenz (siehe unten) — sonst stünde die Einheit optisch schon in der Stadt.
          updateInfoPanel(survived ? 'Stadt erobert!' : 'Angriff auf die Stadtverteidigung gescheitert — Einheit verloren!');
          cityCombat = { attackerSnap, defenderSnap, survived };
          deferMoveAnim = true;
        } else {
          selectedUnit.x = x; selectedUnit.y = y;
          const isUnclaimedStructure = ((destTile.type===T_CITY && !destTile.ruined) || destTile.type===T_AIRPORT || destTile.type===T_RADAR) && destTile.owner!==selectedUnit.owner;
          if(isUnclaimedStructure){
            if(stats.subclass==='land'){
              tryCaptureStructure(selectedUnit, x, y);
              updateInfoPanel(destTile.type===T_RADAR ? 'Radarstation erobert!' : 'Flughafen erobert!');
            } else {
              updateInfoPanel('Angelegt – nur Landeinheiten erobern Städte.');
            }
          } else {
            refuelIfOnOwnCity(selectedUnit);
            updateInfoPanel(selectedUnit.movesLeft>0 ? `Bewegt — noch ${selectedUnit.movesLeft} Bewegungspunkt(e) übrig.` : 'Einheit bewegt.');
          }
        }
      }
      if(!deferMoveAnim && units.includes(selectedUnit)) queueMoveAnim(selectedUnit, animFromX, animFromY);
      const movedUnit = selectedUnit;
      const finish = () => {
        const stillSelectable = units.includes(movedUnit) && !movedUnit.moved;
        if(stillSelectable){
          deselect();
          selectUnit(movedUnit);
          checkGameOver(); updateHud();
        } else {
          finishUnitTurnAfterAnim(movedUnit);
        }
      };
      if(cityCombat){
        playCombatSequence(cityCombat.attackerSnap, cityCombat.defenderSnap, () => {
          if(cityCombat.survived && units.includes(movedUnit)){
            if(movedUnit.pendingCaptureMorph){
              applyPendingCaptureMorph(movedUnit);
            } else {
              movedUnit.x = x; movedUnit.y = y;
              queueMoveAnim(movedUnit, animFromX, animFromY);
            }
          }
          finish();
        });
      } else {
        finish();
      }
      return;
    }

    if(!selectOrCycleStackAt(x,y)) deselect();
    return;
  }

  selectOrCycleStackAt(x,y);
}

// Wählt die eigene Einheit an (x,y) aus. Liegen mehrere dort (Stadt-/Flughafen-Garnison),
// schaltet ein erneuter Klick auf dieselbe Kachel zur jeweils nächsten Einheit im Stapel
// weiter, statt immer dieselbe (erste) auszuwählen. Gibt zurück, ob eine Einheit gewählt wurde.
function selectOrCycleStackAt(x,y){
  const stack = unitsAt(x,y)
    .filter(u=>u.owner===OWNER_PLAYER && (!u.moved || u.orderState || u.destination || u.patrol || u.dugIn || u.buildOrder))
    .sort((a,b)=>a.id-b.id);
  if(stack.length===0) return false;
  if(selectedUnit && stack.includes(selectedUnit) && stack.length>1){
    const idx = stack.indexOf(selectedUnit);
    selectUnit(stack[(idx+1) % stack.length]);
  } else {
    selectUnit(stack[0]);
  }
  return true;
}

/* ---------- BAUMENÜ ---------- */
function openBuildPanel(x,y){
  selectedBuildCity = {x,y};
  document.getElementById('unit-info-panel').classList.add('hidden');
  renderBuildPanel();
  document.getElementById('build-panel').classList.remove('hidden');
}
function closeBuildPanel(){
  selectedBuildCity = null;
  document.getElementById('build-panel').classList.add('hidden');
}
document.getElementById('build-close-btn').addEventListener('click', closeBuildPanel);
document.getElementById('build-rally-btn').addEventListener('click', () => {
  if(!selectedBuildCity) return;
  awaitingRallyClick = { x: selectedBuildCity.x, y: selectedBuildCity.y };
  updateInfoPanel('Sammelpunkt auf der Karte anklicken...');
});
document.getElementById('build-rally-clear-btn').addEventListener('click', () => {
  if(!selectedBuildCity) return;
  map[selectedBuildCity.y][selectedBuildCity.x].rallyPoint = null;
  renderBuildPanel();
});

function renderBuildPanel(){
  if(!selectedBuildCity) return;
  const { x, y } = selectedBuildCity;
  const tile = map[y][x];
  const coastal = isCoastal(x,y);
  if(UNIT_STATS[tile.buildType].subclass==='sea' && !coastal){
    tile.buildType = 'infantry';
  }
  document.getElementById('build-city-title').textContent = (tile.capital ? 'Hauptstadt' : 'Stadt') + (coastal ? ' ⚓' : '');

  const rate = tile.capital ? CAPITAL_PRODUCTION : CITY_PRODUCTION;
  const converting = isEnhanced() && tile.specializationTimer > 0;
  if(converting){
    document.getElementById('build-progress-label').textContent =
      `Umbau zu ${CITY_SPECIALIZATIONS[tile.pendingSpecialization].name}: noch ${tile.specializationTimer} Runde(n) — keine Produktion`;
    document.getElementById('build-progress-bar').style.width = '0%';
  } else {
    const cost = effectiveBuildCost(tile, tile.buildType);
    const pct = Math.min(100, Math.floor(100 * tile.buildPoints / cost));
    document.getElementById('build-progress-label').textContent =
      `Baut: ${UNIT_STATS[tile.buildType].name} — ${tile.buildPoints}/${cost} (+${rate}/Runde)`;
    document.getElementById('build-progress-bar').style.width = pct + '%';
  }

  document.getElementById('build-rally-label').textContent = tile.rallyPoint
    ? `Sammelpunkt: (${tile.rallyPoint.x}, ${tile.rallyPoint.y})`
    : 'Kein Sammelpunkt';
  document.getElementById('build-rally-clear-btn').classList.toggle('hidden', !tile.rallyPoint);

  renderSpecializationRow(tile, coastal, converting);

  const optionsDiv = document.getElementById('build-options');
  optionsDiv.innerHTML = '';
  for(const type of buildOrderFor()){
    const stats = UNIT_STATS[type];
    const disabled = (stats.subclass==='sea' && !coastal) || converting;
    const btn = document.createElement('button');
    btn.className = 'build-option' + (tile.buildType===type ? ' active' : '') + (disabled ? ' disabled' : '');
    const fuelStr = stats.fuel !== undefined ? `, Sprit ${stats.fuel}` : '';
    const rangeStr = stats.range>0 ? `, Reich ${stats.range}` : '';
    const portStr = stats.portageCapacity ? `, Fracht ${stats.portageCapacity}` : '';
    const effCost = effectiveBuildCost(tile, type);
    const costStr = effCost < stats.cost ? `<s>${stats.cost}</s> ${effCost}⚙` : `${stats.cost}⚙`;
    btn.innerHTML = `<span class="bo-name">${stats.label} ${stats.name}</span>` +
      `<span class="bo-stats">${(stats.subclass==='sea' && !coastal) ? 'Nur in Küstenstädten (angrenzendes Wasser)' : `Bew ${stats.move} / Dmg ${stats.dmg} / Ang% ${stats.power} / Vert% ${stats.defense} / HP ${stats.hp}${rangeStr}${fuelStr}${portStr}`}</span>` +
      `<span class="bo-cost">${costStr}</span>`;
    if(disabled){
      btn.disabled = true;
      btn.title = converting ? 'Während des Stadtumbaus keine Produktion möglich' : 'Nur in Küstenstädten verfügbar (angrenzendes Wasser nötig)';
    } else {
      btn.addEventListener('click', () => {
        tile.buildType = type;
        renderBuildPanel();
      });
    }
    optionsDiv.appendChild(btn);
  }
}

// Enhanced: Spezialisierungs-Auswahl/-Fortschritt im Baumenü — eigener Abschnitt, damit
// renderBuildPanel() nicht zu unübersichtlich wird.
function renderSpecializationRow(tile, coastal, converting){
  const row = document.getElementById('build-specialization-row');
  if(!isEnhanced()){ row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  row.innerHTML = '';
  if(converting){
    const label = document.createElement('span');
    label.className = 'build-spec-label';
    label.textContent = `🏗️ Umbau zu ${CITY_SPECIALIZATIONS[tile.pendingSpecialization].icon} ${CITY_SPECIALIZATIONS[tile.pendingSpecialization].name} — noch ${tile.specializationTimer} Runde(n)`;
    row.appendChild(label);
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'build-spec-btn';
    cancelBtn.textContent = '✕ Abbrechen';
    cancelBtn.addEventListener('click', () => {
      tile.pendingSpecialization = null;
      tile.specializationTimer = 0;
      renderBuildPanel();
    });
    row.appendChild(cancelBtn);
    return;
  }
  const label = document.createElement('span');
  label.className = 'build-spec-label';
  label.textContent = tile.specialization
    ? `${CITY_SPECIALIZATIONS[tile.specialization].icon} ${CITY_SPECIALIZATIONS[tile.specialization].name}`
    : 'Keine Spezialisierung';
  row.appendChild(label);
  for(const key of Object.keys(CITY_SPECIALIZATIONS)){
    if(key===tile.specialization) continue;
    if(key==='harbor' && !coastal) continue;
    const spec = CITY_SPECIALIZATIONS[key];
    const btn = document.createElement('button');
    btn.className = 'build-spec-btn';
    btn.textContent = `${spec.icon} ${spec.name}`;
    btn.title = `${spec.types.map(t=>UNIT_STATS[t].name).join('/')} 20% schneller/günstiger — Umbauzeit ${tile.specialization ? 15 : 10} Runden`;
    btn.addEventListener('click', () => {
      tile.pendingSpecialization = key;
      tile.specializationTimer = tile.specialization ? 15 : 10;
      renderBuildPanel();
    });
    row.appendChild(btn);
  }
}

/* ---------- EINHEITEN-INFO-PANEL ---------- */
const infoBtn = document.getElementById('info-btn');
const unitInfoPanel = document.getElementById('unit-info-panel');
infoBtn.addEventListener('click', () => {
  closeBuildPanel();
  buildUnitInfoTable();
  unitInfoPanel.classList.toggle('hidden');
});
document.getElementById('info-close-btn').addEventListener('click', () => unitInfoPanel.classList.add('hidden'));

function buildUnitInfoTable(){
  const table = document.getElementById('unit-info-table');
  let html = '<tr><th>Einheit</th><th>Klasse</th><th>Bew.</th><th>Dmg</th><th>Ang%</th><th>Vert%</th><th>HP</th><th>Kosten</th><th>Reich.</th><th>Fracht</th><th>Sprit</th></tr>';
  for(const type of buildOrderFor()){
    const s = UNIT_STATS[type];
    const cls = s.category==='air' ? 'Luft' : (s.subclass==='sea' ? 'See' : 'Boden');
    html += `<tr><td>${s.label} ${s.name}</td><td>${cls}</td>` +
      `<td>${s.move}</td><td>${s.dmg}</td><td>${s.power}</td><td>${s.defense}</td><td>${s.hp}</td><td>${s.cost}</td>` +
      `<td>${s.range||'-'}</td><td>${s.portageCapacity||'-'}</td><td>${s.fuel !== undefined ? s.fuel : '∞'}</td></tr>`;
  }
  table.innerHTML = html;
}

/* ---------- STÄDTE: PRODUKTION ---------- */
function pickAiBuildType(coastal){
  const t = turnNumber;
  let weights;
  if(t < 6) weights = { infantry:0.55, tank:0.25, artillery:0.2, destroyer:0, transport:0, battleship:0, carrier:0, submarine:0, helicopter:0, fighter:0 };
  else if(t < 14) weights = { infantry:0.28, tank:0.24, artillery:0.14, destroyer:0.08, transport:0.08, battleship:0.04, carrier:0.02, submarine:0.04, helicopter:0.06, fighter:0.02 };
  else weights = { infantry:0.16, tank:0.2, artillery:0.1, destroyer:0.08, transport:0.08, battleship:0.1, carrier:0.06, submarine:0.08, helicopter:0.08, fighter:0.06 };
  if(!coastal) weights = Object.assign({}, weights, { destroyer:0, transport:0, battleship:0, carrier:0, submarine:0 });
  // Enhanced: KI baut auch Ingenieure, damit sie Straßen/Eisenbahn/Festungen/Radar
  // tatsächlich einsetzt — moderates Gewicht, kein Kampfwert also nicht zu viele davon.
  if(isEnhanced()) weights = Object.assign({}, weights, { engineer: t < 6 ? 0.1 : 0.12 });
  const order = buildOrderFor();
  const total = order.reduce((a,type)=>a+(weights[type]||0), 0);
  const r = Math.random() * total;
  let acc = 0;
  for(const type of order){
    acc += weights[type] || 0;
    if(r <= acc) return type;
  }
  return 'infantry';
}

// Enhanced: KI wählt gelegentlich für eine ihrer unspezialisierten Städte eine
// Spezialisierung (passend zu Küstenlage), damit die KI die Mechanik auch wirklich nutzt.
// Bewusst simpel gehalten (kleine Zufallschance pro Stadt und Runde) statt eine explizite
// "Stadt X Runden im Besitz"-Verfolgung einzuführen.
function aiConsiderCitySpecialization(owner){
  for(const c of citiesOf(owner)){
    const tile = map[c.y][c.x];
    if(tile.ruined || tile.specialization || tile.specializationTimer>0) continue;
    if(Math.random() > 0.06) continue;
    const coastal = isCoastal(c.x,c.y);
    const choices = coastal ? ['arms','airbase','harbor'] : ['arms','airbase'];
    tile.pendingSpecialization = choices[Math.floor(Math.random()*choices.length)];
    tile.specializationTimer = 10;
  }
}

function processCityProduction(owner){
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const tile = map[y][x];
      if(tile.type===T_CITY && tile.owner===owner){
        // "Last Stand" (Enhanced, ab 80% Städtekontrolle einer Partei): JEDE Stadt jeder
        // Partei spawnt zusätzlich zur normalen Produktion eine Infanterie-Einheit pro
        // Runde — unabhängig von Bauwarteschlange/Umbau, damit sich alle Seiten in der
        // Endphase noch wehren können.
        if(isEnhanced() && lastStandActive){
          spawnUnit(owner, 'infantry', x, y);
        }
        // Stadt-Umbau (Enhanced): läuft ein Spezialisierungswechsel, ruht die Produktion
        // komplett, bis er fertig ist.
        if(isEnhanced() && tile.specializationTimer > 0){
          tile.specializationTimer--;
          if(tile.specializationTimer <= 0){
            tile.specialization = tile.pendingSpecialization;
            tile.pendingSpecialization = null;
          }
          continue;
        }
        const rate = tile.capital ? CAPITAL_PRODUCTION : CITY_PRODUCTION;
        tile.buildPoints += rate;
        let type = tile.buildType || 'infantry';
        if(UNIT_STATS[type].subclass==='sea' && !isCoastal(x,y)){
          type = 'infantry';
          tile.buildType = 'infantry';
        }
        const cost = effectiveBuildCost(tile, type);
        if(tile.buildPoints >= cost){
          // Städte fassen beliebig viele Einheiten — neue Einheiten spawnen direkt dort.
          const spawned = spawnUnit(owner, type, x, y);
          tile.buildPoints -= cost;
          if(owner!==OWNER_PLAYER) tile.buildType = pickAiBuildType(isCoastal(x,y));
          if(tile.rallyPoint && !(tile.rallyPoint.x===x && tile.rallyPoint.y===y)){
            setDestination(spawned, tile.rallyPoint.x, tile.rallyPoint.y, true, true);
          }
        }
      }
    }
  }
}

function processFuel(owner){
  const fighters = units.filter(u => u.owner===owner && u.type==='fighter' && u.hp>0);
  for(const f of fighters){
    if(f.hostId){
      const host = units.find(h=>h.id===f.hostId);
      if(host && host.type==='carrier'){ f.fuel = UNIT_STATS.fighter.fuel; continue; }
    }
    if(f.hostId) continue;
    const tile = map[f.y][f.x];
    if((tile.type===T_CITY || tile.type===T_AIRPORT) && tile.owner===owner){
      f.fuel = UNIT_STATS.fighter.fuel;
    } else {
      f.fuel -= 1;
      if(f.fuel <= 0) destroyUnit(f);
    }
  }
}

// Effektivität/Erfahrung/Reparatur/Eingraben-Übergänge + Bewegungspunkte-Reset
// am Ende des Zugs eines Spielers.
// Transporter/Träger, die in einer Stadt/einem Flughafen stehen, nehmen automatisch
// alle dort stehenden, noch nicht verladenen eigenen Einheiten auf (unabhängig davon, ob
// diese gerastet/gewartet/sich dorthin bewegt haben) — bis die Kapazität erreicht ist.
function autoLoadEligibleUnitsAt(x,y){
  const tile = map[y][x];
  if(tile.type!==T_CITY && tile.type!==T_AIRPORT) return;
  const ships = units.filter(u=>u.x===x && u.y===y && u.hp>0 && !u.hostId && UNIT_STATS[u.type].canCarry);
  if(ships.length===0) return;
  const candidates = units.filter(u=>u.x===x && u.y===y && u.hp>0 && !u.hostId && !UNIT_STATS[u.type].canCarry);
  for(const cargo of candidates){
    if(cargo.hostId) continue;
    const host = ships.find(s => s.owner===cargo.owner &&
      UNIT_STATS[s.type].canCarry.includes(cargo.type) &&
      s.cargo.length < UNIT_STATS[s.type].portageCapacity);
    if(host){
      cargo.hostId = host.id;
      cargo.orderState = null;
      host.cargo.push(cargo.id);
    }
  }
}

function autoLoadAllCities(){
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      if(map[y][x].type===T_CITY || map[y][x].type===T_AIRPORT) autoLoadEligibleUnitsAt(x,y);
    }
  }
}

function processEndOfTurnUnitState(owner){
  for(const u of unitsOf(owner)){
    const s = UNIT_STATS[u.type];
    if(u.foughtThisTurn){
      u.effectiveness = Math.min(EFFECTIVENESS.length-1, u.effectiveness+1);
    } else if(!u.actedAtAll){
      const cap = EXPERIENCE_CAP[u.experience];
      u.effectiveness = Math.max(cap, u.effectiveness-1);
      const tile = map[u.y][u.x];
      const maxHp = effStat(u,'hp');
      if((tile.type===T_CITY || tile.type===T_AIRPORT) && tile.owner===owner && u.hp < maxHp){
        u.hp = maxHp;
      }
    }
    if(u.digPending==='in'){ u.dugIn = true; u.digPending = null; }
    else if(u.digPending==='out'){ u.dugIn = false; u.digPending = null; }
    u.moved = false;
    const fullMove = effStat(u,'move');
    u.movesLeft = isCrippled(u) ? Math.max(1, Math.floor(fullMove/2)) : fullMove;
    u.firedThisTurn = false;
    u.foughtThisTurn = false;
    u.actedAtAll = false;
  }
}

// Rasten/Warten-Stationsbefehle bei Rundenbeginn auswerten: bei Feindkontakt (oder für
// Rasten zusätzlich bei voller HP) wird die Einheit reaktiviert und dem Spieler zurückgegeben.
// Läuft noch ein Ingenieur-Bauauftrag (Enhanced), wird die Einheit ebenso wieder als
// "erledigt" markiert — processEndOfTurnUnitState hat moved zuvor pauschal zurückgesetzt.
function processOrderStates(owner){
  for(const u of unitsOf(owner)){
    if(u.buildOrder){ u.moved = true; u.movesLeft = 0; continue; }
    if(!u.orderState) continue;
    const enemyAdjacent = adjacentTiles(u.x,u.y).some(t => pickDefenderAt(t.x,t.y,u));
    const fullyHealed = u.orderState==='resting' && u.hp >= effStat(u,'hp');
    if(enemyAdjacent || fullyHealed){
      u.orderState = null;
      u.moved = false;
    } else {
      u.moved = true;
      u.movesLeft = 0;
    }
  }
}

// Vereinfachtes Defensivfeuer: nach dem Zug eines Spielers feuert jede ruhende,
// dazu fähige gegnerische Einheit einmal automatisch auf das nächste Ziel in Reichweite.
function processDefensiveFire(activeOwner){
  for(const defenderOwner of activeOwners()){
    if(defenderOwner === activeOwner) continue;
    const shooters = units.filter(u => u.owner===defenderOwner && u.hp>0 && !u.hostId &&
      UNIT_STATS[u.type].canDefensiveFire && !u.actedAtAll && !u.firedThisTurn);
    for(const u of shooters){
      const s = UNIT_STATS[u.type];
      let best = null, bestD = Infinity;
      for(const e of units.filter(x=>x.owner!==defenderOwner && x.owner!==OWNER_NEUTRAL && x.hp>0 && !x.hostId)){
        const d = Math.max(Math.abs(e.x-u.x), Math.abs(e.y-u.y));
        if(d<=s.range && d<bestD){ bestD=d; best=e; }
      }
      if(best){
        const res = resolveRangedAttack(u, best);
        u.firedThisTurn = true;
        if(res.destroyed || res.hitAny) MusicEngine.start();
      }
    }
  }
}

/* ---------- ZUGREIHENFOLGE ---------- */
document.getElementById('end-turn-btn').addEventListener('click', endPlayerTurn);

function endPlayerTurn(){
  if(gameOver || currentTurnOwner!==OWNER_PLAYER) return;
  deselect();
  closeBuildPanel();
  // Wegpunkt-/Patrouillenbefehle werden erst jetzt (am Rundenende) tatsächlich ausgeführt —
  // so beginnt die Bewegung noch in der Runde, in der der Befehl gegeben wurde, kann aber
  // bis zuletzt durch erneutes Anklicken der Einheit noch geändert/abgebrochen werden.
  for(const u of unitsOf(OWNER_PLAYER)) advanceWaypoint(u);
  for(const u of unitsOf(OWNER_PLAYER)) advancePatrol(u);
  if(isEnhanced()) for(const u of unitsOf(OWNER_PLAYER)) advanceConstruction(u);
  processCityProduction(OWNER_PLAYER);
  processFuel(OWNER_PLAYER);
  processDefensiveFire(OWNER_PLAYER);
  processEndOfTurnUnitState(OWNER_PLAYER);
  autoLoadAllCities();
  checkGameOver();
  if(gameOver) return;
  updateHud();
  updateInfoPanel('Der Gegner ist am Zug...');
  setTimeout(advanceTurn, 300);
}

function advanceTurn(){
  turnIndex++;
  if(turnIndex >= turnOrder.length){ turnIndex = 0; turnNumber++; }
  currentTurnOwner = turnOrder[turnIndex];
  updateDominanceState();
  refreshRadarPositions();

  if(currentTurnOwner === OWNER_PLAYER){
    processOrderStates(OWNER_PLAYER);
    updateHud();
    const next = findNextIdleUnit(null);
    if(next) selectUnit(next);
    else updateInfoPanel(`Runde ${turnNumber} — Du bist am Zug. Keine Einheiten mit offenen Befehlen.`);
    render();
    return;
  }
  if(isEliminated(currentTurnOwner)){
    setTimeout(advanceTurn, 20);
    return;
  }
  updateHud();
  updateInfoPanel(`${ownerLabel(currentTurnOwner)} ist am Zug...`);
  setTimeout(() => runAiOwnerTurn(currentTurnOwner), 350);
}

// Ein einziger Kartendurchlauf statt eines Scans pro Partei (wie es citiesOf(o) einzeln
// je Partei täte) — auf großen Karten ("Riesig", 192x124 Felder) macht das bei 5 Parteien
// den Unterschied zwischen einem und fünf vollen Grid-Scans pro Zugwechsel.
function countCitiesByOwner(){
  const counts = {}; let total = 0;
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const t = map[y][x];
      if(t.type===T_CITY && !t.ruined){
        total++;
        if(t.owner) counts[t.owner] = (counts[t.owner]||0) + 1;
      }
    }
  }
  return { counts, total };
}

function totalCapturableCities(){
  return countCitiesByOwner().total;
}

// Wertet beide Dominanz-Mechaniken in einem gemeinsamen Kartendurchlauf aus, statt die
// Städte pro Aufruf zweimal zu zählen:
// - 70%-Bündnis-Regel: kontrolliert eine Partei 70%+ aller (nicht zerstörten) Städte,
//   verbünden sich automatisch alle anderen aktiven Parteien gegen sie.
// - 80%-"Last Stand"-Regel: ab 80% Kontrolle spawnt JEDE Partei zusätzlich zur normalen
//   Produktion eine Infanterie pro Stadt und Runde (siehe processCityProduction).
// Beide sind dynamisch: werden bei jedem Rundenwechsel neu bewertet und lösen sich auf,
// sobald der Anteil (z.B. durch Rückeroberung) wieder darunter fällt.
function updateDominanceState(){
  if(!isEnhanced()){ coalitionAgainst = null; lastStandActive = false; return; }
  const { counts, total } = countCitiesByOwner();
  if(total===0){ coalitionAgainst = null; lastStandActive = false; return; }
  coalitionAgainst = activeOwners().find(o => (counts[o]||0) / total >= 0.70) || null;
  lastStandActive = activeOwners().some(o => (counts[o]||0) / total >= 0.80);
}

// Neutrale Städte haben keine eigene Partei und stehen daher nie im Bündnis.
function areAllied(a, b){
  if(!coalitionAgainst) return false;
  if(a===OWNER_NEUTRAL || b===OWNER_NEUTRAL) return false;
  if(a===coalitionAgainst || b===coalitionAgainst) return false;
  return a!==b;
}

/* ---------- KI ---------- */
function hostileTargetsFor(owner){
  const targets = [];
  for(const o of activeOwners()){
    if(o===owner || areAllied(owner,o)) continue;
    citiesOf(o).forEach(c=>targets.push({x:c.x,y:c.y}));
  }
  citiesOf(OWNER_NEUTRAL).forEach(c=>targets.push({x:c.x,y:c.y}));
  units.filter(u=>u.owner!==owner && u.owner!==OWNER_NEUTRAL && !areAllied(owner,u.owner) && u.hp>0 && !u.hostId)
    .forEach(u=>targets.push({x:u.x,y:u.y}));
  return targets;
}

function runAiOwnerTurn(owner){
  if(gameOver) return;
  processOrderStates(owner);

  const myUnits = () => unitsOf(owner).filter(u=>u.hp>0 && !u.moved);
  for(const u of myUnits()){
    if(UNIT_STATS[u.type].subclass==='sea' && u.cargo && u.cargo.length>0) aiActShipWithCargo(u);
  }
  for(const u of myUnits()){
    if(u.type==='engineer') aiActEngineer(u);
    else if(UNIT_STATS[u.type].subclass!=='sea') aiActUnit(u);
  }
  for(const u of myUnits()){
    if(UNIT_STATS[u.type].subclass==='sea') aiActShipPickup(u);
  }

  for(const u of unitsOf(owner)) advanceWaypoint(u);
  for(const u of unitsOf(owner)) advancePatrol(u);
  if(isEnhanced()){
    for(const u of unitsOf(owner)) advanceConstruction(u);
    aiConsiderCitySpecialization(owner);
  }
  processCityProduction(owner);
  processFuel(owner);
  processDefensiveFire(owner);
  processEndOfTurnUnitState(owner);
  autoLoadAllCities();
  checkGameOver();
  if(gameOver) return;
  advanceTurn();
}

function aiActUnit(unit){
  const stats = UNIT_STATS[unit.type];
  const animFromX = unit.x, animFromY = unit.y;
  let targets = hostileTargetsFor(unit.owner);
  if(targets.length===0) return;

  if(stats.subclass==='land'){
    const myLm = (landmassId[unit.y] && landmassId[unit.y][unit.x]!==undefined) ? landmassId[unit.y][unit.x] : -1;
    const sameIsland = targets.filter(t => landmassId[t.y] && landmassId[t.y][t.x]===myLm);
    if(sameIsland.length>0) targets = sameIsland;
    else { aiSeekTransport(unit, myLm); return; }
  }

  let best=null, bestDist=Infinity;
  for(const t of targets){
    const d = Math.abs(t.x-unit.x)+Math.abs(t.y-unit.y);
    if(d<bestDist){ bestDist=d; best=t; }
  }
  if(!best) return;

  if(stats.range > 0){
    let rTarget=null, rDist=Infinity;
    for(let dy=-stats.range; dy<=stats.range; dy++){
      for(let dx=-stats.range; dx<=stats.range; dx++){
        if(dx===0 && dy===0) continue;
        if(Math.max(Math.abs(dx),Math.abs(dy)) > stats.range) continue;
        const nx=unit.x+dx, ny=unit.y+dy;
        if(!inBounds(nx,ny)) continue;
        const def = pickDefenderAt(nx,ny,unit);
        if(def && def.target.owner!==unit.owner){
          const d = Math.max(Math.abs(dx),Math.abs(dy));
          if(d<rDist){ rDist=d; rTarget=def.target; }
        }
      }
    }
    if(rTarget){
      resolveRangedAttack(unit, rTarget);
      MusicEngine.start();
      unit.moved = true; unit.movesLeft = 0; unit.actedAtAll = true;
      return;
    }
  }

  const adj = adjacentTiles(unit.x,unit.y);
  for(const a of adj){
    const def = pickDefenderAt(a.x,a.y,unit);
    if(def && def.target.owner!==unit.owner){
      const res = resolveMeleeAttack(unit, def.target, def.noEntry);
      MusicEngine.start();
      if(res.winner==='attacker' && res.entered && terrainAllowed(map[a.y][a.x], unit)){
        unit.x=a.x; unit.y=a.y;
        const t=map[a.y][a.x];
        if(((t.type===T_CITY && !t.ruined) || t.type===T_AIRPORT || t.type===T_RADAR) && t.owner!==unit.owner && stats.subclass==='land'){
          if(t.type===T_CITY) captureCity(a.x,a.y,unit.owner,unit); else t.owner = unit.owner;
        }
      }
      unit.moved = true; unit.movesLeft = 0;
      queueMoveAnim(unit, animFromX, animFromY);
      return;
    }
    const tile = map[a.y][a.x];
    if(unitsAt(a.x,a.y).length===0 && (tile.type===T_CITY || tile.type===T_AIRPORT || tile.type===T_RADAR) && tile.owner!==unit.owner && stats.subclass==='land'){
      const survived = tryCaptureStructure(unit, a.x, a.y);
      if(survived){ unit.x=a.x; unit.y=a.y; }
      if(units.includes(unit)){ unit.moved = true; unit.movesLeft = 0; queueMoveAnim(unit, animFromX, animFromY); }
      return;
    }
  }

  const path = computePathTowards(unit, best);
  if(!path || path.length===0) return;
  let remaining = unit.movesLeft;
  for(let i=0;i<path.length;i++){
    const step = path[i];
    const isLast = i===path.length-1;
    const def = isLast ? pickDefenderAt(step.x, step.y, unit) : null;
    if(def){
      if(def.target.owner!==unit.owner){
        const res = resolveMeleeAttack(unit, def.target, def.noEntry);
        MusicEngine.start();
        if(res.winner==='attacker' && res.entered && terrainAllowed(map[step.y][step.x], unit)){
          unit.x=step.x; unit.y=step.y;
          const t=map[step.y][step.x];
          if(((t.type===T_CITY && !t.ruined) || t.type===T_AIRPORT || t.type===T_RADAR) && t.owner!==unit.owner && stats.subclass==='land'){
            if(t.type===T_CITY) captureCity(step.x, step.y, unit.owner, unit); else t.owner = unit.owner;
          }
        }
      }
      unit.moved = true; unit.movesLeft = 0;
      queueMoveAnim(unit, animFromX, animFromY);
      return;
    }
    const cost = terrainCost(map[step.y][step.x], unit);
    if(cost > remaining) break;
    remaining -= cost;
    unit.x = step.x; unit.y = step.y;
    refuelIfOnOwnCity(unit);
    const t = map[step.y][step.x];
    if((t.type===T_CITY || t.type===T_AIRPORT || t.type===T_RADAR) && t.owner!==unit.owner && stats.subclass==='land'){
      if(!tryCaptureStructure(unit, step.x, step.y)){ queueMoveAnim(unit, animFromX, animFromY); return; }
    }
  }
  unit.movesLeft = remaining;
  unit.moved = remaining<=0;
  unit.actedAtAll = true;
  queueMoveAnim(unit, animFromX, animFromY);
}

/* ---------- ENHANCED: KI-INGENIEUR ---------- */
function ownerHasRadar(owner){
  return radarPositions.some(r => r.owner===owner);
}

// Bewegt den Ingenieur (ohne Kampf) so weit wie möglich in Richtung target und beendet
// damit seine Runde — Ingenieure handeln wie andere KI-Einheiten nur einmal pro Zug.
function aiEngineerMoveTowards(unit, target){
  const animFromX = unit.x, animFromY = unit.y;
  const path = computePathTowards(unit, target);
  if(path && path.length>0){
    let remaining = unit.movesLeft;
    for(const step of path){
      if(pickDefenderAt(step.x, step.y, unit)) break;
      const cost = terrainCost(map[step.y][step.x], unit);
      if(cost > remaining) break;
      remaining -= cost;
      unit.x = step.x; unit.y = step.y;
    }
    unit.movesLeft = remaining;
    queueMoveAnim(unit, animFromX, animFromY);
  }
  unit.moved = true;
}

// Einfache, aber echte Nutzung aller Enhanced-Baumöglichkeiten: Ruinen zuerst
// wiederaufbauen, dann bei Nebel des Krieges für ein Radar bei der Hauptstadt sorgen,
// gelegentlich Festungen auf brauchbarem Gelände errichten und ansonsten das eigene
// Städtenetz per Straße (oder testweise Eisenbahn) verbinden.
function aiActEngineer(unit){
  const owner = unit.owner;
  const tile = map[unit.y][unit.x];

  if(tile.type===T_CITY && tile.ruined){
    startEngineerBuild(unit, 'rebuild', 15);
    return;
  }

  if(fogEnabled && !ownerHasRadar(owner)){
    const capital = citiesOf(owner).find(c=>map[c.y][c.x].capital) || citiesOf(owner)[0];
    if(capital){
      if(Math.abs(unit.x-capital.x)+Math.abs(unit.y-capital.y)<=2 && [T_PLAIN,T_FOREST,T_HILLS,T_MOUNTAIN].includes(tile.type)){
        startEngineerBuild(unit, 'radar', 5);
        return;
      }
      aiEngineerMoveTowards(unit, capital);
      return;
    }
  }

  if([T_PLAIN,T_FOREST,T_HILLS,T_MOUNTAIN].includes(tile.type) && !tile.fortress && Math.random()<0.35){
    startEngineerBuild(unit, 'fortress', 5);
    return;
  }

  const myCities = citiesOf(owner);
  let nearest=null, bestD=Infinity;
  for(const c of myCities){
    if(c.x===unit.x && c.y===unit.y) continue;
    const d = Math.abs(c.x-unit.x)+Math.abs(c.y-unit.y);
    if(d<bestD){ bestD=d; nearest=c; }
  }
  if(nearest){
    const path = computePathTowards(unit, nearest);
    if(path && path.length>0 && path.length<40){
      const needsWork = path.some(p => !map[p.y][p.x].road && ![T_CITY,T_AIRPORT,T_RADAR].includes(map[p.y][p.x].type));
      const kind = needsWork ? 'road' : (Math.random()<0.2 ? 'rail' : null);
      if(kind){
        const fullPath = [{x:unit.x,y:unit.y}, ...path];
        const firstTile = map[fullPath[0].y][fullPath[0].x];
        unit.buildOrder = { type:kind, path: fullPath.slice(1), turnsLeft: engineerTileCost(kind, firstTile.type, firstTile.road) };
        unit.moved = true;
        return;
      }
    }
  }

  unit.moved = true;
}

// Landeinheit ohne erreichbares Ziel auf der eigenen Landmasse: zur Küste marschieren
// und bei einem angrenzenden freundlichen Schiff mit Platz einsteigen.
function aiSeekTransport(unit, myLm){
  if(unit.hostId) return;
  for(const a of adjacentTiles(unit.x,unit.y)){
    const host = units.find(o=>o.x===a.x && o.y===a.y && o.hp>0 && !o.hostId && o.owner===unit.owner &&
      UNIT_STATS[o.type].canCarry && UNIT_STATS[o.type].canCarry.includes(unit.type));
    if(host && host.cargo.length < UNIT_STATS[host.type].portageCapacity){
      unit.hostId = host.id;
      unit.orderState = null;
      host.cargo.push(unit.id);
      unit.moved = true; unit.movesLeft = 0; unit.actedAtAll = true;
      return;
    }
  }
  let bestCoast=null, bestDist=Infinity;
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      if(landmassId[y][x]!==myLm || !isCoastal(x,y)) continue;
      const d = Math.abs(x-unit.x)+Math.abs(y-unit.y);
      if(d<bestDist){ bestDist=d; bestCoast={x,y}; }
    }
  }
  if(!bestCoast){ unit.moved=true; unit.movesLeft=0; return; }
  const path = computePathTowards(unit, bestCoast);
  if(!path || path.length===0){ unit.moved=true; unit.movesLeft=0; return; }
  let remaining = unit.movesLeft;
  for(const step of path){
    const cost = terrainCost(map[step.y][step.x], unit);
    if(cost>remaining) break;
    remaining -= cost;
    unit.x=step.x; unit.y=step.y;
  }
  unit.movesLeft = remaining;
  unit.moved = true;
  unit.actedAtAll = true;
}

// Schiff MIT Fracht: zur nächsten Wasserkachel neben feindlichem/neutralem Territorium
// segeln und dort die erste Frachteinheit anlanden.
function aiActShipWithCargo(ship){
  const cargoOwner = ship.owner;
  let best=null, bestDist=Infinity;
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      if(map[y][x].type!==T_WATER) continue;
      const landAdj = DIRS4.map(([dx,dy])=>({x:x+dx,y:y+dy})).filter(p=>inBounds(p.x,p.y) && map[p.y][p.x].type!==T_WATER);
      if(landAdj.length===0) continue;
      const hasTarget = landAdj.some(p => {
        const lm = landmassId[p.y][p.x];
        if(lm<0) return false;
        if(map[p.y][p.x].type===T_CITY && map[p.y][p.x].owner!==cargoOwner) return true;
        return citiesOf(OWNER_NEUTRAL).some(c=>landmassId[c.y][c.x]===lm) ||
          activeOwners().some(o=>o!==cargoOwner && citiesOf(o).some(c=>landmassId[c.y][c.x]===lm)) ||
          units.some(u=>u.owner!==cargoOwner && u.owner!==OWNER_NEUTRAL && u.hp>0 && landmassId[u.y] && landmassId[u.y][u.x]===lm);
      });
      if(!hasTarget) continue;
      const d = Math.abs(x-ship.x)+Math.abs(y-ship.y);
      if(d<bestDist){ bestDist=d; best={x,y}; }
    }
  }
  if(!best){ ship.moved=true; ship.movesLeft=0; return; }

  const path = computePathTowards(ship, best);
  if(!path || path.length===0){ ship.moved=true; ship.movesLeft=0; return; }
  let remaining = ship.movesLeft;
  for(const step of path){
    const cost = terrainCost(map[step.y][step.x], ship);
    if(cost>remaining) break;
    remaining -= cost;
    ship.x=step.x; ship.y=step.y;
  }
  ship.movesLeft = remaining;
  ship.moved = true;
  ship.actedAtAll = true;

  if(ship.cargo.length>0){
    const cargoUnit = units.find(u=>u.id===ship.cargo[0]);
    if(cargoUnit){
      const landSpot = adjacentTiles(ship.x,ship.y).find(a =>
        map[a.y][a.x].type!==T_WATER && terrainAllowed(map[a.y][a.x], cargoUnit) && unitsAt(a.x,a.y).length===0);
      if(landSpot){
        cargoUnit.x=landSpot.x; cargoUnit.y=landSpot.y; cargoUnit.hostId=null;
        cargoUnit.orderState=null;
        cargoUnit.moved=true; cargoUnit.movesLeft=0; cargoUnit.actedAtAll=true;
        ship.cargo = ship.cargo.filter(id=>id!==cargoUnit.id);
      }
    }
  }
}

// Leeres Transportfähiges Schiff: eigene gestrandete Einheit an der Küste abholen,
// sonst normal wie eine Kampfeinheit agieren.
function aiActShipPickup(ship){
  const s = UNIT_STATS[ship.type];
  if(!s.canCarry || ship.cargo.length >= s.portageCapacity){ aiActUnit(ship); return; }

  const stranded = unitsOf(ship.owner).filter(u => {
    if(u.hostId) return false;
    if(!s.canCarry.includes(u.type)) return false;
    return isCoastal(u.x,u.y);
  });
  if(stranded.length===0){ aiActUnit(ship); return; }

  let best=null, bestDist=Infinity;
  for(const u of stranded){
    const d = Math.abs(u.x-ship.x)+Math.abs(u.y-ship.y);
    if(d<bestDist){ bestDist=d; best=u; }
  }
  if(Math.max(Math.abs(best.x-ship.x), Math.abs(best.y-ship.y)) <= 1){
    best.hostId = ship.id; best.orderState = null; ship.cargo.push(best.id);
    best.moved=true; best.movesLeft=0; best.actedAtAll=true;
    ship.moved=true; ship.movesLeft=0; ship.actedAtAll=true;
    return;
  }
  const waterSpots = adjacentTiles(best.x,best.y).filter(t=>map[t.y][t.x].type===T_WATER);
  if(waterSpots.length===0){ ship.moved=true; ship.movesLeft=0; return; }
  let target=null, tDist=Infinity;
  for(const w of waterSpots){
    const d = Math.abs(w.x-ship.x)+Math.abs(w.y-ship.y);
    if(d<tDist){ tDist=d; target=w; }
  }
  const path = computePathTowards(ship, target);
  if(!path || path.length===0){ ship.moved=true; ship.movesLeft=0; return; }
  let remaining = ship.movesLeft;
  for(const step of path){
    const cost = terrainCost(map[step.y][step.x], ship);
    if(cost>remaining) break;
    remaining -= cost;
    ship.x=step.x; ship.y=step.y;
  }
  ship.movesLeft = remaining;
  ship.moved = true;
  ship.actedAtAll = true;

  if(Math.max(Math.abs(best.x-ship.x), Math.abs(best.y-ship.y)) <= 1 && !best.hostId){
    best.hostId = ship.id; best.orderState = null; ship.cargo.push(best.id);
    best.moved=true; best.movesLeft=0; best.actedAtAll=true;
  }
}

/* ---------- SIEG / NIEDERLAGE ---------- */
function checkGameOver(){
  if(isEliminated(OWNER_PLAYER)){
    endGame(false, 'Deine Armee wurde vollständig aufgerieben.');
    return;
  }
  if(aiOwners.length>0 && aiOwners.every(o => isEliminated(o))){
    endGame(true, 'Du hast alle gegnerischen Streitkräfte vernichtet!');
  }
}

function endGame(won, text){
  gameOver = true;
  const overlay = document.getElementById('game-over');
  overlay.classList.toggle('outcome-win', won);
  overlay.classList.toggle('outcome-lose', !won);
  document.getElementById('go-text').textContent = text;
  overlay.classList.remove('hidden');
}

/* ---------- HUD ---------- */
function updateHud(){
  document.getElementById('turn-indicator').textContent =
    `Runde ${turnNumber} — ${currentTurnOwner===OWNER_PLAYER ? 'Dein Zug' : ownerLabel(currentTurnOwner)+' zieht...'}`;
  const ownerPanel = document.getElementById('owner-panel');
  ownerPanel.innerHTML = '';
  if(coalitionAgainst){
    const banner = document.createElement('div');
    banner.className = 'coalition-banner';
    banner.textContent = `⚔ Bündnis gegen ${coalitionAgainst===OWNER_PLAYER ? 'dich' : ownerLabel(coalitionAgainst)}`;
    ownerPanel.appendChild(banner);
  }
  if(lastStandActive){
    const banner = document.createElement('div');
    banner.className = 'coalition-banner laststand-banner';
    banner.textContent = '🪖 Last Stand — alle Städte bauen zusätzlich Infanterie';
    ownerPanel.appendChild(banner);
  }
  for(const o of activeOwners()){
    const row = document.createElement('div');
    row.className = 'owner-row' + (isEliminated(o) ? ' owner-dead' : '') + (o===coalitionAgainst ? ' owner-dominant' : '');
    row.innerHTML = `<span class="owner-name" style="color:${OWNER_COLORS[o]}">${ownerLabel(o)}</span>` +
      `<span class="owner-stat">🏙 ${citiesOf(o).length}</span>` +
      `<span class="owner-stat">⚔ ${allUnitsOf(o).length}</span>`;
    ownerPanel.appendChild(row);
  }
  const pendingCount = unitsOf(OWNER_PLAYER).filter(isUnitPending).length;
  const counterEl = document.getElementById('units-to-move-counter');
  counterEl.textContent = `🎯 ${pendingCount}`;
  counterEl.classList.toggle('hidden', pendingCount===0);
  const allMovedEl = document.getElementById('all-moved-indicator');
  allMovedEl.classList.toggle('hidden', pendingCount!==0);
}
function updateInfoPanel(text){
  document.getElementById('info-panel').textContent = text;
}

/* ---------- RENDERING ---------- */
const TILE_COLORS = {
  [T_PLAIN]: '#274a2e',
  [T_FOREST]: '#1c3a1e',
  [T_HILLS]: '#3a3a28',
  [T_MOUNTAIN]: '#4a4a52',
  [T_WATER]: '#163a52'
};
const EFF_COLORS = { fresh:'#5ad65a', rested:'#5ad65a', ready:'#5ad65a', used:'#e0c04a', tired:'#e0c04a', exhausted:'#e0473f' };

// Nebel des Krieges: einfache radiusbasierte Sicht (kein Line-of-Sight, keine
// Geländeverdeckung) nur für die Spieler-Ansicht. Einmal erkundete Felder bleiben als
// Terrain sichtbar (nur abgedunkelt), unerkundete Felder bleiben schwarz.
let visibleSet = new Set();
let exploredSet = new Set();

function recomputeVisibility(){
  if(!fogEnabled) return;
  visibleSet = new Set();
  const exploredBefore = exploredSet.size;
  const sources = [];
  for(const u of unitsOf(OWNER_PLAYER)) sources.push({x:u.x, y:u.y, range: UNIT_STATS[u.type].category==='air' ? SIGHT_RANGE.air : SIGHT_RANGE.ground});
  for(const c of citiesOf(OWNER_PLAYER)) sources.push({x:c.x, y:c.y, range: SIGHT_RANGE.ground});
  for(const src of sources){
    const r = src.range;
    for(let dy=-r; dy<=r; dy++){
      for(let dx=-r; dx<=r; dx++){
        if(dx*dx+dy*dy > r*r+1) continue;
        const nx=src.x+dx, ny=src.y+dy;
        if(!inBounds(nx,ny)) continue;
        const k = key(nx,ny);
        visibleSet.add(k);
        exploredSet.add(k);
      }
    }
  }
  // Die Minimap-Terrainkachel ist ein Cache über die ganze Karte (siehe
  // buildMinimapTerrainCache) — bei neu entdeckten Kacheln muss er einmal neu aufgebaut
  // werden, damit die Minimap den Nebel des Krieges respektiert statt alles sofort zu zeigen.
  if(exploredSet.size !== exploredBefore) minimapTerrainCanvas = null;
}

function render(){
  if(map.length === 0) return;
  gctx.clearRect(0,0,gameCanvas.width, gameCanvas.height);
  if(fogEnabled) recomputeVisibility();

  const renderNow = performance.now();
  const tsz = BASE_TILE * camera.zoom;
  const startX = Math.max(0, Math.floor(camera.x / BASE_TILE) - 1);
  const startY = Math.max(0, Math.floor(camera.y / BASE_TILE) - 1);
  const endX = Math.min(COLS, Math.ceil((camera.x + gameCanvas.width/camera.zoom) / BASE_TILE) + 1);
  const endY = Math.min(ROWS, Math.ceil((camera.y + gameCanvas.height/camera.zoom) / BASE_TILE) + 1);

  for(let y=startY;y<endY;y++){
    for(let x=startX;x<endX;x++){
      const tile = map[y][x];
      const scr = worldToScreen(x*BASE_TILE, y*BASE_TILE);
      const px = scr.x, py = scr.y;

      if(fogEnabled && !exploredSet.has(key(x,y))){
        gctx.fillStyle = '#05070a';
        gctx.fillRect(px,py,tsz,tsz);
        continue;
      }
      gctx.save();
      if(fogEnabled && !visibleSet.has(key(x,y))) gctx.globalAlpha = 0.45;

      const isStructureTile = tile.type===T_CITY || tile.type===T_AIRPORT || tile.type===T_RADAR;
      const terrainSprite = terrainSpriteReady(tile.type) ? terrainSpriteImages[tile.type]
        : (isStructureTile && terrainSpriteReady(T_PLAIN)) ? terrainSpriteImages[T_PLAIN] : null;
      if(terrainSprite){
        // Stadt/Flughafen/Radar-Kacheln merken sich ihr ursprüngliches Terrain nicht — im
        // Grafikmodus zeigen wir stattdessen eine neutrale Wiese darunter, damit die
        // Gebäude-Sprites (die echte Transparenz um ihre runde Basis haben) organisch auf
        // Landschaft wirken statt auf einer dunklen UI-Box zu stehen.
        gctx.drawImage(terrainSprite, px, py, tsz, tsz);
      } else {
        gctx.fillStyle = isStructureTile ? '#1b2436' : TILE_COLORS[tile.type];
        gctx.fillRect(px,py,tsz,tsz);
      }
      gctx.strokeStyle = 'rgba(0,0,0,0.25)';
      gctx.strokeRect(px,py,tsz,tsz);

      if(tile.type===T_WATER && graphicsEnabled()) drawWaterShimmer(px, py, tsz, x, y, renderNow);

      if(tile.road && tile.type!==T_CITY && tile.type!==T_AIRPORT && tile.type!==T_RADAR){
        const roadDirs = connectedDirs(x,y,'road');
        const rcx = px+tsz/2, rcy = py+tsz/2;
        gctx.strokeStyle = 'rgba(224,184,74,0.55)';
        gctx.lineWidth = Math.max(1, tsz*0.08);
        if(roadDirs.length===0){
          gctx.beginPath();
          gctx.moveTo(px+tsz*0.1, rcy);
          gctx.lineTo(px+tsz*0.9, rcy);
          gctx.stroke();
        } else {
          for(const d of roadDirs){
            gctx.beginPath();
            gctx.moveTo(rcx, rcy);
            gctx.lineTo(rcx + d.dx*tsz/2, rcy + d.dy*tsz/2);
            gctx.stroke();
          }
        }
      }
      // Enhanced: Eisenbahn — zwei parallele Linien mit Schwellen statt der einfachen
      // Straßenlinie, damit sie sich klar vom Straßenbau unterscheidet. Segmente folgen
      // wie bei der Straße den tatsächlich verbundenen Nachbarn (siehe connectedDirs).
      if(tile.rail && tile.type!==T_CITY && tile.type!==T_AIRPORT && tile.type!==T_RADAR){
        const railDirs = connectedDirs(x,y,'rail');
        const rcx = px+tsz/2, rcy = py+tsz/2;
        gctx.strokeStyle = 'rgba(200,200,210,0.8)';
        gctx.lineWidth = Math.max(1, tsz*0.035);
        if(railDirs.length===0){
          gctx.beginPath();
          gctx.moveTo(px+tsz*0.08, py+tsz*0.42); gctx.lineTo(px+tsz*0.92, py+tsz*0.42);
          gctx.moveTo(px+tsz*0.08, py+tsz*0.58); gctx.lineTo(px+tsz*0.92, py+tsz*0.58);
          gctx.stroke();
          for(let tck=0.15; tck<1; tck+=0.18){
            gctx.beginPath();
            gctx.moveTo(px+tsz*tck, py+tsz*0.38); gctx.lineTo(px+tsz*tck, py+tsz*0.62);
            gctx.stroke();
          }
        } else {
          for(const d of railDirs){
            const steps = 2;
            if(d.dx!==0){
              const y1 = py+tsz*0.42, y2 = py+tsz*0.58;
              const xEnd = rcx + d.dx*tsz/2;
              gctx.beginPath(); gctx.moveTo(rcx,y1); gctx.lineTo(xEnd,y1); gctx.stroke();
              gctx.beginPath(); gctx.moveTo(rcx,y2); gctx.lineTo(xEnd,y2); gctx.stroke();
              for(let s=1;s<=steps;s++){
                const tX = rcx + d.dx*(tsz/2)*(s/(steps+1));
                gctx.beginPath(); gctx.moveTo(tX,y1-tsz*0.04); gctx.lineTo(tX,y2+tsz*0.04); gctx.stroke();
              }
            } else {
              const x1 = px+tsz*0.42, x2 = px+tsz*0.58;
              const yEnd = rcy + d.dy*tsz/2;
              gctx.beginPath(); gctx.moveTo(x1,rcy); gctx.lineTo(x1,yEnd); gctx.stroke();
              gctx.beginPath(); gctx.moveTo(x2,rcy); gctx.lineTo(x2,yEnd); gctx.stroke();
              for(let s=1;s<=steps;s++){
                const tY = rcy + d.dy*(tsz/2)*(s/(steps+1));
                gctx.beginPath(); gctx.moveTo(x1-tsz*0.04,tY); gctx.lineTo(x2+tsz*0.04,tY); gctx.stroke();
              }
            }
          }
        }
      }
      // Enhanced: Festung — wird über dem bestehenden Terrain gezeichnet, ersetzt es nicht
      // (die Sprite-Variante hat echte Transparenz um ihre runde Basis, genau wie Einheiten).
      if(tile.fortress){
        if(fortressSpriteReady()){
          gctx.drawImage(fortressSpriteImage, px, py, tsz, tsz);
        } else {
          gctx.strokeStyle = '#e0b84a';
          gctx.lineWidth = Math.max(1.5, tsz*0.05);
          const fp = tsz*0.12;
          gctx.strokeRect(px+fp, py+fp, tsz-2*fp, tsz-2*fp);
        }
      }

      if(!terrainSprite && tile.type===T_MOUNTAIN){
        gctx.fillStyle = '#6b6b76';
        gctx.beginPath();
        gctx.moveTo(px+tsz*0.5, py+tsz*0.18);
        gctx.lineTo(px+tsz*0.85, py+tsz*0.82);
        gctx.lineTo(px+tsz*0.15, py+tsz*0.82);
        gctx.closePath();
        gctx.fill();
      } else if(!terrainSprite && tile.type===T_FOREST){
        gctx.fillStyle = '#3f6b3f';
        gctx.beginPath(); gctx.arc(px+tsz*0.35, py+tsz*0.55, tsz*0.16, 0, Math.PI*2); gctx.fill();
        gctx.beginPath(); gctx.arc(px+tsz*0.62, py+tsz*0.4, tsz*0.16, 0, Math.PI*2); gctx.fill();
        gctx.beginPath(); gctx.arc(px+tsz*0.55, py+tsz*0.68, tsz*0.16, 0, Math.PI*2); gctx.fill();
      } else if(!terrainSprite && tile.type===T_HILLS){
        gctx.fillStyle = '#5a5a3e';
        gctx.beginPath(); gctx.arc(px+tsz*0.4, py+tsz*0.62, tsz*0.22, Math.PI, 0); gctx.fill();
        gctx.beginPath(); gctx.arc(px+tsz*0.68, py+tsz*0.62, tsz*0.18, Math.PI, 0); gctx.fill();
      }

      if(tile.type===T_CITY && tile.ruined){
        // Verbrannte Erde (Enhanced): schwarz-graue Trümmer statt Besitzerfarbe — signalisiert
        // klar "niemandes Stadt mehr", nur ein Ingenieur kann sie wiederaufbauen.
        if(ruinSpriteReady()){
          gctx.drawImage(ruinSpriteImage, px, py, tsz, tsz);
        } else {
          gctx.fillStyle = '#2a241f';
          const pad = tsz*0.2;
          gctx.fillRect(px+pad, py+pad*0.6, tsz-2*pad, tsz-2*pad*0.6);
          gctx.fillStyle = '#8a6a4a';
          gctx.font = `${Math.floor(tsz*0.4)}px monospace`;
          gctx.textAlign = 'center';
          gctx.textBaseline = 'middle';
          gctx.fillText('▲', px+tsz/2, py+tsz/2+2);
        }
      } else if(tile.type===T_CITY){
        // Enhanced: eine spezialisierte Stadt zeigt ihr Fachgebiet (Rüstung/Flugwerft/Hafen)
        // statt der generischen Stadtgrafik; eine Hauptstadt hat Vorrang, da es dafür kein
        // eigenes "spezialisierte Hauptstadt"-Motiv gibt.
        const citySpriteType = tile.capital ? 'capital' : (tile.specialization || 'city');
        if(citySpriteReady(citySpriteType)){
          gctx.drawImage(getTintedCitySprite(citySpriteType, tile.owner), px, py, tsz, tsz);
        } else {
          const color = OWNER_COLORS[tile.owner] || OWNER_COLORS[OWNER_NEUTRAL];
          gctx.fillStyle = color;
          const pad = tsz*0.2;
          gctx.fillRect(px+pad, py+pad*0.6, tsz-2*pad, tsz-2*pad*0.6);
          gctx.fillStyle = '#0a0e14';
          gctx.font = `${Math.floor(tsz*0.4)}px monospace`;
          gctx.textAlign = 'center';
          gctx.textBaseline = 'middle';
          gctx.fillText(tile.capital ? '★' : '●', px+tsz/2, py+tsz/2+2);
        }

        if(tile.owner===OWNER_PLAYER){
          const hs = tsz*0.4;
          gctx.fillStyle = 'rgba(10,14,20,0.65)';
          gctx.fillRect(px+tsz-hs, py, hs, hs);
          gctx.fillStyle = '#e0b84a';
          gctx.font = `${Math.floor(hs*0.7)}px monospace`;
          gctx.fillText('⚙', px+tsz-hs/2, py+hs/2+1);
        }
      } else if(tile.type===T_AIRPORT){
        const color = tile.owner ? (OWNER_COLORS[tile.owner] || OWNER_COLORS[OWNER_NEUTRAL]) : '#5a6478';
        gctx.strokeStyle = color;
        gctx.lineWidth = Math.max(2, tsz*0.06);
        const pad = tsz*0.22;
        gctx.strokeRect(px+pad, py+pad*0.7, tsz-2*pad, tsz-2*pad*0.7);
        gctx.fillStyle = color;
        gctx.font = `${Math.floor(tsz*0.4)}px sans-serif`;
        gctx.textAlign = 'center';
        gctx.textBaseline = 'middle';
        gctx.fillText('✈', px+tsz/2, py+tsz/2+1);
      } else if(tile.type===T_RADAR){
        if(radarSpriteReady()){
          gctx.drawImage(getTintedRadarSprite(tile.owner), px, py, tsz, tsz);
        } else {
          const color = tile.owner ? (OWNER_COLORS[tile.owner] || OWNER_COLORS[OWNER_NEUTRAL]) : '#5a6478';
          gctx.strokeStyle = color;
          gctx.lineWidth = Math.max(2, tsz*0.06);
          gctx.beginPath();
          gctx.arc(px+tsz*0.5, py+tsz*0.62, tsz*0.28, Math.PI, 0);
          gctx.stroke();
          gctx.beginPath();
          gctx.moveTo(px+tsz*0.5, py+tsz*0.62); gctx.lineTo(px+tsz*0.72, py+tsz*0.22);
          gctx.stroke();
        }
      }
      gctx.restore();
    }
  }

  for(const t of reachableTiles){
    const scr = worldToScreen(t.x*BASE_TILE, t.y*BASE_TILE);
    gctx.fillStyle = 'rgba(63,169,245,0.35)';
    gctx.fillRect(scr.x, scr.y, tsz, tsz);
  }
  // Reichweiten-Umriss: zeigt alle Felder innerhalb der Fernkampf-Reichweite, auch ohne
  // Ziel dort — damit man intuitiv sieht, wie nah man an ein Ziel heran muss.
  for(const t of rangeRadiusTiles){
    const scr = worldToScreen(t.x*BASE_TILE, t.y*BASE_TILE);
    gctx.strokeStyle = 'rgba(224,150,50,0.55)';
    gctx.lineWidth = Math.max(1, tsz*0.04);
    gctx.strokeRect(scr.x+1, scr.y+1, tsz-2, tsz-2);
  }
  for(const t of rangedTiles){
    const scr = worldToScreen(t.x*BASE_TILE, t.y*BASE_TILE);
    gctx.fillStyle = 'rgba(224,150,50,0.4)';
    gctx.fillRect(scr.x, scr.y, tsz, tsz);
  }
  for(const t of attackableTiles){
    const scr = worldToScreen(t.x*BASE_TILE, t.y*BASE_TILE);
    gctx.fillStyle = 'rgba(245,71,63,0.4)';
    gctx.fillRect(scr.x, scr.y, tsz, tsz);
  }
  for(const t of unloadTiles){
    const scr = worldToScreen(t.x*BASE_TILE, t.y*BASE_TILE);
    gctx.fillStyle = 'rgba(160,120,240,0.4)';
    gctx.fillRect(scr.x, scr.y, tsz, tsz);
  }

  for(const c of citiesOf(OWNER_PLAYER)){
    const rp = map[c.y][c.x].rallyPoint;
    if(!rp) continue;
    const to = worldToScreen(rp.x*BASE_TILE+BASE_TILE/2, rp.y*BASE_TILE+BASE_TILE/2);
    if(selectedBuildCity && selectedBuildCity.x===c.x && selectedBuildCity.y===c.y){
      const from = worldToScreen(c.x*BASE_TILE+BASE_TILE/2, c.y*BASE_TILE+BASE_TILE/2);
      gctx.strokeStyle = 'rgba(160,120,240,0.7)';
      gctx.lineWidth = 2;
      gctx.setLineDash([5,4]);
      gctx.beginPath(); gctx.moveTo(from.x, from.y); gctx.lineTo(to.x, to.y); gctx.stroke();
      gctx.setLineDash([]);
    }
    gctx.font = `${Math.floor(tsz*0.5)}px sans-serif`;
    gctx.textAlign = 'center'; gctx.textBaseline = 'middle';
    gctx.fillText('🚩', to.x, to.y);
  }

  if(selectedUnit && selectedUnit.destination){
    const from = worldToScreen(selectedUnit.x*BASE_TILE+BASE_TILE/2, selectedUnit.y*BASE_TILE+BASE_TILE/2);
    const to = worldToScreen(selectedUnit.destination.x*BASE_TILE+BASE_TILE/2, selectedUnit.destination.y*BASE_TILE+BASE_TILE/2);
    gctx.strokeStyle = 'rgba(224,184,74,0.8)';
    gctx.lineWidth = 2;
    gctx.setLineDash([6,4]);
    gctx.beginPath(); gctx.moveTo(from.x, from.y); gctx.lineTo(to.x, to.y); gctx.stroke();
    gctx.setLineDash([]);
    gctx.fillStyle = '#e0b84a';
    gctx.beginPath(); gctx.arc(to.x, to.y, 6, 0, Math.PI*2); gctx.fill();
  }
  if(unitDragMode && dragPreviewTarget && selectedUnit){
    const from = worldToScreen(selectedUnit.x*BASE_TILE+BASE_TILE/2, selectedUnit.y*BASE_TILE+BASE_TILE/2);
    const to = worldToScreen(dragPreviewTarget.x*BASE_TILE+BASE_TILE/2, dragPreviewTarget.y*BASE_TILE+BASE_TILE/2);
    gctx.strokeStyle = 'rgba(63,169,245,0.8)';
    gctx.lineWidth = 2;
    gctx.setLineDash([4,3]);
    gctx.beginPath(); gctx.moveTo(from.x, from.y); gctx.lineTo(to.x, to.y); gctx.stroke();
    gctx.setLineDash([]);
  }

  if(graphicsEnabled()) drawDustParticles(renderNow);

  // Städte/Flughäfen können beliebig viele Boden-/See-Einheiten garnisonieren — dort wird
  // nur eine Einheit stellvertretend gezeichnet (die ausgewählte, falls dabei) plus ein
  // kleines Zahlen-Badge mit der Stapelgröße.
  const groundStacks = new Map();
  for(const u of units){
    if(u.hp<=0 || u.hostId) continue;
    if(u.x<startX-1 || u.x>endX+1 || u.y<startY-1 || u.y>endY+1) continue;
    if(fogEnabled && u.owner!==OWNER_PLAYER && !visibleSet.has(key(u.x,u.y))) continue;
    const tile = map[u.y] && map[u.y][u.x];
    const stackable = tile && (tile.type===T_CITY || tile.type===T_AIRPORT) && getLevel(u)==='ground';
    if(stackable){
      const k = key(u.x,u.y);
      if(!groundStacks.has(k)) groundStacks.set(k, []);
      groundStacks.get(k).push(u);
    } else {
      drawUnit(u, tsz);
    }
  }
  for(const stack of groundStacks.values()){
    stack.sort((a,b)=>a.id-b.id);
    const rep = stack.includes(selectedUnit) ? selectedUnit : stack[0];
    drawUnit(rep, tsz);
    if(stack.length>1){
      const scr = worldToScreen(rep.x*BASE_TILE, rep.y*BASE_TILE);
      const bx = scr.x+tsz*0.86, by = scr.y+tsz*0.86, br = tsz*0.17;
      gctx.fillStyle = '#e0b84a';
      gctx.beginPath();
      gctx.arc(bx, by, br, 0, Math.PI*2);
      gctx.fill();
      gctx.strokeStyle = '#0a0e14';
      gctx.lineWidth = 1;
      gctx.stroke();
      gctx.fillStyle = '#0a0e14';
      gctx.font = `bold ${Math.floor(br*1.3)}px monospace`;
      gctx.textAlign = 'center';
      gctx.textBaseline = 'middle';
      gctx.fillText(String(stack.length), bx, by+1);
    }
  }

  // Kampf-Geister: die eigentliche Kampfauflösung (inkl. Entfernen der verlierenden
  // Einheit) ist zu diesem Zeitpunkt längst passiert — ohne diesen Zusatz wäre die
  // unterlegene Einheit schon vor Ende der Blink-Sequenz spurlos verschwunden und der
  // Ausgang stünde optisch vorzeitig fest. Für jeden Kampfteilnehmer, der nicht mehr
  // (unverändert) unter den lebenden Einheiten existiert, wird daher anhand des Snapshots
  // ein Platzhalter an der ursprünglichen Kampfposition gezeichnet, bis die Sequenz endet.
  if(combatFx){
    for(const snap of [combatFx.a, combatFx.d]){
      const stillAlive = units.some(o => o.id===snap.id && o.hp>0);
      if(!stillAlive) drawGhostUnit(snap, tsz);
    }
  }

  // Kampf-Blinken: pulsierender Rahmen um beide Kampfteilnehmer (Spieleraktionen, siehe
  // playCombatSequence) — bewusst als reiner Rahmen statt Geister-Sprite für die Position,
  // damit es auch funktioniert, wenn sich Angreifer/Verteidiger-Position durch den Kampf
  // ändert (siehe drawGhostUnit oben für die verschwundene Einheit selbst).
  if(combatFx && combatFx.blinkOn){
    for(const snap of [combatFx.a, combatFx.d]){
      const scr = worldToScreen(snap.x*BASE_TILE, snap.y*BASE_TILE);
      gctx.save();
      gctx.strokeStyle = '#ff3b3b';
      gctx.lineWidth = Math.max(3, tsz*0.12);
      gctx.shadowColor = '#ff3b3b';
      gctx.shadowBlur = 14;
      gctx.strokeRect(scr.x+2, scr.y+2, tsz-4, tsz-4);
      gctx.restore();
    }
  }

  renderMinimap();
}

// Zeichnet eine an den Einheitentyp angelehnte Silhouette statt eines reinen Kreises.
/* ---------- EINHEITEN-GRAFIKEN (optional, mit Fallback auf Vektor-Icons) ---------- */
// Pro Einheitentyp einfach einen Dateipfad eintragen, sobald eine Grafik vorliegt — fehlt
// ein Eintrag oder ist das Bild noch nicht geladen, zeichnet drawUnit() unverändert den
// bisherigen Vektor-Umriss (drawUnitShape). Die Quellgrafik sollte neutral/grau sein
// (siehe Bild-Prompts): sie wird beim ersten Bedarf pro (Typ, Besitzer)-Kombination EINMAL
// in die Parteifarbe eingefärbt und als Offscreen-Canvas gecacht — pro Frame kostet das
// danach nur noch ein normales drawImage(), nicht teurer als die alten Vektor-Pfade.
const UNIT_SPRITE_FILES = {
  infantry: 'images/units/infantry.webp',
  artillery: 'images/units/artillery.webp',
  helicopter: 'images/units/helicopter.webp',
  engineer: 'images/units/engineer.webp',
  fighter: 'images/units/fighter.webp',
  tank: 'images/units/tank.webp',
  battleship: 'images/units/battleship.webp',
  carrier: 'images/units/carrier.webp',
  transport: 'images/units/transport.webp',
  submarine: 'images/units/submarine.webp',
  destroyer: 'images/units/destroyer.webp'
};
const unitSpriteImages = {};
for(const type in UNIT_SPRITE_FILES){
  const img = new Image();
  img.src = UNIT_SPRITE_FILES[type];
  unitSpriteImages[type] = img;
}
function spriteReady(type){
  if(!graphicsEnabled()) return false;
  const img = unitSpriteImages[type];
  return !!img && img.complete && img.naturalWidth > 0;
}

const tintedSpriteCache = {};
// Nutzt den 'color'-Mischmodus (Hue+Sättigung der Füllfarbe, Helligkeit/Schattierung des
// Originals bleibt erhalten) — genau das richtige Werkzeug, um ein neutral-graues Modell
// einzufärben, ohne die eingemodellierten Lichter/Schatten zu verlieren.
function getTintedSprite(type, owner){
  const cacheKey = type + '_' + owner;
  let canvas = tintedSpriteCache[cacheKey];
  if(canvas) return canvas;
  const img = unitSpriteImages[type];
  const w = img.naturalWidth, h = img.naturalHeight;
  canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext('2d');
  c.drawImage(img, 0, 0);
  c.globalCompositeOperation = 'color';
  c.fillStyle = OWNER_COLORS[owner] || OWNER_COLORS[OWNER_NEUTRAL];
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(img, 0, 0);
  tintedSpriteCache[cacheKey] = canvas;
  return canvas;
}

/* ---------- TERRAIN-GRAFIKEN (optional, mit Fallback auf Flächenfarbe) ---------- */
// Keine Einfärbung nötig (Terrain hat keinen Besitzer) — die Textur wird einfach 1:1 in
// jede Kachel dieses Typs gezeichnet. Bei "nahtlosen" Texturen fügen sich gleichartige
// Nachbarkacheln optisch zu einer durchgehenden Fläche zusammen.
const TERRAIN_SPRITE_FILES = {
  [T_MOUNTAIN]: 'images/terrain/mountain.webp',
  [T_HILLS]: 'images/terrain/hills.webp',
  [T_FOREST]: 'images/terrain/forest.webp',
  [T_WATER]: 'images/terrain/water.webp',
  [T_PLAIN]: 'images/terrain/plain.webp'
};
const terrainSpriteImages = {};
for(const type in TERRAIN_SPRITE_FILES){
  const img = new Image();
  img.src = TERRAIN_SPRITE_FILES[type];
  terrainSpriteImages[type] = img;
}
function terrainSpriteReady(type){
  if(!graphicsEnabled()) return false;
  const img = terrainSpriteImages[type];
  return !!img && img.complete && img.naturalWidth > 0;
}

// Wasser-Schimmer: pro Kachel ein einzelner heller Glanzfleck, dessen Position/Phase aus
// den Kachel-Koordinaten erzeugt wird (nicht zufällig neu pro Frame) — dadurch schimmert
// jede Wasserkachel für sich stetig vor sich hin, statt bei jedem Aufruf zu "springen".
// Läuft über ensureShimmerLoop() bewusst nur mit ~6 Bildern/Sekunde, nicht mit voller
// Framerate — für ein langsames Glitzern reicht das, und es spart auf großen Karten mit
// viel sichtbarer Wasserfläche spürbar Rechenzeit gegenüber einem 60fps-Loop.
function drawWaterShimmer(px, py, tsz, x, y, now){
  const seed = ((x*928371 + y*123457) % 1000) / 1000;
  const phase = now/1400 + seed*Math.PI*2;
  const wave = Math.sin(phase);
  if(wave < 0.55) return; // nur kurz aufblitzen, nicht dauerhaft sichtbar
  const alpha = (wave-0.55)/0.45 * 0.22;
  const sx = px + tsz*(0.15 + 0.65*((seed*7)%1));
  const sy = py + tsz*(0.2 + 0.6*((seed*13)%1));
  gctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
  gctx.beginPath();
  gctx.ellipse(sx, sy, tsz*0.16, tsz*0.045, -0.3, 0, Math.PI*2);
  gctx.fill();
}

/* ---------- STADT-GRAFIKEN (optional, mit Fallback auf Farbfläche+Symbol) ---------- */
// Städte werden wie Einheiten pro Partei eingefärbt (Besitzerfarbe ist spielrelevant),
// aber nicht gespiegelt — ein Gebäude hat keine "Blickrichtung", die Us-vs-Them-Unterscheidung
// kommt hier allein aus der Farbe. Ruinen gehören niemandem und werden daher neutral,
// ungetintet gezeichnet.
const CITY_SPRITE_FILES = {
  city: 'images/city/city.webp',
  capital: 'images/city/capital.webp',
  arms: 'images/city/arms.webp',
  airbase: 'images/city/airbase.webp',
  harbor: 'images/city/harbor.webp'
};
const citySpriteImages = {};
for(const type in CITY_SPRITE_FILES){
  const img = new Image();
  img.src = CITY_SPRITE_FILES[type];
  citySpriteImages[type] = img;
}
function citySpriteReady(type){
  if(!graphicsEnabled()) return false;
  const img = citySpriteImages[type];
  return !!img && img.complete && img.naturalWidth > 0;
}
const tintedCitySpriteCache = {};
function getTintedCitySprite(type, owner){
  const cacheKey = type + '_' + owner;
  let canvas = tintedCitySpriteCache[cacheKey];
  if(canvas) return canvas;
  const img = citySpriteImages[type];
  const w = img.naturalWidth, h = img.naturalHeight;
  canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext('2d');
  c.drawImage(img, 0, 0);
  c.globalCompositeOperation = 'color';
  c.fillStyle = OWNER_COLORS[owner] || OWNER_COLORS[OWNER_NEUTRAL];
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(img, 0, 0);
  tintedCitySpriteCache[cacheKey] = canvas;
  return canvas;
}
const ruinSpriteImage = new Image();
ruinSpriteImage.src = 'images/city/ruin.webp';
function ruinSpriteReady(){ return graphicsEnabled() && ruinSpriteImage.complete && ruinSpriteImage.naturalWidth > 0; }

/* ---------- FESTUNG / RADAR (Enhanced, optional mit Fallback auf Vektor) ---------- */
// Festung gehört keiner Partei (Verteidigungsbonus gilt für jeden, der dort steht) und
// bleibt daher ungetintet, wie die Ruine. Radar ist wie eine Stadt eine erobbare, einem
// Besitzer gehörende Struktur und wird entsprechend eingefärbt.
const fortressSpriteImage = new Image();
fortressSpriteImage.src = 'images/structures/fortress.webp';
function fortressSpriteReady(){ return graphicsEnabled() && fortressSpriteImage.complete && fortressSpriteImage.naturalWidth > 0; }

const radarSpriteImage = new Image();
radarSpriteImage.src = 'images/structures/radar.webp';
function radarSpriteReady(){ return graphicsEnabled() && radarSpriteImage.complete && radarSpriteImage.naturalWidth > 0; }
const tintedRadarSpriteCache = {};
function getTintedRadarSprite(owner){
  let canvas = tintedRadarSpriteCache[owner];
  if(canvas) return canvas;
  const img = radarSpriteImage;
  const w = img.naturalWidth, h = img.naturalHeight;
  canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext('2d');
  c.drawImage(img, 0, 0);
  c.globalCompositeOperation = 'color';
  c.fillStyle = OWNER_COLORS[owner] || OWNER_COLORS[OWNER_NEUTRAL];
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(img, 0, 0);
  tintedRadarSpriteCache[owner] = canvas;
  return canvas;
}

function drawUnitShape(type, isAir){
  gctx.beginPath();
  switch(type){
    case 'tank':
      gctx.rect(-0.32,-0.16,0.64,0.32);
      gctx.rect(-0.05,-0.28,0.3,0.16);
      break;
    case 'artillery':
      gctx.rect(-0.28,-0.14,0.56,0.28);
      gctx.moveTo(0,-0.04); gctx.lineTo(0.4,-0.22); gctx.lineTo(0.36,-0.14); gctx.lineTo(0.02,0.02);
      break;
    case 'infantry':
      gctx.arc(0,-0.08,0.16,0,Math.PI*2);
      gctx.rect(-0.06,0.06,0.12,0.28);
      break;
    case 'destroyer':
      gctx.moveTo(-0.4,0); gctx.lineTo(-0.2,-0.16); gctx.lineTo(0.32,-0.16); gctx.lineTo(0.42,0); gctx.lineTo(0.32,0.16); gctx.lineTo(-0.2,0.16);
      gctx.closePath();
      break;
    case 'battleship':
      gctx.moveTo(-0.45,0); gctx.lineTo(-0.25,-0.2); gctx.lineTo(0.35,-0.2); gctx.lineTo(0.48,0); gctx.lineTo(0.35,0.2); gctx.lineTo(-0.25,0.2);
      gctx.closePath();
      gctx.rect(-0.08,-0.32,0.16,0.14);
      break;
    case 'transport':
      gctx.rect(-0.42,-0.16,0.84,0.32);
      break;
    case 'carrier':
      gctx.rect(-0.46,-0.14,0.92,0.28);
      gctx.rect(0.1,-0.3,0.16,0.18);
      break;
    case 'submarine':
      gctx.ellipse(0,0,0.42,0.13,0,0,Math.PI*2);
      gctx.rect(-0.06,-0.26,0.12,0.16);
      break;
    case 'fighter':
      gctx.moveTo(0,-0.4); gctx.lineTo(0.3,0.3); gctx.lineTo(0,0.14); gctx.lineTo(-0.3,0.3);
      gctx.closePath();
      break;
    case 'helicopter':
      gctx.arc(0,0,0.26,0,Math.PI*2);
      gctx.moveTo(-0.42,-0.32); gctx.lineTo(0.42,0.32);
      gctx.moveTo(-0.42,0.32); gctx.lineTo(0.42,-0.32);
      break;
    default:
      gctx.arc(0,0,0.34,0,Math.PI*2);
  }
}

// Zeichnet eine bereits aus dem Spiel entfernte (oder rein virtuelle) Kampfeinheit anhand
// ihres Snapshots — nur die Silhouette + Label, ohne HP-Balken/Status (die gibt es nicht
// mehr), damit sie während der Kampf-Sequenz sichtbar bleibt statt vorzeitig zu verschwinden.
function drawGhostUnit(snap, tsz){
  const scr = worldToScreen(snap.x*BASE_TILE, snap.y*BASE_TILE);
  const px = scr.x, py = scr.y;
  const s = UNIT_STATS[snap.type];
  const cx = px+tsz/2, cy = py+tsz/2;
  gctx.save();
  gctx.globalAlpha = 0.85;
  if(spriteReady(snap.type)){
    const sprite = getTintedSprite(snap.type, snap.owner);
    gctx.save();
    gctx.translate(cx, cy);
    if(snap.owner !== OWNER_PLAYER) gctx.scale(-1, 1);
    gctx.drawImage(sprite, -tsz/2, -tsz/2, tsz, tsz);
    gctx.restore();
  } else {
    gctx.save();
    gctx.translate(cx, cy);
    gctx.scale(tsz, tsz);
    drawUnitShape(snap.type, s.category==='air');
    gctx.restore();
    gctx.fillStyle = OWNER_COLORS[snap.owner];
    gctx.fill();
    gctx.lineWidth = 1.5;
    gctx.strokeStyle = '#000';
    gctx.stroke();
    gctx.fillStyle = '#0a0e14';
    gctx.font = `bold ${Math.floor(tsz*0.28)}px monospace`;
    gctx.textAlign = 'center';
    gctx.textBaseline = 'middle';
    gctx.fillText(s.label, cx, cy+1);
  }
  gctx.restore();
}

function drawUnit(u, tsz){
  let wx = u.x*BASE_TILE, wy = u.y*BASE_TILE;
  if(u._animFrom){
    const t = (performance.now() - u._animStart) / u._animDuration;
    if(t < 1){
      const ease = 1 - Math.pow(1-Math.max(0,t), 2); // ease-out
      wx = (u._animFrom.x + (u.x-u._animFrom.x)*ease) * BASE_TILE;
      wy = (u._animFrom.y + (u.y-u._animFrom.y)*ease) * BASE_TILE;
    } else {
      u._animFrom = null;
    }
  }
  const scr = worldToScreen(wx, wy);
  const px = scr.x, py = scr.y;
  const s = UNIT_STATS[u.type];
  const color = OWNER_COLORS[u.owner];
  const isSelected = selectedUnit===u;
  const isAir = s.category==='air';
  const isDeep = u.subLevel==='deep';
  const cx = px+tsz/2, cy = py+tsz/2;

  const useSprite = spriteReady(u.type);
  const movedDim = (u.moved || u.orderState || u.destination || u.patrol || u.dugIn) && u.owner===OWNER_PLAYER;

  gctx.save();
  if(isDeep) gctx.globalAlpha = 0.55;

  if(useSprite){
    // Grafik-Pfad: eingefärbtes Sprite statt Vektor-Umriss. Alle anderen Gegner (nicht der
    // Spieler) werden horizontal gespiegelt — kostet keine zweite Grafik, macht "eigene vs.
    // fremde Einheit" aber auf einen Blick unterscheidbar, zusätzlich zur Farbe.
    const sprite = getTintedSprite(u.type, u.owner);
    gctx.save();
    gctx.translate(cx, cy);
    if(isSelected){
      gctx.beginPath();
      gctx.ellipse(0, tsz*0.36, tsz*0.34, tsz*0.11, 0, 0, Math.PI*2);
      gctx.strokeStyle = '#e0b84a';
      gctx.lineWidth = 2.5;
      gctx.stroke();
    }
    if(u.owner !== OWNER_PLAYER) gctx.scale(-1, 1);
    if(movedDim) gctx.globalAlpha *= 0.5;
    gctx.drawImage(sprite, -tsz/2, -tsz/2, tsz, tsz);
    gctx.restore();
  } else {
    gctx.save();
    gctx.translate(cx, cy);
    gctx.scale(tsz, tsz);
    drawUnitShape(u.type, isAir);
    gctx.restore();
    gctx.fillStyle = color;
    gctx.fill();
    gctx.lineWidth = isSelected ? 3 : (isCrippled(u) ? 2.5 : 1.5);
    gctx.strokeStyle = isSelected ? '#e0b84a' : (isCrippled(u) ? '#f5473f' : '#000');
    if(isDeep) gctx.setLineDash([3,2]);
    gctx.stroke();
    gctx.setLineDash([]);

    gctx.fillStyle = '#0a0e14';
    gctx.font = `bold ${Math.floor(tsz*0.28)}px monospace`;
    gctx.textAlign = 'center';
    gctx.textBaseline = 'middle';
    gctx.fillText(s.label, cx, cy+1);
  }

  const maxHp = effStat(u,'hp');
  const barW = tsz*0.6;
  const barX = cx-barW/2;
  const barY = py+tsz*0.86;
  gctx.fillStyle = '#000';
  gctx.fillRect(barX, barY, barW, 4);
  gctx.fillStyle = u.hp/maxHp > 0.5 ? '#5ad65a' : '#e0b84a';
  gctx.fillRect(barX, barY, barW*(u.hp/maxHp), 4);

  if(tsz>22){
    gctx.fillStyle = EFF_COLORS[EFFECTIVENESS[u.effectiveness]];
    gctx.beginPath();
    gctx.arc(px+tsz*0.14, py+tsz*0.14, tsz*0.07, 0, Math.PI*2);
    gctx.fill();
  }

  if(u.dugIn && tsz>22){
    gctx.strokeStyle = '#e0b84a';
    gctx.lineWidth = 2;
    gctx.beginPath();
    gctx.moveTo(px+tsz*0.25, py+tsz*0.92);
    gctx.lineTo(px+tsz*0.5, py+tsz*0.8);
    gctx.lineTo(px+tsz*0.75, py+tsz*0.92);
    gctx.stroke();
  }
  if(u.orderState && tsz>20){
    gctx.fillStyle = '#e0b84a';
    gctx.font = `${Math.floor(tsz*0.3)}px sans-serif`;
    gctx.fillText(u.orderState==='resting' ? '💤' : '⏸', cx, py+tsz*0.14);
  }
  if((u.destination || u.patrol) && tsz>20 && !u.orderState){
    gctx.fillStyle = '#e0b84a';
    gctx.font = `${Math.floor(tsz*0.28)}px sans-serif`;
    gctx.fillText(u.patrol ? '🔁' : '➤', cx, py+tsz*0.14);
  }

  if(u.type==='fighter' && tsz>26){
    gctx.fillStyle = '#e0b84a';
    gctx.font = `${Math.floor(tsz*0.22)}px monospace`;
    gctx.fillText(`⛽${u.fuel}`, cx, py+tsz*0.14);
  }
  if(u.cargo && u.cargo.length>0 && tsz>22){
    gctx.fillStyle = '#e0b84a';
    gctx.font = `bold ${Math.floor(tsz*0.24)}px monospace`;
    gctx.fillText(`+${u.cargo.length}`, px+tsz*0.86, py+tsz*0.14);
  }

  if(!useSprite && movedDim){
    gctx.fillStyle = 'rgba(0,0,0,0.35)';
    gctx.save();
    gctx.translate(cx, cy);
    gctx.scale(tsz, tsz);
    drawUnitShape(u.type, isAir);
    gctx.restore();
    gctx.fill();
  }
  gctx.restore();
}

// Terrain ändert sich innerhalb einer Partie nicht (außer Städte-Besitz) — auf großen
// Karten wird die Terrain-Ebene daher einmalig in ein Offscreen-Canvas vorgerendert,
// damit renderMinimap() bei jedem Kamera-Pan nicht die ganze Karte neu durchlaufen muss.
let minimapTerrainCanvas = null;
function buildMinimapTerrainCache(){
  minimapTerrainCanvas = document.createElement('canvas');
  minimapTerrainCanvas.width = minimapCanvas.width;
  minimapTerrainCanvas.height = minimapCanvas.height;
  const tctx2 = minimapTerrainCanvas.getContext('2d');
  const scale = minimapCanvas.width / worldW();
  tctx2.fillStyle = '#12182688';
  tctx2.fillRect(0,0,minimapCanvas.width, minimapCanvas.height);
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      // Nebel des Krieges: unentdeckte Kacheln bleiben auf der Minimap ebenfalls verborgen,
      // statt die ganze Karte sofort zu zeigen (exploredSet wächst nur, siehe recomputeVisibility).
      if(fogEnabled && !exploredSet.has(key(x,y))) continue;
      const t = map[y][x].type;
      if(t===T_MOUNTAIN) tctx2.fillStyle = '#4a4a52';
      else if(t===T_WATER) tctx2.fillStyle = '#163a52';
      else continue;
      tctx2.fillRect(x*BASE_TILE*scale, y*BASE_TILE*scale, Math.max(1,BASE_TILE*scale), Math.max(1,BASE_TILE*scale));
    }
  }
}

function renderMinimap(){
  if(map.length===0) return;
  if(!minimapTerrainCanvas) buildMinimapTerrainCache();
  mctx.clearRect(0,0,minimapCanvas.width, minimapCanvas.height);
  mctx.drawImage(minimapTerrainCanvas, 0, 0);
  const scale = minimapCanvas.width / worldW();

  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      if(fogEnabled && !exploredSet.has(key(x,y))) continue;
      if(map[y][x].type===T_CITY){
        mctx.fillStyle = OWNER_COLORS[map[y][x].owner] || OWNER_COLORS[OWNER_NEUTRAL];
        mctx.fillRect(x*BASE_TILE*scale, y*BASE_TILE*scale, 4, 4);
      }
    }
  }

  mctx.strokeStyle = '#e0b84a';
  mctx.lineWidth = 2;
  const viewW = (gameCanvas.width/camera.zoom) * scale;
  const viewH = (gameCanvas.height/camera.zoom) * scale;
  mctx.strokeRect(camera.x*scale, camera.y*scale, viewW, viewH);
}

/* ---------- SPIEL INITIALISIEREN ---------- */
function initGame(){
  // Archipel hat eine feste Kartengröße (doppelte Fläche von "Sehr Groß"), unabhängig
  // von der separat wählbaren Kartengröße.
  const sizeCfg = mapConfig.landform==='archipelago' ? SIZE_PRESETS.archipelago : (SIZE_PRESETS[mapConfig.size] || SIZE_PRESETS.medium);
  COLS = sizeCfg.cols; ROWS = sizeCfg.rows;

  const count = Math.max(1, Math.min(4, parseInt(mapConfig.aiCount,10) || 1));
  aiOwners = AI_OWNER_POOL.slice(0, count);
  turnOrder = [OWNER_PLAYER, ...aiOwners];
  turnIndex = 0;
  currentTurnOwner = OWNER_PLAYER;
  fogEnabled = mapConfig.fogOfWar === 'on';
  visibleSet = new Set();
  exploredSet = new Set();

  units = [];
  unitIdCounter = 1;
  turnNumber = 1;
  selectedUnit = null;
  reachableTiles = []; attackableTiles = []; rangedTiles = []; rangeRadiusTiles = []; unloadTiles = [];
  unloadingCargoUnit = null;
  awaitingWaypointClick = false;
  awaitingPatrolStep = 0;
  patrolPointA = null;
  dragPreviewTarget = null;
  gameOver = false;
  minimapTerrainCanvas = null;
  coalitionAgainst = null;
  lastStandActive = false;
  radarPositions = [];
  closeBuildPanel();
  document.getElementById('unit-info-panel').classList.add('hidden');
  document.getElementById('game-over').classList.add('hidden');
  document.getElementById('unit-actions').innerHTML = '';

  const { capitalSpots, owners } = generateMap();
  for(let i=0;i<owners.length;i++){
    const spot = capitalSpots[i];
    const dir = DIRS4[i % DIRS4.length];
    let sx = spot.x+dir[0], sy = spot.y+dir[1];
    if(!inBounds(sx,sy) || map[sy][sx].type===T_WATER){ sx=spot.x; sy=spot.y; }
    spawnUnit(owners[i], 'infantry', sx, sy);
  }

  resizeCanvas();
  camera.zoom = 1;
  centerCameraOn(capitalSpots[0].x*BASE_TILE+BASE_TILE/2, capitalSpots[0].y*BASE_TILE+BASE_TILE/2);
  updateHud();
  const firstUnit = findNextIdleUnit(null);
  if(firstUnit){
    selectUnit(firstUnit);
  } else {
    updateInfoPanel(`Runde 1 — ${aiOwners.length} Gegner. Ziehen/[Pfeile]=Karte verschieben, Mausrad/[+/-]=Zoom, [G]=Marschziel, [P]atrouille, [R/W/B/X]=Rasten/Warten/Befestigen/Pass, [Leertaste]=Zug beenden.`);
  }
  render();
}

/* ---------- SPEICHERN / LADEN (3 lokale Spielstände via localStorage) ---------- */
const SAVE_SLOTS = 3;
function saveKey(slot){ return `empire_save_slot_${slot}`; }

// Speichert je Kachel nur vom Default abweichende Felder. Seit dem Enhanced-Update trägt
// jede Kachel mehrere zusätzliche Overlay-Felder (rail/fortress/ruined/specialization...),
// die auf großen/riesigen Karten (bis zu ~24000 Kacheln) bei voller Serialisierung allein
// mehrere MB reines "false/null"-Rauschen erzeugen — das sprengt die localStorage-Quota.
function serializeTile(t){
  const c = { type: t.type };
  if(t.owner) c.owner = t.owner;
  if(t.buildPoints) c.buildPoints = t.buildPoints;
  if(t.buildType && t.buildType!=='infantry') c.buildType = t.buildType;
  if(t.capital) c.capital = true;
  if(t.road) c.road = true;
  if(t.rallyPoint) c.rallyPoint = t.rallyPoint;
  if(t.rail) c.rail = true;
  if(t.fortress) c.fortress = true;
  if(t.ruined) c.ruined = true;
  if(t.specialization) c.specialization = t.specialization;
  if(t.pendingSpecialization) c.pendingSpecialization = t.pendingSpecialization;
  if(t.specializationTimer) c.specializationTimer = t.specializationTimer;
  return c;
}

// Ergänzt die beim Speichern weggelassenen Default-Felder wieder — v1-Spielstände
// (vollständige Kachel-Objekte) laufen unverändert durch Object.assign durch.
function deserializeTile(c){
  return Object.assign(newTile(c.type), c);
}

const SAVE_VERSION = 2;

function serializeGame(){
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    mapConfig: JSON.parse(JSON.stringify(mapConfig)),
    COLS, ROWS,
    map: map.map(row => row.map(serializeTile)),
    units, unitIdCounter,
    aiOwners, turnOrder, turnIndex, turnNumber, currentTurnOwner,
    gameOver, fogEnabled,
    exploredSet: [...exploredSet],
    camera: { x:camera.x, y:camera.y, zoom:camera.zoom }
  };
}

function hasActiveGame(){
  return !document.getElementById('game-screen').classList.contains('hidden');
}

function saveGameToSlot(slot){
  try {
    localStorage.setItem(saveKey(slot), JSON.stringify(serializeGame()));
    return true;
  } catch(e){
    if(e.name==='QuotaExceededError'){
      alert('Speichern fehlgeschlagen: Der lokale Speicherplatz des Browsers ist voll. ' +
        'Lösche einen der anderen Spielstände (oder Spielstände aus anderen Spielen/Seiten) und versuche es erneut.');
    } else {
      alert('Speichern fehlgeschlagen: ' + e.message);
    }
    return false;
  }
}

function loadGameFromSlot(slot){
  const raw = localStorage.getItem(saveKey(slot));
  if(!raw) return false;
  let data;
  try { data = JSON.parse(raw); } catch(e){ return false; }

  mapConfig = data.mapConfig;
  COLS = data.COLS; ROWS = data.ROWS;
  // v1-Spielstände enthalten bereits vollständige Kachel-Objekte, v2+ nur die vom Default
  // abweichenden Felder (siehe serializeTile) — beide Formate bleiben ladbar.
  map = (data.version >= 2) ? data.map.map(row => row.map(deserializeTile)) : data.map;
  units = data.units;
  unitIdCounter = data.unitIdCounter;
  aiOwners = data.aiOwners;
  turnOrder = data.turnOrder;
  turnIndex = data.turnIndex;
  turnNumber = data.turnNumber;
  currentTurnOwner = data.currentTurnOwner;
  gameOver = data.gameOver;
  fogEnabled = !!data.fogEnabled;
  exploredSet = new Set(data.exploredSet || []);
  visibleSet = new Set();
  updateDominanceState();
  refreshRadarPositions();

  selectedUnit = null;
  reachableTiles = []; attackableTiles = []; rangedTiles = []; rangeRadiusTiles = []; unloadTiles = [];
  unloadingCargoUnit = null;
  awaitingWaypointClick = false; awaitingPatrolStep = 0; patrolPointA = null; awaitingRallyClick = null;
  awaitingEngineerOrder = null;
  dragPreviewTarget = null;
  minimapTerrainCanvas = null;
  selectedBuildCity = null;

  document.getElementById('title-screen').classList.add('hidden');
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('save-load-panel').classList.add('hidden');
  document.getElementById('game-over').classList.toggle('hidden', !gameOver);
  document.getElementById('game-screen').classList.remove('hidden');
  document.getElementById('unit-info-panel').classList.add('hidden');
  closeBuildPanel();
  ensureShimmerLoop();

  resizeCanvas();
  camera.zoom = (data.camera && data.camera.zoom) || 1;
  if(data.camera) centerCameraOn(data.camera.x + (gameCanvas.width/camera.zoom)/2, data.camera.y + (gameCanvas.height/camera.zoom)/2);
  else clampCamera();
  updateHud();
  renderUnitActions();
  updateInfoPanel(`Spielstand geladen — Runde ${turnNumber}.`);
  render();
  MusicEngine.start();
  return true;
}

function deleteSaveSlot(slot){
  localStorage.removeItem(saveKey(slot));
}

function getSlotMeta(slot){
  const raw = localStorage.getItem(saveKey(slot));
  if(!raw) return null;
  try {
    const data = JSON.parse(raw);
    return {
      savedAt: data.savedAt,
      turnNumber: data.turnNumber,
      aiCount: data.aiOwners ? data.aiOwners.length : '?'
    };
  } catch(e){ return null; }
}

function formatSlotDate(ts){
  const d = new Date(ts);
  const pad = n => String(n).padStart(2,'0');
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openSaveLoadPanel(){
  renderSaveSlots();
  document.getElementById('save-load-panel').classList.remove('hidden');
}
function closeSaveLoadPanel(){
  document.getElementById('save-load-panel').classList.add('hidden');
}

function renderSaveSlots(){
  const inGame = hasActiveGame();
  const container = document.getElementById('save-slots');
  container.innerHTML = '';
  for(let slot=1; slot<=SAVE_SLOTS; slot++){
    const meta = getSlotMeta(slot);
    const row = document.createElement('div');
    row.className = 'save-slot';

    const info = document.createElement('div');
    info.className = 'save-slot-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'save-slot-name';
    nameEl.textContent = `Spielstand ${slot}`;
    const metaEl = document.createElement('span');
    metaEl.className = 'save-slot-meta';
    metaEl.textContent = meta ? `Runde ${meta.turnNumber} · ${meta.aiCount} Gegner · ${formatSlotDate(meta.savedAt)}` : 'Leer';
    info.appendChild(nameEl); info.appendChild(metaEl);

    const actions = document.createElement('div');
    actions.className = 'save-slot-actions';

    if(inGame){
      const saveBtn = document.createElement('button');
      saveBtn.textContent = '💾 Speichern';
      saveBtn.addEventListener('click', () => {
        saveGameToSlot(slot);
        renderSaveSlots();
      });
      actions.appendChild(saveBtn);
    }

    const loadBtn = document.createElement('button');
    loadBtn.textContent = '📂 Laden';
    loadBtn.disabled = !meta;
    loadBtn.addEventListener('click', () => {
      if(loadGameFromSlot(slot)) closeSaveLoadPanel();
    });
    actions.appendChild(loadBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '×';
    delBtn.disabled = !meta;
    delBtn.title = 'Löschen';
    delBtn.addEventListener('click', () => {
      deleteSaveSlot(slot);
      renderSaveSlots();
    });
    actions.appendChild(delBtn);

    row.appendChild(info);
    row.appendChild(actions);
    container.appendChild(row);
  }
}

document.getElementById('save-load-btn').addEventListener('click', openSaveLoadPanel);
document.getElementById('load-btn-title').addEventListener('click', openSaveLoadPanel);
document.getElementById('save-load-close-btn').addEventListener('click', closeSaveLoadPanel);

/* ---------- BUTTON-HANDLER ---------- */
function startGame(){
  MusicEngine.start();
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('title-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  initGame();
}

document.getElementById('start-btn').addEventListener('click', () => {
  MusicEngine.start();
  document.getElementById('title-screen').classList.add('hidden');
  document.getElementById('setup-screen').classList.remove('hidden');
});
document.getElementById('setup-back-btn').addEventListener('click', () => {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('title-screen').classList.remove('hidden');
});
document.getElementById('setup-start-btn').addEventListener('click', startGame);

document.querySelectorAll('.setup-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    const group = btn.parentElement.dataset.group;
    document.querySelectorAll(`.setup-options[data-group="${group}"] .setup-opt`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    mapConfig[group] = btn.dataset.value;
    if(group==='animEnabled'){
      document.getElementById('anim-speed-row').style.display = (btn.dataset.value==='on') ? 'flex' : 'none';
    }
    if(group==='landform'){
      // Archipel hat eine feste Kartengröße — die Größenauswahl währenddessen sperren.
      const isArchipelago = btn.dataset.value==='archipelago';
      document.querySelectorAll('.setup-options[data-group="size"] .setup-opt').forEach(b => b.disabled = isArchipelago);
    }
  });
});
document.getElementById('anim-speed-slider').addEventListener('input', (evt) => {
  animSpeed = parseInt(evt.target.value, 10) || 5;
});

document.getElementById('restart-btn').addEventListener('click', () => {
  document.getElementById('game-over').classList.add('hidden');
  initGame();
});

function syncMuteButtons(){
  const muted = MusicEngine.isMuted();
  document.getElementById('mute-btn').textContent = muted ? '🔇 MUSIK AUS' : '🔊 MUSIK AN';
  document.getElementById('mute-btn-2').textContent = muted ? '🔇' : '🔊';
}

document.getElementById('mute-btn').addEventListener('click', () => {
  MusicEngine.start();
  MusicEngine.toggleMute();
  syncMuteButtons();
});
document.getElementById('mute-btn-2').addEventListener('click', () => {
  MusicEngine.toggleMute();
  syncMuteButtons();
});
