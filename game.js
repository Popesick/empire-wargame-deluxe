'use strict';

/* =========================================================
   EMPIRE: WARGAME DELUXE
   Rundenbasiertes Strategiespiel im Empire-Stil.

   Umgesetztes "Kernpaket" der Originalregeln:
   - Terrain-Bewegungskosten & Straßen
   - Welt-Ebenen (Luft / Boden / U-Boot-Tiefe) mit Stapel- &
     Ziel-Prioritätsregeln
   - Kill-, Capture- und Bombard-/Fernkampf mit
     wahrscheinlichkeitsbasierten Kampfrunden
   - Angeschlagen (crippled) & Reparatur, Eingraben (Dig-in)
   - Effektivität (Fresh..Exhausted) & Erfahrung (Green..Hardened)
   - Transport: Laden/Entladen von Bodeneinheiten auf Zerstörern
   - Defensivfeuer (vereinfacht, siehe Kommentare)

   Bewusst NICHT umgesetzt (siehe Chat-Zusammenfassung):
   Wetter, Verträge/Diplomatie, Ressourcen-Drain &
   Produktionseffizienz-Kurven, Orbital-Einheiten/Atomwaffen,
   Minen, Sichtbarkeits-/Explorationsmodi, Gifting/PBM,
   alternative Sieg-Bedingungen, Konstruktion durch Pioniere.
   ========================================================= */

