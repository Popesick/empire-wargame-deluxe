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
  huge:   { cols:136, rows:88 } // vierfache Fläche von "Groß"
};
const CITY_TILES_PER_CITY = { sparse:70, normal:44, dense:28 };

let mapConfig = { size:'medium', landform:'continent', landAmount:'normal', cities:'normal', aiCount:1, fogOfWar:'off', animEnabled:'on' };
let animSpeed = 5; // 1 (langsam) .. 10 (schnell)
let fogEnabled = false;

const T_PLAIN = 'plain';
const T_FOREST = 'forest';
const T_HILLS = 'hills';
const T_MOUNTAIN = 'mountain';
const T_WATER = 'water';
const T_CITY = 'city';
const T_AIRPORT = 'airport';

const MOVE_COST = { [T_PLAIN]:1, [T_FOREST]:2, [T_HILLS]:2, [T_MOUNTAIN]:3, [T_WATER]:1, [T_CITY]:1, [T_AIRPORT]:1 };
const SIGHT_RANGE = { ground:2, air:4 };

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
  fighter:    { name:'Jäger',         label:'F', category:'air',    subclass:null,   move:10, dmg:1, power:60, defense:30, hp:2,  cost:25, range:0, fuel:8 }
};
const BUILD_ORDER = ['infantry','tank','artillery','destroyer','transport','battleship','carrier','submarine','helicopter','fighter'];

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
let selectedBuildCity = null;
let awaitingWaypointClick = false;
let awaitingPatrolStep = 0; // 0=inaktiv, 1=wartet auf Punkt A, 2=wartet auf Punkt B
let patrolPointA = null;
let awaitingRallyClick = null; // {x,y} der Stadt, für die gerade ein Sammelpunkt gesetzt wird
let dragPreviewTarget = null;

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
    render();
    const stillAnimating = units.some(u => u._animFrom && (performance.now()-u._animStart < u._animDuration));
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
  tank: 'audio/combat-infantry.mp3',
  destroyer: 'audio/combat-naval.mp3',
  transport: 'audio/combat-naval.mp3',
  battleship: 'audio/combat-naval.mp3',
  carrier: 'audio/combat-naval.mp3',
  submarine: 'audio/combat-naval.mp3'
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
  return { x:u.x, y:u.y, type:u.type, owner:u.owner };
}