/* ---------- AUDIO: prozeduraler Chiptune-Loop ---------- */
const MusicEngine = (() => {
  let ctx = null;
  let playing = false;
  let muted = false;
  let nextNoteTime = 0;
  let noteIndex = 0;

  const bassLine = [98.00, 98.00, 110.00, 87.31, 98.00, 98.00, 73.42, 82.41];
  const melody = [
    392.00, 466.16, 523.25, 466.16, 392.00, 349.23, 392.00, 0,
    440.00, 523.25, 587.33, 523.25, 440.00, 392.00, 440.00, 0
  ];
  const tempo = 0.16;

  function ensureCtx(){
    if(!ctx){
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if(ctx.state === 'suspended') ctx.resume();
  }

  function playTone(freq, time, dur, type, gainVal){
    if(freq <= 0) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(gainVal, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  }

  function scheduler(){
    while(nextNoteTime < ctx.currentTime + 0.2){
      if(!muted){
        const bassFreq = bassLine[noteIndex % bassLine.length];
        const melFreq = melody[noteIndex % melody.length];
        playTone(bassFreq, nextNoteTime, tempo * 0.9, 'triangle', 0.09);
        playTone(melFreq, nextNoteTime, tempo * 0.8, 'square', 0.045);
      }
      nextNoteTime += tempo;
      noteIndex++;
    }
    setTimeout(scheduler, 50);
  }

  return {
    start(){
      ensureCtx();
      if(playing) return;
      playing = true;
      nextNoteTime = ctx.currentTime + 0.05;
      scheduler();
    },
    toggleMute(){
      muted = !muted;
      return muted;
    },
    isMuted(){ return muted; }
  };
})();

/* ---------- KONSTANTEN ---------- */
// COLS/ROWS sind veränderlich: die Kartenoptionen (Größe) setzen sie vor
// generateMap() neu. Alle anderen Konstanten bleiben fix.
let COLS = 26, ROWS = 17;
const BASE_TILE = 48;
const MIN_ZOOM = 0.5, MAX_ZOOM = 2.2;
const DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

const SIZE_PRESETS = {
  small:  { cols:18, rows:12 },
  medium: { cols:26, rows:17 },
  large:  { cols:34, rows:22 }
};
const WATER_LEVEL = { dry:0, normal:1, wet:2 };
const CITY_TILES_PER_CITY = { sparse:70, normal:44, dense:28 };

let mapConfig = { size:'medium', water:'normal', cities:'normal' };

const T_PLAIN = 'plain';
const T_FOREST = 'forest';
const T_HILLS = 'hills';
const T_MOUNTAIN = 'mountain';
const T_WATER = 'water';
const T_CITY = 'city';

const MOVE_COST = { [T_PLAIN]:1, [T_FOREST]:2, [T_HILLS]:2, [T_MOUNTAIN]:3, [T_WATER]:1, [T_CITY]:1 };
const TERRAIN_NAME = { [T_PLAIN]:'Ebene', [T_FOREST]:'Wald', [T_HILLS]:'Hügel', [T_MOUNTAIN]:'Gebirge', [T_WATER]:'Wasser', [T_CITY]:'Stadt' };

const OWNER_PLAYER = 'player';
const OWNER_AI = 'ai';
const OWNER_NEUTRAL = 'neutral';

const EFFECTIVENESS = ['fresh','rested','ready','used','tired','exhausted'];
const EFFECTIVENESS_NAME = { fresh:'Frisch', rested:'Ausgeruht', ready:'Bereit', used:'Beansprucht', tired:'Müde', exhausted:'Erschöpft' };
const EXPERIENCE = ['green','proven','hardened'];
const EXPERIENCE_NAME = { green:'Grün', proven:'Erprobt', hardened:'Abgehärtet' };
const EXPERIENCE_CAP = { green:2, proven:1, hardened:0 }; // Index in EFFECTIVENESS, das maximal erreichbar ist
const EXPERIENCE_WINS_NEEDED = { proven:3, hardened:6 };

// Werte grob am Original "Empire" orientiert (eigene, angepasste Balance).
// power/defense sind Wahrscheinlichkeits-Faktoren (Trefferchance je
// Kampfrunde), dmg ist der Schaden pro Treffer, hp die Trefferpunkte.
const UNIT_STATS = {
  infantry:   { name:'Infanterie', label:'I', category:'ground', subclass:'land', move:3, dmg:1, power:50, defense:50, hp:3, cost:10, range:0, canDigIn:true },
  tank:       { name:'Panzer',     label:'T', category:'ground', subclass:'land', move:6, dmg:2, power:65, defense:55, hp:5, cost:20, range:0, canDigIn:true, captureMorph:'infantry' },
  artillery:  { name:'Artillerie', label:'A', category:'ground', subclass:'land', move:3, dmg:2, power:55, defense:35, hp:3, cost:18, range:2, canDigIn:true, canDefensiveFire:true },
  destroyer:  { name:'Zerstörer',  label:'D', category:'ground', subclass:'sea',  move:6, dmg:2, power:60, defense:50, hp:6, cost:22, range:2, canDefensiveFire:true, portageCapacity:2, canCarry:['infantry','tank','artillery'] },
  submarine:  { name:'U-Boot',     label:'U', category:'ground', subclass:'sea',  move:5, dmg:2, power:70, defense:30, hp:4, cost:24, range:0, canDive:true },
  helicopter: { name:'Helikopter', label:'H', category:'air',    subclass:null,   move:6, dmg:1, power:50, defense:40, hp:3, cost:18, range:0, noMountain:true },
  fighter:    { name:'Jäger',      label:'F', category:'air',    subclass:null,   move:10,dmg:1, power:60, defense:30, hp:2, cost:25, range:0, fuel:8, canBomb:true }
};
const BUILD_ORDER = ['infantry','tank','artillery','destroyer','submarine','helicopter','fighter'];

const CITY_PRODUCTION = 3;
const CAPITAL_PRODUCTION = 5;

const LEVEL_TARGETS = {
  air:    ['air','ground'],
  ground: ['air','ground','sub'],
  sub:    ['ground','sub']
};

/* ---------- SPIELZUSTAND ---------- */
let map = [];
let units = [];
let unitIdCounter = 1;
let currentTurnOwner = OWNER_PLAYER;
let turnNumber = 1;
let selectedUnit = null;
let reachableTiles = [];
let attackableTiles = [];
let rangedTiles = [];
let unloadTiles = [];
let unloadingCargoUnit = null;
let gameOver = false;
let selectedBuildCity = null;

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

/* ---------- KARTE GENERIEREN ---------- */
function inBounds(x,y){ return x>=0 && x<COLS && y>=0 && y<ROWS; }

function newTile(type){
  return { type, owner:null, buildPoints:0, buildType:'infantry', capital:false, road:false };
}

function generateMap(){
  map = [];
  for(let y=0;y<ROWS;y++){
    const row = [];
    for(let x=0;x<COLS;x++){
      const r = Math.random();
      let type = T_PLAIN;
      if(r < 0.08) type = T_MOUNTAIN;
      else if(r < 0.18) type = T_FOREST;
      else if(r < 0.28) type = T_HILLS;
      row.push(newTile(type));
    }
    map.push(row);
  }

  // See(n): Anzahl & Größe richten sich nach den Kartenoptionen. "Trocken" erzeugt
  // gar kein Wasser (reine Landkarte, Küsten-Einheiten dann nicht baubar).
  const waterLevel = WATER_LEVEL[mapConfig.water] !== undefined ? WATER_LEVEL[mapConfig.water] : 1;
  const lakeCount = waterLevel;
  const stepsPerLake = Math.round(COLS*ROWS * (waterLevel===2 ? 0.11 : 0.08));
  for(let L=0; L<lakeCount; L++){
    let lx = 4 + Math.floor(Math.random()*Math.max(1,COLS-8));
    let ly = 4 + Math.floor(Math.random()*Math.max(1,ROWS-8));
    for(let i=0;i<stepsPerLake;i++){
      if(inBounds(lx,ly)) map[ly][lx].type = T_WATER;
      const dir = DIRS8[Math.floor(Math.random()*4)]; // nur orthogonal für kompaktere Form
      lx = Math.min(COLS-4, Math.max(3, lx+dir[0]));
      ly = Math.min(ROWS-4, Math.max(3, ly+dir[1]));
    }
  }

  // Nur Gebirge um eine Stadt herum einebnen (sonst könnte sie eingeschlossen sein) —
  // Wasser bewusst NICHT anfassen, sonst können Städte nie an der Küste liegen.
  const clearArea = (cx, cy) => {
    for(let dy=-1; dy<=1; dy++){
      for(let dx=-1; dx<=1; dx++){
        const x=cx+dx, y=cy+dy;
        if(inBounds(x,y) && map[y][x].type===T_MOUNTAIN) map[y][x].type = T_PLAIN;
      }
    }
  };

  const playerCap = {x:1, y:1};
  const aiCap = {x:COLS-2, y:ROWS-2};
  clearArea(playerCap.x, playerCap.y);
  clearArea(aiCap.x, aiCap.y);
  map[playerCap.y][playerCap.x] = Object.assign(newTile(T_CITY), { owner: OWNER_PLAYER, capital:true });
  map[aiCap.y][aiCap.x] = Object.assign(newTile(T_CITY), { owner: OWNER_AI, capital:true });

  const cityList = [{x:playerCap.x,y:playerCap.y}, {x:aiCap.x,y:aiCap.y}];
  const tilesPerCity = CITY_TILES_PER_CITY[mapConfig.cities] !== undefined ? CITY_TILES_PER_CITY[mapConfig.cities] : 44;
  const neutralCount = Math.max(4, Math.min(40, Math.round((COLS*ROWS) / tilesPerCity)));
  let placed = 0, attempts = 0;
  while(placed < neutralCount && attempts < 2000){
    attempts++;
    const x = 2 + Math.floor(Math.random() * (COLS-4));
    const y = 2 + Math.floor(Math.random() * (ROWS-4));
    if(map[y][x].type === T_WATER) continue;
    const distP = Math.abs(x-playerCap.x) + Math.abs(y-playerCap.y);
    const distA = Math.abs(x-aiCap.x) + Math.abs(y-aiCap.y);
    if(distP < 4 || distA < 4) continue;
    let tooClose = false;
    for(const c of cityList) if(Math.abs(c.x-x)+Math.abs(c.y-y) < 3) tooClose = true;
    if(tooClose) continue;
    clearArea(x,y);
    map[y][x] = Object.assign(newTile(T_CITY), { owner: OWNER_NEUTRAL });
    cityList.push({x,y});
    placed++;
  }

  // Garantie: Wenn Wasser existiert, aber (Zufallspech) keine einzige Stadt daran liegt,
  // eine zusätzliche Küstenstadt erzwingen — sonst sind Zerstörer/U-Boote nirgends baubar.
  if(lakeCount > 0 && !cityList.some(c => isCoastal(c.x,c.y))){
    let bestSpot = null, bestScore = Infinity, coastAttempts = 0;
    while(coastAttempts < 400){
      coastAttempts++;
      const x = 2 + Math.floor(Math.random() * (COLS-4));
      const y = 2 + Math.floor(Math.random() * (ROWS-4));
      if(map[y][x].type === T_WATER || map[y][x].type === T_CITY) continue;
      if(!isCoastal(x,y)) continue;
      const distP = Math.abs(x-playerCap.x) + Math.abs(y-playerCap.y);
      const distA = Math.abs(x-aiCap.x) + Math.abs(y-aiCap.y);
      if(distP < 4 || distA < 4) continue;
      let tooClose = false;
      for(const c of cityList) if(Math.abs(c.x-x)+Math.abs(c.y-y) < 3) tooClose = true;
      if(tooClose) continue;
      const score = Math.random();
      if(score < bestScore){ bestScore = score; bestSpot = {x,y}; }
      if(bestSpot) break;
    }
    if(bestSpot){
      clearArea(bestSpot.x, bestSpot.y);
      map[bestSpot.y][bestSpot.x] = Object.assign(newTile(T_CITY), { owner: OWNER_NEUTRAL });
      cityList.push(bestSpot);
    }
  }

  // Straßennetz: jede Stadt mit ihrer nächsten Nachbarstadt verbinden (nur über Land)
  for(const c of cityList){
    let nearest = null, bestD = Infinity;
    for(const o of cityList){
      if(o===c) continue;
      const d = Math.abs(o.x-c.x)+Math.abs(o.y-c.y);
      if(d < bestD){ bestD = d; nearest = o; }
    }
    if(nearest) buildRoadPath(c, nearest);
  }

  return { playerCap, aiCap };
}

function buildRoadPath(a, b){
  let x = a.x, y = a.y;
  const markRoad = (px,py) => { if(inBounds(px,py) && map[py][px].type!==T_WATER) map[py][px].road = true; };
  markRoad(x,y);
  while(x !== b.x){
    x += x < b.x ? 1 : -1;
    markRoad(x,y);
  }
  while(y !== b.y){
    y += y < b.y ? 1 : -1;
    markRoad(x,y);
  }
}

/* ---------- EINHEITEN ---------- */
function spawnUnit(owner, type, x, y){
  const stats = UNIT_STATS[type];
  const u = {
    id: unitIdCounter++,
    owner, type,
    x, y,
    hp: stats.hp,
    moved: false,
    firedThisTurn: false,
    actedAtAll: false,
    foughtThisTurn: false,
    fuel: stats.fuel !== undefined ? stats.fuel : null,
    dugIn: false,
    digPending: null, // 'in' | 'out' | null
    subLevel: stats.subclass==='sea' && type==='submarine' ? 'surface' : null,
    effectiveness: EXPERIENCE_CAP.green, // Index in EFFECTIVENESS ('ready')
    experience: 'green',
    xpWins: 0,
    hostId: null,
    cargo: stats.portageCapacity ? [] : null
  };
  units.push(u);
  return u;
}

function unitsAt(x,y){
  return units.filter(u => u.x===x && u.y===y && u.hp>0 && !u.hostId);
}
function unitAtLevel(x,y,level){
  return units.find(u => u.x===x && u.y===y && u.hp>0 && !u.hostId && getLevel(u)===level);
}
function unitsOf(owner){
  return units.filter(u => u.owner===owner && u.hp>0 && !u.hostId);
}
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

/* ---------- TERRAIN / BEWEGUNG ---------- */
// Küstenstadt = mind. ein orthogonal angrenzendes Wasserfeld (nur See-/U-Boot-Einheiten
// dürfen dort produziert werden).
function isCoastal(x,y){
  return [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => {
    const nx=x+dx, ny=y+dy;
    return inBounds(nx,ny) && map[ny][nx].type===T_WATER;
  });
}

function terrainAllowed(tile, unit){
  const s = UNIT_STATS[unit.type];
  if(s.category==='air'){
    if(s.noMountain && tile.type===T_MOUNTAIN) return false;
    return true;
  }
  if(unit.subLevel==='deep') return tile.type===T_WATER;
  if(s.subclass==='sea') return tile.type===T_WATER || tile.type===T_CITY;
  // land
  return tile.type !== T_WATER;
}

function terrainCost(tile, unit){
  const s = UNIT_STATS[unit.type];
  if(s.category==='air') return 1;
  if(tile.road) return 1;
  return MOVE_COST[tile.type];
}

// Ausnahme "kann ansonsten unpassierbares Terrain betreten, um an Bord zu gehen"
function findLoadHost(unit, x, y){
  const s = UNIT_STATS[unit.type];
  if(s.subclass !== 'land') return null;
  const host = units.find(o => o.x===x && o.y===y && o.hp>0 && !o.hostId && o.owner===unit.owner &&
    UNIT_STATS[o.type].canCarry && UNIT_STATS[o.type].canCarry.includes(unit.type) && getLevel(o)==='ground');
  if(host && host.cargo.length < UNIT_STATS[host.type].portageCapacity) return host;
  return null;
}

// Prüft, ob 'unit' das Ebenen-Slot von (x,y) betreten kann.
// Rückgabe: true = frei, 'combat' = Gegner blockiert (Kampfziel), false = belegt/kein Platz
function slotStatus(x,y,unit){
  const lvl = getLevel(unit);
  const occupants = units.filter(u => u.x===x && u.y===y && u.hp>0 && !u.hostId && getLevel(u)===lvl);
  const enemy = occupants.find(o => o.owner!==unit.owner);
  if(enemy) return 'combat';
  if(lvl==='ground'){
    const cap = map[y][x].road ? 2 : 1;
    return occupants.length < cap;
  }
  return occupants.length < 1;
}

function computeReachable(unit){
  const stats = UNIT_STATS[unit.type];
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
      if(nd > stats.move) continue;
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

function computePathTowards(unit, target){
  const stats = UNIT_STATS[unit.type];
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
  return defender.effectiveness - attacker.effectiveness; // positiv = Verteidiger schlechter -> Angreifer im Vorteil
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
    for(const cid of u.cargo){
      units = units.filter(x => x.id!==cid);
    }
  }
}

// Nahkampf durch Bewegung (Kill/Capture Combat). Gibt {outcome, log} zurück.
function resolveMeleeAttack(attacker, defender, noEntry){
  attacker.foughtThisTurn = true;
  defender.foughtThisTurn = true;
  const attackerCrippled = isCrippled(attacker);
  let rounds = 0;
  while(attacker.hp>0 && defender.hp>0 && rounds<200){
    rounds++;
    const chance = hitChance(attacker, defender, attackerCrippled);
    const roll = Math.random()*100;
    if(roll < chance){
      defender.hp -= UNIT_STATS[attacker.type].dmg;
    } else {
      attacker.hp -= UNIT_STATS[defender.type].dmg;
    }
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

// Fernkampf (Bombard/Range Kill): Angreifer nimmt nie Schaden, Serie endet beim ersten Fehlschuss.
function resolveRangedAttack(attacker, defender){
  attacker.firedThisTurn = true;
  attacker.moved = true;
  attacker.actedAtAll = true;
  attacker.foughtThisTurn = true;
  const attackerCrippled = isCrippled(attacker);
  let hitAny = false;
  while(defender.hp>0){
    const chance = hitChance(attacker, defender, attackerCrippled);
    const roll = Math.random()*100;
    if(roll < chance){
      defender.hp -= UNIT_STATS[attacker.type].dmg;
      hitAny = true;
    } else {
      break;
    }
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
  const stats = UNIT_STATS[capturingUnit.type];
  if(stats.captureMorph && capturingUnit.hp >= stats.hp){
    // Panzer, der eine Stadt bei voller Stärke erobert, wird zu Infanterie "verbraucht"
    destroyUnit(capturingUnit);
    spawnUnit(owner, stats.captureMorph, x, y);
  }
}

/* ---------- BILD: WER DARF WEN ANGREIFEN ---------- */
function pickDefenderAt(x,y, attacker){
  const attackerLevel = getLevel(attacker);
  const allowedLevels = LEVEL_TARGETS[attackerLevel];
  const occupantsByLevel = { air:null, ground:null, sub:null };
  for(const u of units){
    if(u.x===x && u.y===y && u.hp>0 && !u.hostId){
      occupantsByLevel[getLevel(u)] = u;
    }
  }
  // Luftpriorität: wenn ein feindliches Luftziel da ist und angreifbar, muss dieses zuerst bekämpft werden
  if(occupantsByLevel.air && occupantsByLevel.air.owner!==attacker.owner && allowedLevels.includes('air')){
    return { target: occupantsByLevel.air, noEntry: true };
  }
  if(occupantsByLevel.ground && occupantsByLevel.ground.owner!==attacker.owner && allowedLevels.includes('ground')){
    return { target: occupantsByLevel.ground, noEntry: false };
  }
  if(occupantsByLevel.sub && occupantsByLevel.sub.owner!==attacker.owner && allowedLevels.includes('sub')){
    return { target: occupantsByLevel.sub, noEntry: false };
  }
  return null;
}

/* ---------- SPIELERZUG: AUSWAHL & HIGHLIGHTS ---------- */
function selectUnit(u){
  selectedUnit = u;
  closeBuildPanel();
  unloadingCargoUnit = null;
  const reach = u.dugIn ? { tiles: [], dist: { [key(u.x,u.y)]: 0 } } : computeReachable(u);
  reachableTiles = reach.tiles;
  attackableTiles = [];
  rangedTiles = [];
  unloadTiles = [];
  const stats = UNIT_STATS[u.type];
  const attackerLevel = getLevel(u);

  // Angriffsziele: jedes Feld, das von IRGENDEINER innerhalb der Bewegungsreichweite
  // erreichbaren Position aus angrenzt (nicht nur von der Startposition) — ein Panzer
  // mit Bewegung 6 kann sich also 5 Felder nähern und im selben Zug noch angreifen.
  const origins = [{x:u.x,y:u.y,d:0}, ...reachableTiles.map(t=>({x:t.x,y:t.y,d:reach.dist[key(t.x,t.y)]}))];
  const seenAttack = new Set();
  for(const o of origins){
    for(const t of adjacentTiles(o.x,o.y)){
      const tk = key(t.x,t.y);
      if(seenAttack.has(tk)) continue;
      const def = pickDefenderAt(t.x,t.y,u);
      if(def){
        const entryCost = o.d + terrainCost(map[t.y][t.x], u);
        if(entryCost <= stats.move){ attackableTiles.push(t); seenAttack.add(tk); }
        continue;
      }
      const tile = map[t.y][t.x];
      const occ = unitsAt(t.x,t.y);
      if(occ.length===0 && tile.type===T_CITY && tile.owner!==u.owner && stats.subclass==='land'){
        attackableTiles.push(t);
        seenAttack.add(tk);
      }
    }
  }

  if(stats.range > 0 && !u.moved){
    for(let dy=-stats.range; dy<=stats.range; dy++){
      for(let dx=-stats.range; dx<=stats.range; dx++){
        if(dx===0 && dy===0) continue;
        if(Math.max(Math.abs(dx),Math.abs(dy)) > stats.range) continue;
        const nx=u.x+dx, ny=u.y+dy;
        if(!inBounds(nx,ny)) continue;
        const def = pickDefenderAt(nx,ny,u);
        if(def) rangedTiles.push({x:nx,y:ny});
      }
    }
  }

  renderUnitActions();
  updateSelectionInfo();
  render();
}

function updateSelectionInfo(){
  if(!selectedUnit){ updateInfoPanel('Wähle eine Einheit aus, um sie zu bewegen oder anzugreifen.'); return; }
  const u = selectedUnit, s = UNIT_STATS[u.type];
  let parts = [`${s.name} ausgewählt`, `HP ${u.hp}/${s.hp}`, effName(u), EXPERIENCE_NAME[u.experience]];
  if(s.fuel !== undefined) parts.push(`Sprit ${u.fuel}/${s.fuel}`);
  if(u.dugIn) parts.push('Eingegraben');
  if(isCrippled(u)) parts.push('Angeschlagen');
  if(u.subLevel==='deep') parts.push('Getaucht');
  if(u.cargo && u.cargo.length) parts.push(`Fracht ${u.cargo.length}/${s.portageCapacity}`);
  updateInfoPanel(parts.join(' | ') + '. Blau=Bewegen, Rot=Angriff/Erobern, Orange=Fernkampf.');
}

function deselect(){
  selectedUnit = null;
  reachableTiles = [];
  attackableTiles = [];
  rangedTiles = [];
  unloadTiles = [];
  unloadingCargoUnit = null;
  renderUnitActions();
  render();
}

/* ---------- AKTIONSLEISTE (Eingraben, Fernkampf, Tauchen, Entladen) ---------- */
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
    b.addEventListener('click', onClick);
    bar.appendChild(b);
  };

  if(s.canDigIn && !u.dugIn && u.digPending!=='in'){
    addBtn('⛏ Eingraben', () => {
      u.digPending = 'in';
      u.moved = true; u.actedAtAll = true;
      updateInfoPanel('Gräbt sich ein — wird nächste Runde wirksam.');
      deselect(); updateHud();
    });
  }
  if(u.dugIn){
    addBtn('⛏ Ausgraben', () => {
      u.digPending = 'out';
      u.moved = true; u.actedAtAll = true;
      updateInfoPanel('Gräbt sich aus — nächste Runde wieder beweglich.');
      deselect(); updateHud();
    });
  }
  if(s.range > 0 && rangedTiles.length>0){
    addBtn('🎯 Fernkampf aktiv', null, true);
  }
  if(s.canDive){
    if(u.subLevel==='surface'){
      addBtn('🌊 Tauchen', () => {
        u.subLevel = 'deep';
        u.moved = true; u.actedAtAll = true;
        updateInfoPanel('U-Boot taucht ab — nur noch von Boden-/U-Boot-Einheiten angreifbar.');
        deselect(); updateHud();
      });
    } else {
      addBtn('⬆ Auftauchen', () => {
        u.subLevel = 'surface';
        u.moved = true; u.actedAtAll = true;
        updateInfoPanel('U-Boot taucht auf.');
        deselect(); updateHud();
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

function startUnload(hostUnit, cargoUnit){
  unloadingCargoUnit = { host: hostUnit, cargo: cargoUnit };
  unloadTiles = adjacentTiles(hostUnit.x, hostUnit.y).filter(t => {
    const tile = map[t.y][t.x];
    if(!terrainAllowed(tile, cargoUnit)) return false;
    return slotStatus(t.x,t.y,cargoUnit) === true;
  });
  reachableTiles = []; attackableTiles = []; rangedTiles = [];
  updateInfoPanel(`Entladeziel für ${UNIT_STATS[cargoUnit.type].name} wählen (markierte Felder).`);
  render();
}

/* ---------- MAUS-STEUERUNG ---------- */
let isDragging = false, dragMoved = false;
let dragStart = {x:0,y:0}, camStart = {x:0,y:0};
const DRAG_THRESHOLD = 6;

gameCanvas.addEventListener('mousedown', (evt) => {
  if(evt.button !== 0) return;
  isDragging = true;
  dragMoved = false;
  dragStart = {x:evt.clientX, y:evt.clientY};
  camStart = {x:camera.x, y:camera.y};
});

window.addEventListener('mousemove', (evt) => {
  if(!isDragging) return;
  const dx = evt.clientX - dragStart.x;
  const dy = evt.clientY - dragStart.y;
  if(Math.hypot(dx,dy) > DRAG_THRESHOLD) dragMoved = true;
  if(dragMoved){
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
  if(!dragMoved){
    const rect = gameCanvas.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (gameCanvas.width/rect.width);
    const sy = (evt.clientY - rect.top) * (gameCanvas.height/rect.height);
    if(sx>=0 && sy>=0 && sx<=gameCanvas.width && sy<=gameCanvas.height){
      handleGameClick(sx, sy);
    }
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
  const panStep = 60 / camera.zoom;
  if(evt.key==='ArrowLeft'){ camera.x -= panStep; clampCamera(); render(); }
  else if(evt.key==='ArrowRight'){ camera.x += panStep; clampCamera(); render(); }
  else if(evt.key==='ArrowUp'){ camera.y -= panStep; clampCamera(); render(); }
  else if(evt.key==='ArrowDown'){ camera.y += panStep; clampCamera(); render(); }
  else if(evt.key==='+' || evt.key==='='){ zoomAt(1.2, gameCanvas.width/2, gameCanvas.height/2); }
  else if(evt.key==='-'){ zoomAt(1/1.2, gameCanvas.width/2, gameCanvas.height/2); }
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
  if(gameOver) return;
  const world = screenToWorld(sx, sy);
  const x = Math.floor(world.x / BASE_TILE);
  const y = Math.floor(world.y / BASE_TILE);
  if(!inBounds(x,y)) return;
  if(currentTurnOwner !== OWNER_PLAYER) return;

  // Entlade-Modus hat Vorrang
  if(unloadingCargoUnit){
    if(unloadTiles.some(t=>t.x===x && t.y===y)){
      const { host, cargo } = unloadingCargoUnit;
      cargo.x = x; cargo.y = y;
      cargo.hostId = null;
      cargo.moved = true; cargo.actedAtAll = true;
      host.cargo = host.cargo.filter(id=>id!==cargo.id);
      updateInfoPanel(`${UNIT_STATS[cargo.type].name} entladen.`);
      unloadingCargoUnit = null; unloadTiles = [];
      deselect();
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

    // Fernkampf
    if(rangedTiles.some(t=>t.x===x && t.y===y)){
      const def = pickDefenderAt(x,y,selectedUnit);
      if(def){
        const res = resolveRangedAttack(selectedUnit, def.target);
        MusicEngine.start();
        updateInfoPanel(res.destroyed ? 'Ziel durch Fernkampf zerstört!' : (res.hitAny ? 'Treffer, Ziel überlebt.' : 'Fernkampf verfehlt.'));
        deselect();
        checkGameOver(); updateHud();
        return;
      }
    }

    // Nahkampf / Erobern
    if(attackableTiles.some(t=>t.x===x && t.y===y)){
      const def = pickDefenderAt(x,y,selectedUnit);
      if(def){
        const res = resolveMeleeAttack(selectedUnit, def.target, def.noEntry);
        MusicEngine.start();
        if(res.winner==='attacker'){
          if(res.entered){
            selectedUnit.x = x; selectedUnit.y = y;
            const destTile = map[y][x];
            if(destTile.type===T_CITY && destTile.owner!==selectedUnit.owner && stats.subclass==='land'){
              captureCity(x,y, selectedUnit.owner, selectedUnit);
            }
            updateInfoPanel('Gegner besiegt, Feld eingenommen!');
          } else {
            updateInfoPanel('Luftziel zerstört — Feld bleibt umkämpft.');
          }
          if(units.includes(selectedUnit)){ selectedUnit.moved = true; selectedUnit.actedAtAll = true; }
        } else {
          updateInfoPanel('Eigene Einheit im Kampf verloren!');
        }
      } else {
        // leere Stadt erobern
        selectedUnit.x = x; selectedUnit.y = y;
        captureCity(x,y, selectedUnit.owner, selectedUnit);
        updateInfoPanel('Stadt erobert!');
        if(units.includes(selectedUnit)){ selectedUnit.moved = true; selectedUnit.actedAtAll = true; }
      }
      deselect();
      checkGameOver(); updateHud();
      return;
    }

    // Bewegen (inkl. Laden auf Zerstörer)
    if(reachableTiles.some(t=>t.x===x && t.y===y)){
      const hostAtDest = units.find(o => o.x===x && o.y===y && o.hp>0 && o.owner===selectedUnit.owner &&
        UNIT_STATS[o.type].canCarry && UNIT_STATS[o.type].canCarry.includes(selectedUnit.type) && getLevel(o)==='ground' && stats.subclass==='land');
      selectedUnit.moved = true; selectedUnit.actedAtAll = true;
      if(hostAtDest && map[y][x].type===T_WATER){
        const cap = UNIT_STATS[hostAtDest.type].portageCapacity;
        if(hostAtDest.cargo.length < cap){
          selectedUnit.hostId = hostAtDest.id;
          selectedUnit.x = hostAtDest.x; selectedUnit.y = hostAtDest.y;
          hostAtDest.cargo.push(selectedUnit.id);
          updateInfoPanel(`${stats.name} an Bord von ${UNIT_STATS[hostAtDest.type].name} geladen.`);
        }
      } else {
        selectedUnit.x = x; selectedUnit.y = y;
        const destTile = map[y][x];
        if(destTile.type===T_CITY && destTile.owner!==selectedUnit.owner){
          if(stats.subclass==='land'){
            captureCity(x,y, selectedUnit.owner, selectedUnit);
            updateInfoPanel('Stadt erobert!');
          } else {
            updateInfoPanel('Angelegt – nur Landeinheiten erobern Städte.');
          }
        } else {
          refuelIfOnOwnCity(selectedUnit);
          updateInfoPanel(destTile.type===T_CITY ? 'Bewegt, ggf. aufgetankt/repariert nächste Rast.' : 'Einheit bewegt.');
        }
      }
      deselect();
      checkGameOver(); updateHud();
      return;
    }

    // Anderswo geklickt -> ggf. neue eigene Einheit auswählen
    const clicked = unitsAt(x,y).find(u=>u.owner===OWNER_PLAYER && !u.moved);
    if(clicked) selectUnit(clicked); else deselect();
    return;
  }

  const clicked = unitsAt(x,y).find(u=>u.owner===OWNER_PLAYER && !u.moved);
  if(clicked) selectUnit(clicked);
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

function renderBuildPanel(){
  if(!selectedBuildCity) return;
  const { x, y } = selectedBuildCity;
  const tile = map[y][x];
  const coastal = isCoastal(x,y);
  if(UNIT_STATS[tile.buildType].subclass==='sea' && !coastal){
    tile.buildType = 'infantry'; // Sicherheitsnetz: keine Seeeinheiten im Landesinneren
  }
  document.getElementById('build-city-title').textContent = (tile.capital ? 'Hauptstadt' : 'Stadt') + (coastal ? ' ⚓' : '');

  const rate = tile.capital ? CAPITAL_PRODUCTION : CITY_PRODUCTION;
  const cost = UNIT_STATS[tile.buildType].cost;
  const pct = Math.min(100, Math.floor(100 * tile.buildPoints / cost));
  document.getElementById('build-progress-label').textContent =
    `Baut: ${UNIT_STATS[tile.buildType].name} — ${tile.buildPoints}/${cost} (+${rate}/Runde)`;
  document.getElementById('build-progress-bar').style.width = pct + '%';

  const optionsDiv = document.getElementById('build-options');
  optionsDiv.innerHTML = '';
  for(const type of BUILD_ORDER){
    const stats = UNIT_STATS[type];
    const disabled = stats.subclass==='sea' && !coastal;
    const btn = document.createElement('button');
    btn.className = 'build-option' + (tile.buildType===type ? ' active' : '') + (disabled ? ' disabled' : '');
    const fuelStr = stats.fuel !== undefined ? `, Sprit ${stats.fuel}` : '';
    const rangeStr = stats.range>0 ? `, Reich ${stats.range}` : '';
    btn.innerHTML = `<span class="bo-name">${stats.label} ${stats.name}</span>` +
      `<span class="bo-stats">${disabled ? 'Nur in Küstenstädten (angrenzendes Wasser)' : `Bew ${stats.move} / Dmg ${stats.dmg} / Ang% ${stats.power} / Vert% ${stats.defense} / HP ${stats.hp}${rangeStr}${fuelStr}`}</span>` +
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
  let html = '<tr><th>Einheit</th><th>Klasse</th><th>Bew.</th><th>Dmg</th><th>Ang%</th><th>Vert%</th><th>HP</th><th>Kosten</th><th>Reich.</th><th>Sprit</th></tr>';
  for(const type of BUILD_ORDER){
    const s = UNIT_STATS[type];
    const cls = s.category==='air' ? 'Luft' : (s.subclass==='sea' ? 'See' : 'Boden');
    html += `<tr><td>${s.label} ${s.name}</td><td>${cls}</td>` +
      `<td>${s.move}</td><td>${s.dmg}</td><td>${s.power}</td><td>${s.defense}</td><td>${s.hp}</td><td>${s.cost}</td>` +
      `<td>${s.range||'-'}</td><td>${s.fuel !== undefined ? s.fuel : '∞'}</td></tr>`;
  }
  table.innerHTML = html;
}

/* ---------- STÄDTE: PRODUKTION ---------- */
function pickAiBuildType(coastal){
  const t = turnNumber;
  let weights;
  if(t < 6) weights = { infantry:0.55, tank:0.25, artillery:0.2, destroyer:0, submarine:0, helicopter:0, fighter:0 };
  else if(t < 12) weights = { infantry:0.3, tank:0.25, artillery:0.15, destroyer:0.1, submarine:0.05, helicopter:0.1, fighter:0.05 };
  else weights = { infantry:0.2, tank:0.22, artillery:0.13, destroyer:0.12, submarine:0.08, helicopter:0.12, fighter:0.13 };
  if(!coastal) weights = Object.assign({}, weights, { destroyer:0, submarine:0 });
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
          // Sicherheitsnetz: Seeeinheiten können nicht im Landesinneren produziert werden
          type = 'infantry';
          tile.buildType = 'infantry';
        }
        const cost = UNIT_STATS[type].cost;
        if(tile.buildPoints >= cost){
          const candidates = adjacentTiles(x,y).filter(p => {
            const dummy = { type, owner, x:p.x, y:p.y };
            if(!terrainAllowed(map[p.y][p.x], dummy)) return false;
            return slotStatus(p.x,p.y,dummy) === true;
          });
          if(candidates.length>0){
            const spot = candidates[Math.floor(Math.random()*candidates.length)];
            spawnUnit(owner, type, spot.x, spot.y);
            tile.buildPoints -= cost;
            if(owner===OWNER_AI) tile.buildType = pickAiBuildType(isCoastal(x,y));
          } else {
            tile.buildPoints = cost;
          }
        }
      }
    }
  }
}

function refuelIfOnOwnCity(u){
  if(u.type !== 'fighter') return;
  const tile = map[u.y][u.x];
  if(tile.type===T_CITY && tile.owner===u.owner){
    u.fuel = UNIT_STATS.fighter.fuel;
  }
}

function processFuel(owner){
  const fighters = units.filter(u => u.owner===owner && u.type==='fighter' && u.hp>0 && !u.hostId);
  for(const f of fighters){
    const tile = map[f.y][f.x];
    if(tile.type===T_CITY && tile.owner===owner){
      f.fuel = UNIT_STATS.fighter.fuel;
    } else {
      f.fuel -= 1;
      if(f.fuel <= 0) destroyUnit(f);
    }
  }
}

// Effektivität/Erfahrung/Reparatur/Eingraben-Übergänge am Ende des Zugs eines Spielers
function processEndOfTurnUnitState(owner){
  for(const u of unitsOf(owner)){
    const s = UNIT_STATS[u.type];
    if(u.foughtThisTurn){
      u.effectiveness = Math.min(EFFECTIVENESS.length-1, u.effectiveness+1);
    } else if(!u.actedAtAll){
      const cap = EXPERIENCE_CAP[u.experience];
      u.effectiveness = Math.max(cap, u.effectiveness-1);
      const tile = map[u.y][u.x];
      if(tile.type===T_CITY && tile.owner===owner && u.hp < s.hp){
        u.hp = s.hp; // Reparatur: volle Heilung nach einer Rast in eigener Stadt (vereinfacht)
      }
    }
    if(u.digPending==='in'){ u.dugIn = true; u.digPending = null; }
    else if(u.digPending==='out'){ u.dugIn = false; u.digPending = null; }
    u.moved = false;
    u.firedThisTurn = false;
    u.foughtThisTurn = false;
    u.actedAtAll = false;
  }
}

// Vereinfachtes Defensivfeuer: am Ende des gegnerischen Zugs feuert jede ruhende,
// dazu fähige Einheit einmal automatisch auf das nächste feindliche Ziel in Reichweite.
function processDefensiveFire(defenderOwner){
  const shooters = units.filter(u => u.owner===defenderOwner && u.hp>0 && !u.hostId &&
    UNIT_STATS[u.type].canDefensiveFire && !u.actedAtAll && !u.firedThisTurn);
  const enemyOwner = defenderOwner===OWNER_PLAYER ? OWNER_AI : OWNER_PLAYER;
  for(const u of shooters){
    const s = UNIT_STATS[u.type];
    let best = null, bestD = Infinity;
    for(const e of unitsOf(enemyOwner)){
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

/* ---------- ZUG BEENDEN ---------- */
document.getElementById('end-turn-btn').addEventListener('click', endPlayerTurn);

function endPlayerTurn(){
  if(gameOver || currentTurnOwner!==OWNER_PLAYER) return;
  deselect();
  closeBuildPanel();
  processCityProduction(OWNER_PLAYER);
  processFuel(OWNER_PLAYER);
  processDefensiveFire(OWNER_AI);
  processEndOfTurnUnitState(OWNER_PLAYER);
  currentTurnOwner = OWNER_AI;
  updateHud();
  updateInfoPanel('Der Gegner ist am Zug...');
  setTimeout(runAiTurn, 500);
}

/* ---------- KI ---------- */
function runAiTurn(){
  if(gameOver) return;
  const aiUnits = unitsOf(OWNER_AI).filter(u=>u.hp>0);
  for(const u of aiUnits){
    if(u.hp<=0 || u.moved) continue;
    aiActUnit(u);
  }
  processCityProduction(OWNER_AI);
  processFuel(OWNER_AI);
  processDefensiveFire(OWNER_PLAYER);
  processEndOfTurnUnitState(OWNER_AI);
  currentTurnOwner = OWNER_PLAYER;
  turnNumber++;
  checkGameOver();
  updateHud();
  updateInfoPanel(`Runde ${turnNumber} — Du bist am Zug.`);
  render();
}

function aiActUnit(unit){
  const stats = UNIT_STATS[unit.type];
  const targets = [];
  citiesOf(OWNER_PLAYER).forEach(c=>targets.push({x:c.x,y:c.y}));
  citiesOf(OWNER_NEUTRAL).forEach(c=>targets.push({x:c.x,y:c.y}));
  unitsOf(OWNER_PLAYER).forEach(p=>targets.push({x:p.x,y:p.y}));
  if(targets.length===0) return;

  let best = null, bestDist = Infinity;
  for(const t of targets){
    const d = Math.abs(t.x-unit.x)+Math.abs(t.y-unit.y);
    if(d < bestDist){ bestDist = d; best = t; }
  }
  if(!best) return;

  // Fernkampf, falls möglich und im Vorteil (Ziel in Reichweite, ohne zu ziehen)
  if(stats.range > 0){
    let rTarget = null, rDist = Infinity;
    for(let dy=-stats.range; dy<=stats.range; dy++){
      for(let dx=-stats.range; dx<=stats.range; dx++){
        if(dx===0 && dy===0) continue;
        if(Math.max(Math.abs(dx),Math.abs(dy)) > stats.range) continue;
        const nx=unit.x+dx, ny=unit.y+dy;
        if(!inBounds(nx,ny)) continue;
        const def = pickDefenderAt(nx,ny,unit);
        if(def && def.target.owner===OWNER_PLAYER){
          const d = Math.max(Math.abs(dx),Math.abs(dy));
          if(d<rDist){ rDist=d; rTarget=def.target; }
        }
      }
    }
    if(rTarget){
      resolveRangedAttack(unit, rTarget);
      MusicEngine.start();
      return;
    }
  }

  const adj = adjacentTiles(unit.x,unit.y);
  for(const a of adj){
    const def = pickDefenderAt(a.x,a.y,unit);
    if(def && def.target.owner===OWNER_PLAYER){
      const res = resolveMeleeAttack(unit, def.target, def.noEntry);
      MusicEngine.start();
      if(res.winner==='attacker' && res.entered){
        unit.x = a.x; unit.y = a.y;
        const t = map[a.y][a.x];
        if(t.type===T_CITY && t.owner!==OWNER_AI && stats.subclass==='land') captureCity(a.x,a.y,OWNER_AI,unit);
      }
      return;
    }
    const tile = map[a.y][a.x];
    if(unitsAt(a.x,a.y).length===0 && tile.type===T_CITY && tile.owner!==OWNER_AI && stats.subclass==='land'){
      unit.x = a.x; unit.y = a.y;
      captureCity(a.x,a.y, OWNER_AI, unit);
      return;
    }
  }

  const path = computePathTowards(unit, best);
  if(!path || path.length===0) return;
  let remaining = stats.move;
  for(let i=0;i<path.length;i++){
    const step = path[i];
    const isLast = i===path.length-1;
    const def = isLast ? pickDefenderAt(step.x, step.y, unit) : null;
    if(def){
      if(def.target.owner===OWNER_PLAYER){
        const res = resolveMeleeAttack(unit, def.target, def.noEntry);
        MusicEngine.start();
        if(res.winner==='attacker' && res.entered){
          unit.x = step.x; unit.y = step.y;
          const t = map[step.y][step.x];
          if(t.type===T_CITY && t.owner!==OWNER_AI && stats.subclass==='land') captureCity(step.x, step.y, OWNER_AI, unit);
        }
      }
      return;
    }
    const cost = terrainCost(map[step.y][step.x], unit);
    if(cost > remaining) break;
    remaining -= cost;
    unit.x = step.x; unit.y = step.y;
    refuelIfOnOwnCity(unit);
    const t = map[step.y][step.x];
    if(t.type===T_CITY && t.owner!==OWNER_AI && stats.subclass==='land'){
      captureCity(step.x, step.y, OWNER_AI, unit);
    }
  }
  unit.moved = true;
  unit.actedAtAll = true;
}

/* ---------- SIEG / NIEDERLAGE ---------- */
function checkGameOver(){
  const playerCities = citiesOf(OWNER_PLAYER).length;
  const aiCities = citiesOf(OWNER_AI).length;
  const playerUnits = unitsOf(OWNER_PLAYER).length;
  const aiUnits = unitsOf(OWNER_AI).length;

  if(aiCities===0 && aiUnits===0){
    endGame(true, 'Du hast alle gegnerischen Streitkräfte vernichtet!');
  } else if(playerCities===0 && playerUnits===0){
    endGame(false, 'Deine Armee wurde vollständig aufgerieben.');
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
    `Runde ${turnNumber} — ${currentTurnOwner===OWNER_PLAYER ? 'Dein Zug' : 'Gegner zieht...'}`;
  document.getElementById('player-cities').textContent = citiesOf(OWNER_PLAYER).length;
  document.getElementById('player-units').textContent = unitsOf(OWNER_PLAYER).length;
  document.getElementById('ai-cities').textContent = citiesOf(OWNER_AI).length;
  document.getElementById('ai-units').textContent = unitsOf(OWNER_AI).length;
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
const OWNER_COLORS = {
  [OWNER_PLAYER]: '#3fa9f5',
  [OWNER_AI]: '#f5473f',
  [OWNER_NEUTRAL]: '#8a8f9a'
};
const EFF_COLORS = { fresh:'#5ad65a', rested:'#5ad65a', ready:'#5ad65a', used:'#e0c04a', tired:'#e0c04a', exhausted:'#e0473f' };

function render(){
  if(map.length === 0) return;
  gctx.clearRect(0,0,gameCanvas.width, gameCanvas.height);

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

      gctx.fillStyle = tile.type===T_CITY ? '#1b2436' : TILE_COLORS[tile.type];
      gctx.fillRect(px,py,tsz,tsz);
      gctx.strokeStyle = 'rgba(0,0,0,0.25)';
      gctx.strokeRect(px,py,tsz,tsz);

      if(tile.road && tile.type!==T_CITY){
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
      }
    }
  }

  for(const t of reachableTiles){
    const scr = worldToScreen(t.x*BASE_TILE, t.y*BASE_TILE);
    gctx.fillStyle = 'rgba(63,169,245,0.35)';
    gctx.fillRect(scr.x, scr.y, tsz, tsz);
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

  for(const u of units){
    if(u.hp<=0 || u.hostId) continue;
    if(u.x<startX-1 || u.x>endX+1 || u.y<startY-1 || u.y>endY+1) continue;
    drawUnit(u, tsz);
  }

  renderMinimap();
}

function drawUnit(u, tsz){
  const scr = worldToScreen(u.x*BASE_TILE, u.y*BASE_TILE);
  const px = scr.x, py = scr.y;
  const s = UNIT_STATS[u.type];
  const color = OWNER_COLORS[u.owner];
  const isSelected = selectedUnit===u;
  const isAir = s.category==='air';
  const isDeep = u.subLevel==='deep';

  gctx.save();
  if(isDeep) gctx.globalAlpha = 0.55;

  gctx.beginPath();
  if(isAir){
    const cx = px+tsz/2, cy = py+tsz/2, r = tsz*0.36;
    gctx.moveTo(cx, cy-r); gctx.lineTo(cx+r, cy); gctx.lineTo(cx, cy+r); gctx.lineTo(cx-r, cy);
    gctx.closePath();
  } else if(s.subclass==='sea'){
    gctx.moveTo(px+tsz*0.2, py+tsz*0.35);
    gctx.lineTo(px+tsz*0.8, py+tsz*0.35);
    gctx.lineTo(px+tsz*0.65, py+tsz*0.75);
    gctx.lineTo(px+tsz*0.35, py+tsz*0.75);
    gctx.closePath();
  } else {
    gctx.arc(px+tsz/2, py+tsz/2, tsz*0.34, 0, Math.PI*2);
  }
  gctx.fillStyle = color;
  gctx.fill();
  gctx.lineWidth = isSelected ? 3 : (isCrippled(u) ? 2.5 : 1.5);
  gctx.strokeStyle = isSelected ? '#e0b84a' : (isCrippled(u) ? '#f5473f' : '#000');
  if(isDeep) gctx.setLineDash([3,2]);
  gctx.stroke();
  gctx.setLineDash([]);

  gctx.fillStyle = '#0a0e14';
  gctx.font = `bold ${Math.floor(tsz*0.3)}px monospace`;
  gctx.textAlign = 'center';
  gctx.textBaseline = 'middle';
  gctx.fillText(s.label, px+tsz/2, py+tsz/2+1);

  const maxHp = s.hp;
  const barW = tsz*0.6;
  const barX = px+tsz/2-barW/2;
  const barY = py+tsz*0.86;
  gctx.fillStyle = '#000';
  gctx.fillRect(barX, barY, barW, 4);
  gctx.fillStyle = u.hp/maxHp > 0.5 ? '#5ad65a' : '#e0b84a';
  gctx.fillRect(barX, barY, barW*(u.hp/maxHp), 4);

  // Effektivitäts-Pip
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

  if(u.type==='fighter' && tsz>26){
    gctx.fillStyle = '#e0b84a';
    gctx.font = `${Math.floor(tsz*0.22)}px monospace`;
    gctx.fillText(`⛽${u.fuel}`, px+tsz/2, py+tsz*0.14);
  }
  if(u.cargo && u.cargo.length>0 && tsz>22){
    gctx.fillStyle = '#e0b84a';
    gctx.font = `bold ${Math.floor(tsz*0.24)}px monospace`;
    gctx.fillText(`+${u.cargo.length}`, px+tsz*0.86, py+tsz*0.14);
  }

  if(u.moved && u.owner===OWNER_PLAYER){
    gctx.fillStyle = 'rgba(0,0,0,0.35)';
    gctx.beginPath();
    gctx.arc(px+tsz/2, py+tsz/2, tsz*0.34, 0, Math.PI*2);
    gctx.fill();
  }
  gctx.restore();
}

function renderMinimap(){
  if(map.length===0) return;
  mctx.clearRect(0,0,minimapCanvas.width, minimapCanvas.height);
  mctx.fillStyle = '#12182688';
  mctx.fillRect(0,0,minimapCanvas.width, minimapCanvas.height);
  const scale = minimapCanvas.width / worldW();

  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const tile = map[y][x];
      if(tile.type===T_CITY){
        mctx.fillStyle = OWNER_COLORS[tile.owner] || OWNER_COLORS[OWNER_NEUTRAL];
        mctx.fillRect(x*BASE_TILE*scale, y*BASE_TILE*scale, 4, 4);
      } else if(tile.type===T_MOUNTAIN){
        mctx.fillStyle = '#4a4a52';
        mctx.fillRect(x*BASE_TILE*scale, y*BASE_TILE*scale, BASE_TILE*scale, BASE_TILE*scale);
      } else if(tile.type===T_WATER){
        mctx.fillStyle = '#163a52';
        mctx.fillRect(x*BASE_TILE*scale, y*BASE_TILE*scale, BASE_TILE*scale, BASE_TILE*scale);
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
  units = [];
  unitIdCounter = 1;
  turnNumber = 1;
  currentTurnOwner = OWNER_PLAYER;
  selectedUnit = null;
  reachableTiles = []; attackableTiles = []; rangedTiles = []; unloadTiles = [];
  unloadingCargoUnit = null;
  gameOver = false;
  closeBuildPanel();
  document.getElementById('unit-info-panel').classList.add('hidden');
  document.getElementById('game-over').classList.add('hidden');
  document.getElementById('unit-actions').innerHTML = '';

  const { playerCap, aiCap } = generateMap();
  spawnUnit(OWNER_PLAYER, 'infantry', playerCap.x+1, playerCap.y);
  spawnUnit(OWNER_AI, 'infantry', aiCap.x-1, aiCap.y);

  resizeCanvas();
  camera.zoom = 1;
  centerCameraOn(playerCap.x*BASE_TILE+BASE_TILE/2, playerCap.y*BASE_TILE+BASE_TILE/2);
  updateHud();
  updateInfoPanel('Runde 1 — Wähle eine Einheit. Straßen (goldene Linien) senken Bewegungskosten auf 1.');
  render();
}

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
  });
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