/* ---------- KARTE GENERIEREN ---------- */
function newTile(type){
  return { type, owner:null, buildPoints:0, buildType:'infantry', capital:false, road:false };
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

  if(mapConfig.landform === 'islands'){
    carveIslands(totalPlayers);
  } else {
    carveContinentCoastline();
  }

  const { components } = computeLandmasses();
  components.sort((a,b) => b.length - a.length);

  // Hauptstadt-Plätze: größte Landmassen zuerst, je Landmasse den Punkt mit größtem
  // Mindestabstand zu bereits gewählten Hauptstädten (verteilt sie gut).
  const capitalSpots = [];
  for(let i=0; i<totalPlayers; i++){
    const comp = components.length ? components[i % components.length] : null;
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
    cargo: stats.portageCapacity ? [] : null
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
function isCrippled(u){ return u.hp <= UNIT_STATS[u.type].hp/2; }
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
  if(tile.road) return 1;
  return MOVE_COST[tile.type];
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

function hitChance(attacker, defender, attackerCrippled){
  const a = UNIT_STATS[attacker.type], d = UNIT_STATS[defender.type];
  let chance = 50 + (a.power - d.defense) * 0.6;
  chance += effDiff(defender, attacker) * 5;
  if(defender.dugIn) chance -= 15;
  if(attackerCrippled) chance -= 15;
  return Math.min(99, Math.max(1, Math.round(chance)));
}

function grantExperience(u){
  u.xpWins++;
  if(u.experience==='green' && u.xpWins >= EXPERIENCE_WINS_NEEDED.proven) u.experience='proven';
  else if(u.experience==='proven' && u.xpWins >= EXPERIENCE_WINS_NEEDED.hardened) u.experience='hardened';
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

function captureCity(x,y, owner, capturingUnit){
  const tile = map[y][x];
  if(tile.type !== T_CITY) return;
  tile.owner = owner;
  tile.buildPoints = 0;
  tile.buildType = 'infantry';
  tile.rallyPoint = null;
  const stats = UNIT_STATS[capturingUnit.type];
  if(stats.captureMorph && capturingUnit.hp >= stats.hp){
    destroyUnit(capturingUnit);
    spawnUnit(owner, stats.captureMorph, x, y);
  }
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
function tryCaptureStructure(unit, x, y){
  const tile = map[y][x];
  if(tile.type===T_AIRPORT && tile.owner!==unit.owner){
    tile.owner = unit.owner;
    return true;
  }
  if(tile.type===T_CITY && tile.owner!==unit.owner){
    const survived = resolveCityDefenseCombat(unit);
    MusicEngine.start();
    if(survived) captureCity(x, y, unit.owner, unit);
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
function canAttackTargetType(attackerType, defenderType){
  const d = UNIT_STATS[defenderType];
  if(NO_LAND_ATTACK.includes(attackerType) && d.subclass==='land') return false;
  if(attackerType==='infantry' && d.subclass==='sea') return false;
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
    .filter(o => o.owner!==attacker.owner && canAttackTargetType(attacker.type, o.type))
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
function setDestination(unit, x, y, silent){
  if(x===unit.x && y===unit.y){ unit.destination = null; return true; }
  const path = computePathTowards(unit, {x,y});
  if(!path){
    if(!silent) updateInfoPanel('Zielpunkt ist auf diesem Weg nicht erreichbar.');
    return false;
  }
  unit.destination = {x,y};
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
    if(unit.x===unit.destination.x && unit.y===unit.destination.y){ unit.destination=null; break; }
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
    if((tile.type===T_CITY || tile.type===T_AIRPORT) && tile.owner!==unit.owner && stats.subclass==='land'){
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

// Patrouille: pendelt selbständig zwischen zwei Wegpunkten (A/B), bricht wie ein
// Marschbefehl bei Feindkontakt ab.
function advancePatrol(unit){
  if(!unit.patrol || unit.moved || unit.hp<=0) return;
  const stats = UNIT_STATS[unit.type];
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
    if((tile.type===T_CITY || tile.type===T_AIRPORT) && tile.owner!==unit.owner && stats.subclass==='land'){
      if(!tryCaptureStructure(unit, step.x, step.y)){ queueMoveAnim(unit, animFromX, animFromY); return; }
    }
    if(adjacentTiles(unit.x,unit.y).some(t => pickDefenderAt(t.x,t.y,unit))){
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
    u.moved = false;
    const s = UNIT_STATS[u.type];
    u.movesLeft = isCrippled(u) ? Math.max(1, Math.floor(s.move/2)) : s.move;
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
  // Zug noch zuschlagen.
  const origins = [{x:u.x,y:u.y,d:0}, ...reachableTiles.map(t=>({x:t.x,y:t.y,d:reachDist[key(t.x,t.y)]}))];
  const seenAttack = new Set();
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
      if(occ.length===0 && (tile.type===T_CITY || tile.type===T_AIRPORT) && tile.owner!==u.owner && stats.subclass==='land'){
        attackableTiles.push(t);
        seenAttack.add(tk);
      }
    }
  }

  // Fernkampf nur, wenn noch KEIN Bewegungspunkt verbraucht wurde (Originalregel).
  if(stats.range > 0 && u.movesLeft===stats.move && !u.actedAtAll){
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

// Nächste eigene Einheit, die noch keinen Befehl für diese Runde hat. Zyklisch nach ID
// sortiert, damit übersprungene Einheiten (der Spieler wählte manuell eine andere)
// später wieder drankommen.
function findNextIdleUnit(afterId){
  const list = unitsOf(OWNER_PLAYER).filter(isUnitPending).sort((a,b)=>a.id-b.id);
  if(list.length===0) return null;
  if(afterId==null) return list[0];
  const idx = list.findIndex(u=>u.id>afterId);
  return idx>=0 ? list[idx] : list[0];
}

// TAB: zyklisch durch Einheiten mit laufendem Marschziel/Patrouille wechseln — also
// "inaktive" Einheiten, die grundsätzlich noch handeln könnten. Rasten/Warten/Befestigt
// sind bewusst ausgeschlossen: die wurden absichtlich geparkt, TAB soll nicht damit nerven.
function findNextInactiveUnit(afterId){
  const list = unitsOf(OWNER_PLAYER).filter(u => u.destination || u.patrol).sort((a,b)=>a.id-b.id);
  if(list.length===0) return null;
  if(afterId==null) return list[0];
  const idx = list.findIndex(u=>u.id>afterId);
  return idx>=0 ? list[idx] : list[0];
}

// Schließt die Aktion einer Einheit ab und wählt automatisch die nächste unerledigte
// Einheit des Spielers aus (falls noch eine übrig ist).
function finishUnitTurn(unit){
  const finishedId = unit ? unit.id : null;
  deselect();
  checkGameOver();
  updateHud();
  if(!gameOver && currentTurnOwner===OWNER_PLAYER){
    const next = findNextIdleUnit(finishedId);
    if(next) selectUnit(next);
  }
}

function updateSelectionInfo(){
  if(!selectedUnit){ updateInfoPanel('Wähle eine Einheit aus, um sie zu bewegen oder anzugreifen.'); return; }
  const u = selectedUnit, s = UNIT_STATS[u.type];
  let parts = [`${s.name} ausgewählt`, `HP ${u.hp}/${s.hp}`, `Bew ${u.movesLeft}/${s.move}`, effName(u), EXPERIENCE_NAME[u.experience]];
  if(s.fuel !== undefined) parts.push(`Sprit ${u.fuel}/${s.fuel}`);
  if(u.dugIn) parts.push('Befestigt');
  if(isCrippled(u)) parts.push('Angeschlagen');
  if(u.subLevel==='deep') parts.push('Getaucht');
  if(u.cargo && u.cargo.length) parts.push(`Fracht ${u.cargo.length}/${s.portageCapacity}`);
  if(u.destination) parts.push('Marschbefehl aktiv');
  if(u.patrol) parts.push('Patrouille aktiv');
  updateInfoPanel(parts.join(' | ') + '. Blau=Bewegen, Rot=Angriff/Erobern, Orange=Fernkampf. [G]=Marschziel, [P]atrouille, [R]asten [W]arten [B]efestigen [X]=Pass.');
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
  if(u.moved) return;

  const addBtn = (label, onClick, toggled) => {
    const b = document.createElement('button');
    b.className = 'unit-action-btn' + (toggled?' toggled':'');
    b.textContent = label;
    if(onClick) b.addEventListener('click', onClick);
    bar.appendChild(b);
  };

  addBtn('🎯 Marschziel [G]', () => {
    awaitingWaypointClick = true;
    updateInfoPanel('Zielpunkt auf der Karte anklicken (auch außerhalb der Reichweite)...');
  }, awaitingWaypointClick);

  addBtn('🔁 Patrouille [P]', () => {
    awaitingPatrolStep = 1;
    patrolPointA = null;
    updateInfoPanel('Patrouille: ersten Wegpunkt anklicken...');
  }, awaitingPatrolStep>0);

  addBtn('💤 Rasten [R]', () => commandOrderState(u, 'resting'));
  addBtn('⏸ Warten [W]', () => commandOrderState(u, 'waiting'));
  addBtn('⏭ Pass [X]', () => commandPass(u));

  if(s.canDigIn && !u.dugIn && u.digPending!=='in'){
    addBtn('⛏ Befestigen [B]', () => commandFortify(u));
  }
  if(u.type==='infantry' && [T_PLAIN,T_FOREST,T_HILLS].includes(map[u.y][u.x].type)){
    addBtn('🛬 Flughafen bauen', () => {
      const tile = map[u.y][u.x];
      tile.type = T_AIRPORT;
      tile.owner = u.owner;
      updateInfoPanel('Flughafen errichtet — die Infanterie wurde dabei aufgelöst.');
      destroyUnit(u);
      finishUnitTurn(u);
    });
  }
  if(u.dugIn){
    addBtn('⛏ Ausgraben', () => {
      u.digPending = 'out';
      u.moved = true; u.movesLeft = 0; u.actedAtAll = true;
      updateInfoPanel('Gräbt sich aus — nächste Runde wieder beweglich.');
      finishUnitTurn(u);
    });
  }
  if(s.range > 0 && rangedTiles.length>0){
    addBtn('🎯 Fernkampf aktiv', null, true);
  }
  if(s.canDive){
    if(u.subLevel==='surface'){
      addBtn('🌊 Tauchen', () => {
        u.subLevel = 'deep';
        u.moved = true; u.movesLeft = 0; u.actedAtAll = true;
        updateInfoPanel('U-Boot taucht ab — nur noch von Boden-/U-Boot-Einheiten angreifbar.');
        finishUnitTurn(u);
      });
    } else {
      addBtn('⬆ Auftauchen', () => {
        u.subLevel = 'surface';
        u.moved = true; u.movesLeft = 0; u.actedAtAll = true;
        updateInfoPanel('U-Boot taucht auf.');
        finishUnitTurn(u);
      });
    }
  }
  if(u.cargo && u.cargo.length>0){
    for(const cid of u.cargo){
      const cu = units.find(x=>x.id===cid);
      if(!cu) continue;
      addBtn(`📦 Entladen: ${UNIT_STATS[cu.type].name}`, () => startUnload(u, cu));
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
        finishUnitTurn(unit);
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
      finishUnitTurn(unit);
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
      const def = pickDefenderAt(x,y,selectedUnit);
      if(def){
        const attackerSnap = snapshotUnit(selectedUnit);
        const defenderSnap = snapshotUnit(def.target);
        const res = resolveMeleeAttack(selectedUnit, def.target, def.noEntry);
        if(res.winner==='attacker'){
          const destTile = map[y][x];
          // Landeinheiten dürfen Wassereinheiten (und umgekehrt Schiffe Landfelder) nie
          // tatsächlich betreten, auch wenn sie den Kampf gewinnen — Angriff ja, Einzug nein.
          const canEnter = res.entered && terrainAllowed(destTile, selectedUnit);
          if(canEnter){
            selectedUnit.x = x; selectedUnit.y = y;
            if((destTile.type===T_CITY || destTile.type===T_AIRPORT) && destTile.owner!==selectedUnit.owner && stats.subclass==='land'){
              if(destTile.type===T_AIRPORT) destTile.owner = selectedUnit.owner;
              else captureCity(x,y, selectedUnit.owner, selectedUnit);
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
        playCombatSequence(attackerSnap, defenderSnap, () => finishUnitTurn(finishedUnit));
        return;
      }
      const survived = tryCaptureStructure(selectedUnit, x, y);
      const capturedType = map[y][x].type;
      if(survived){
        selectedUnit.x = x; selectedUnit.y = y;
        updateInfoPanel(capturedType===T_AIRPORT ? 'Flughafen erobert!' : 'Stadt erobert!');
      } else {
        updateInfoPanel('Angriff auf die Stadtverteidigung gescheitert — Einheit verloren!');
      }
      if(units.includes(selectedUnit)){ selectedUnit.moved = true; selectedUnit.movesLeft = 0; selectedUnit.actedAtAll = true; }
      finishUnitTurn(selectedUnit);
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

      if(hostAtDest && hostAtDest.cargo.length < UNIT_STATS[hostAtDest.type].portageCapacity){
        selectedUnit.hostId = hostAtDest.id;
        selectedUnit.orderState = null;
        selectedUnit.x = hostAtDest.x; selectedUnit.y = hostAtDest.y;
        selectedUnit.moved = true; selectedUnit.movesLeft = 0;
        hostAtDest.cargo.push(selectedUnit.id);
        updateInfoPanel(`${stats.name} an Bord von ${UNIT_STATS[hostAtDest.type].name} geladen.`);
      } else {
        selectedUnit.x = x; selectedUnit.y = y;
        const destTile = map[y][x];
        if((destTile.type===T_CITY || destTile.type===T_AIRPORT) && destTile.owner!==selectedUnit.owner){
          if(stats.subclass==='land'){
            const survived = tryCaptureStructure(selectedUnit, x, y);
            updateInfoPanel(survived
              ? (destTile.type===T_AIRPORT ? 'Flughafen erobert!' : 'Stadt erobert!')
              : 'Angriff auf die Stadtverteidigung gescheitert — Einheit verloren!');
          } else {
            updateInfoPanel('Angelegt – nur Landeinheiten erobern Städte.');
          }
        } else {
          refuelIfOnOwnCity(selectedUnit);
          updateInfoPanel(selectedUnit.movesLeft>0 ? `Bewegt — noch ${selectedUnit.movesLeft} Bewegungspunkt(e) übrig.` : 'Einheit bewegt.');
        }
      }
      if(units.includes(selectedUnit)) queueMoveAnim(selectedUnit, animFromX, animFromY);
      const movedUnit = selectedUnit;
      const stillSelectable = units.includes(movedUnit) && !movedUnit.moved;
      if(stillSelectable){
        deselect();
        selectUnit(movedUnit);
        checkGameOver(); updateHud();
      } else {
        finishUnitTurn(movedUnit);
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
    .filter(u=>u.owner===OWNER_PLAYER && (!u.moved || u.orderState || u.destination || u.patrol || u.dugIn))
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
  const cost = UNIT_STATS[tile.buildType].cost;
  const pct = Math.min(100, Math.floor(100 * tile.buildPoints / cost));
  document.getElementById('build-progress-label').textContent =
    `Baut: ${UNIT_STATS[tile.buildType].name} — ${tile.buildPoints}/${cost} (+${rate}/Runde)`;
  document.getElementById('build-progress-bar').style.width = pct + '%';

  document.getElementById('build-rally-label').textContent = tile.rallyPoint
    ? `Sammelpunkt: (${tile.rallyPoint.x}, ${tile.rallyPoint.y})`
    : 'Kein Sammelpunkt';
  document.getElementById('build-rally-clear-btn').classList.toggle('hidden', !tile.rallyPoint);

  const optionsDiv = document.getElementById('build-options');
  optionsDiv.innerHTML = '';
  for(const type of BUILD_ORDER){
    const stats = UNIT_STATS[type];
    const disabled = stats.subclass==='sea' && !coastal;
    const btn = document.createElement('button');
    btn.className = 'build-option' + (tile.buildType===type ? ' active' : '') + (disabled ? ' disabled' : '');
    const fuelStr = stats.fuel !== undefined ? `, Sprit ${stats.fuel}` : '';
    const rangeStr = stats.range>0 ? `, Reich ${stats.range}` : '';
    const portStr = stats.portageCapacity ? `, Fracht ${stats.portageCapacity}` : '';
    btn.innerHTML = `<span class="bo-name">${stats.label} ${stats.name}</span>` +
      `<span class="bo-stats">${disabled ? 'Nur in Küstenstädten (angrenzendes Wasser)' : `Bew ${stats.move} / Dmg ${stats.dmg} / Ang% ${stats.power} / Vert% ${stats.defense} / HP ${stats.hp}${rangeStr}${fuelStr}${portStr}`}</span>` +
      `<span class="bo-cost">${stats.cost}⚙</span>`;
    if(disabled){
      btn.disabled = true;
      btn.title = 'Nur in Küstenstädten verfügbar (angrenzendes Wasser nötig)';
    } else {
      btn.addEventListener('click', () => {
        tile.buildType = type;
        renderBuildPanel();
      });
    }
    optionsDiv.appendChild(btn);
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
  for(const type of BUILD_ORDER){
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
  const total = BUILD_ORDER.reduce((a,type)=>a+(weights[type]||0), 0);
  const r = Math.random() * total;
  let acc = 0;
  for(const type of BUILD_ORDER){
    acc += weights[type] || 0;
    if(r <= acc) return type;
  }
  return 'infantry';
}

function processCityProduction(owner){
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const tile = map[y][x];
      if(tile.type===T_CITY && tile.owner===owner){
        const rate = tile.capital ? CAPITAL_PRODUCTION : CITY_PRODUCTION;
        tile.buildPoints += rate;
        let type = tile.buildType || 'infantry';
        if(UNIT_STATS[type].subclass==='sea' && !isCoastal(x,y)){
          type = 'infantry';
          tile.buildType = 'infantry';
        }
        const cost = UNIT_STATS[type].cost;
        if(tile.buildPoints >= cost){
          // Städte fassen beliebig viele Einheiten — neue Einheiten spawnen direkt dort.
          const spawned = spawnUnit(owner, type, x, y);
          tile.buildPoints -= cost;
          if(owner!==OWNER_PLAYER) tile.buildType = pickAiBuildType(isCoastal(x,y));
          if(tile.rallyPoint && !(tile.rallyPoint.x===x && tile.rallyPoint.y===y)){
            setDestination(spawned, tile.rallyPoint.x, tile.rallyPoint.y, true);
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
      if((tile.type===T_CITY || tile.type===T_AIRPORT) && tile.owner===owner && u.hp < s.hp){
        u.hp = s.hp;
      }
    }
    if(u.digPending==='in'){ u.dugIn = true; u.digPending = null; }
    else if(u.digPending==='out'){ u.dugIn = false; u.digPending = null; }
    u.moved = false;
    u.movesLeft = isCrippled(u) ? Math.max(1, Math.floor(s.move/2)) : s.move;
    u.firedThisTurn = false;
    u.foughtThisTurn = false;
    u.actedAtAll = false;
  }
}

// Rasten/Warten-Stationsbefehle bei Rundenbeginn auswerten: bei Feindkontakt (oder für
// Rasten zusätzlich bei voller HP) wird die Einheit reaktiviert und dem Spieler zurückgegeben.
function processOrderStates(owner){
  for(const u of unitsOf(owner)){
    if(!u.orderState) continue;
    const enemyAdjacent = adjacentTiles(u.x,u.y).some(t => pickDefenderAt(t.x,t.y,u));
    const fullyHealed = u.orderState==='resting' && u.hp >= UNIT_STATS[u.type].hp;
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

/* ---------- KI ---------- */
function hostileTargetsFor(owner){
  const targets = [];
  for(const o of activeOwners()){
    if(o===owner) continue;
    citiesOf(o).forEach(c=>targets.push({x:c.x,y:c.y}));
  }
  citiesOf(OWNER_NEUTRAL).forEach(c=>targets.push({x:c.x,y:c.y}));
  units.filter(u=>u.owner!==owner && u.owner!==OWNER_NEUTRAL && u.hp>0 && !u.hostId)
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
    if(UNIT_STATS[u.type].subclass!=='sea') aiActUnit(u);
  }
  for(const u of myUnits()){
    if(UNIT_STATS[u.type].subclass==='sea') aiActShipPickup(u);
  }

  for(const u of unitsOf(owner)) advanceWaypoint(u);
  for(const u of unitsOf(owner)) advancePatrol(u);
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
        if((t.type===T_CITY || t.type===T_AIRPORT) && t.owner!==unit.owner && stats.subclass==='land'){
          if(t.type===T_AIRPORT) t.owner = unit.owner; else captureCity(a.x,a.y,unit.owner,unit);
        }
      }
      unit.moved = true; unit.movesLeft = 0;
      queueMoveAnim(unit, animFromX, animFromY);
      return;
    }
    const tile = map[a.y][a.x];
    if(unitsAt(a.x,a.y).length===0 && (tile.type===T_CITY || tile.type===T_AIRPORT) && tile.owner!==unit.owner && stats.subclass==='land'){
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
          if((t.type===T_CITY || t.type===T_AIRPORT) && t.owner!==unit.owner && stats.subclass==='land'){
            if(t.type===T_AIRPORT) t.owner = unit.owner; else captureCity(step.x, step.y, unit.owner, unit);
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
    if((t.type===T_CITY || t.type===T_AIRPORT) && t.owner!==unit.owner && stats.subclass==='land'){
      if(!tryCaptureStructure(unit, step.x, step.y)){ queueMoveAnim(unit, animFromX, animFromY); return; }
    }
  }
  unit.movesLeft = remaining;
  unit.moved = remaining<=0;
  unit.actedAtAll = true;
  queueMoveAnim(unit, animFromX, animFromY);
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
  document.getElementById('go-title').textContent = won ? 'SIEG!' : 'NIEDERLAGE';
  document.getElementById('go-title').style.color = won ? '#e0b84a' : '#f5473f';
  document.getElementById('go-text').textContent = text;
  document.getElementById('game-over').classList.remove('hidden');
}

/* ---------- HUD ---------- */
function updateHud(){
  document.getElementById('turn-indicator').textContent =
    `Runde ${turnNumber} — ${currentTurnOwner===OWNER_PLAYER ? 'Dein Zug' : ownerLabel(currentTurnOwner)+' zieht...'}`;
  const center = document.getElementById('hud-center');
  center.innerHTML = '';
  for(const o of activeOwners()){
    const chip = document.createElement('span');
    chip.className = 'hud-chip';
    const dead = isEliminated(o) ? ' (besiegt)' : '';
    chip.innerHTML = `<span class="hud-dot" style="background:${OWNER_COLORS[o]}"></span>${ownerLabel(o)}: <b>${citiesOf(o).length}</b> Städte / <b>${allUnitsOf(o).length}</b> Einh.${dead}`;
    center.appendChild(chip);
  }
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
}

function render(){
  if(map.length === 0) return;
  gctx.clearRect(0,0,gameCanvas.width, gameCanvas.height);
  if(fogEnabled) recomputeVisibility();

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

      gctx.fillStyle = (tile.type===T_CITY || tile.type===T_AIRPORT) ? '#1b2436' : TILE_COLORS[tile.type];
      gctx.fillRect(px,py,tsz,tsz);
      gctx.strokeStyle = 'rgba(0,0,0,0.25)';
      gctx.strokeRect(px,py,tsz,tsz);

      if(tile.road && tile.type!==T_CITY && tile.type!==T_AIRPORT){
        gctx.strokeStyle = 'rgba(224,184,74,0.55)';
        gctx.lineWidth = Math.max(1, tsz*0.08);
        gctx.beginPath();
        gctx.moveTo(px+tsz*0.1, py+tsz*0.5);
        gctx.lineTo(px+tsz*0.9, py+tsz*0.5);
        gctx.stroke();
      }

      if(tile.type===T_MOUNTAIN){
        gctx.fillStyle = '#6b6b76';
        gctx.beginPath();
        gctx.moveTo(px+tsz*0.5, py+tsz*0.18);
        gctx.lineTo(px+tsz*0.85, py+tsz*0.82);
        gctx.lineTo(px+tsz*0.15, py+tsz*0.82);
        gctx.closePath();
        gctx.fill();
      } else if(tile.type===T_FOREST){
        gctx.fillStyle = '#3f6b3f';
        gctx.beginPath(); gctx.arc(px+tsz*0.35, py+tsz*0.55, tsz*0.16, 0, Math.PI*2); gctx.fill();
        gctx.beginPath(); gctx.arc(px+tsz*0.62, py+tsz*0.4, tsz*0.16, 0, Math.PI*2); gctx.fill();
        gctx.beginPath(); gctx.arc(px+tsz*0.55, py+tsz*0.68, tsz*0.16, 0, Math.PI*2); gctx.fill();
      } else if(tile.type===T_HILLS){
        gctx.fillStyle = '#5a5a3e';
        gctx.beginPath(); gctx.arc(px+tsz*0.4, py+tsz*0.62, tsz*0.22, Math.PI, 0); gctx.fill();
        gctx.beginPath(); gctx.arc(px+tsz*0.68, py+tsz*0.62, tsz*0.18, Math.PI, 0); gctx.fill();
      }

      if(tile.type===T_CITY){
        const color = OWNER_COLORS[tile.owner] || OWNER_COLORS[OWNER_NEUTRAL];
        gctx.fillStyle = color;
        const pad = tsz*0.2;
        gctx.fillRect(px+pad, py+pad*0.6, tsz-2*pad, tsz-2*pad*0.6);
        gctx.fillStyle = '#0a0e14';
        gctx.font = `${Math.floor(tsz*0.4)}px monospace`;
        gctx.textAlign = 'center';
        gctx.textBaseline = 'middle';
        gctx.fillText(tile.capital ? '★' : '●', px+tsz/2, py+tsz/2+2);

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

  // Kampf-Blinken: pulsierender Rahmen um beide Kampfteilnehmer (Spieleraktionen, siehe
  // playCombatSequence) — bewusst als reiner Rahmen statt Geister-Sprite, damit es auch
  // funktioniert, wenn sich Angreifer/Verteidiger-Position durch den Kampf ändert.
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

  gctx.save();
  if(isDeep) gctx.globalAlpha = 0.55;

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

  const maxHp = s.hp;
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

  if((u.moved || u.orderState || u.destination || u.patrol || u.dugIn) && u.owner===OWNER_PLAYER){
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
  const sizeCfg = SIZE_PRESETS[mapConfig.size] || SIZE_PRESETS.medium;
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

function serializeGame(){
  return {
    version: 1,
    savedAt: Date.now(),
    mapConfig: JSON.parse(JSON.stringify(mapConfig)),
    COLS, ROWS,
    map, units, unitIdCounter,
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
    alert('Speichern fehlgeschlagen: ' + e.message);
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
  map = data.map;
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

  selectedUnit = null;
  reachableTiles = []; attackableTiles = []; rangedTiles = []; rangeRadiusTiles = []; unloadTiles = [];
  unloadingCargoUnit = null;
  awaitingWaypointClick = false; awaitingPatrolStep = 0; patrolPointA = null; awaitingRallyClick = null;
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

/* ---------- TITELBILDSCHIRM ---------- */
const titleCanvas = document.getElementById('title-canvas');
const tctx = titleCanvas.getContext('2d');
let titleTime = 0;

function drawTitleBackground(){
  const w = titleCanvas.width, h = titleCanvas.height;
  tctx.clearRect(0,0,w,h);
  tctx.fillStyle = '#0a0e14';
  tctx.fillRect(0,0,w,h);
  for(let i=0;i<80;i++){
    const sx = (i*97 + titleTime*2) % w;
    const sy = (i*53) % h;
    const tw = 0.5 + 0.5*Math.sin(titleTime*0.05 + i);
    tctx.fillStyle = `rgba(224,184,74,${0.15+0.25*tw})`;
    tctx.fillRect(sx, sy, 2, 2);
  }
  tctx.fillStyle = '#16233d';
  for(let i=0;i<6;i++){
    const bx = 60 + i*140 + Math.sin(titleTime*0.02+i)*4;
    const by = h - 40;
    tctx.fillRect(bx, by, 46, 18);
    tctx.fillRect(bx+10, by-12, 22, 14);
    tctx.beginPath();
    tctx.arc(bx+14, by+18, 8, 0, Math.PI*2);
    tctx.arc(bx+34, by+18, 8, 0, Math.PI*2);
    tctx.fill();
  }
  titleTime++;
  requestAnimationFrame(drawTitleBackground);
}
drawTitleBackground();

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
