'use strict';

const COLS = 10;
const ROWS = 20;
const BLOCK = 30;

const COLORS = [
  null,
  '#4dd0e1', // I - cyan
  '#ffd54f', // O - yellow
  '#ba68c8', // T - purple
  '#81c784', // S - green
  '#e57373', // Z - red
  '#64b5f6', // J - pale blue
  '#ffb74d', // L - orange
];

const PIECES = [
  null,
  [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], // I
  [[2,2],[2,2]],                               // O
  [[0,3,0],[3,3,3],[0,0,0]],                  // T
  [[0,4,4],[4,4,0],[0,0,0]],                  // S
  [[5,5,0],[0,5,5],[0,0,0]],                  // Z
  [[6,0,0],[6,6,6],[0,0,0]],                  // J
  [[0,0,7],[7,7,7],[0,0,0]],                  // L
];

const LINE_SCORES = [0, 100, 300, 500, 800];

const POWER_UP_TYPES = ['bomb', 'lightning', 'tint', 'gravity', 'freeze'];
const POWER_UP_ICONS = { bomb: '💣', lightning: '⚡', tint: '🎨', gravity: '⬇️', freeze: '❄️' };
const POWER_UP_LABELS = { bomb: 'Bomba', lightning: 'Rayo', tint: 'Tinte', gravity: 'Gravedad', freeze: 'Congelar' };
const POWER_UP_LINE_INTERVAL = 5;
const POWER_UP_BONUS = 50;
const POWER_UP_FREEZE_MS = 5000;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const nextCanvas = document.getElementById('next-canvas');
const nextCtx = nextCanvas.getContext('2d');
const scoreEl = document.getElementById('score');
const linesEl = document.getElementById('lines');
const levelEl = document.getElementById('level');
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayScore = document.getElementById('overlay-score');
const restartBtn = document.getElementById('restart-btn');
const toastEl = document.getElementById('toast');

let board, current, next, score, lines, level, paused, gameOver, lastTime, dropAccum, dropInterval, animId;
let powerUpPending, lastPowerUpMilestone, freezeTimer, toastTimeoutId;

function createBoard() {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
}

function randomPiece(powerUp) {
  const type = Math.floor(Math.random() * 7) + 1;
  const shape = PIECES[type].map(row => [...row]);
  const p = { type, shape, x: Math.floor(COLS / 2) - Math.floor(shape[0].length / 2), y: 0, powerUp: null };
  if (powerUp) p.powerUp = POWER_UP_TYPES[Math.floor(Math.random() * POWER_UP_TYPES.length)];
  return p;
}

function collide(shape, ox, oy) {
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const nx = ox + c;
      const ny = oy + r;
      if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
      if (ny >= 0 && board[ny][nx]) return true;
    }
  }
  return false;
}

function rotateCW(shape) {
  const rows = shape.length, cols = shape[0].length;
  const result = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      result[c][rows - 1 - r] = shape[r][c];
  return result;
}

function tryRotate() {
  const rotated = rotateCW(current.shape);
  const kicks = [0, -1, 1, -2, 2];
  for (const kick of kicks) {
    if (!collide(rotated, current.x + kick, current.y)) {
      current.shape = rotated;
      current.x += kick;
      return;
    }
  }
}

function merge() {
  for (let r = 0; r < current.shape.length; r++)
    for (let c = 0; c < current.shape[r].length; c++)
      if (current.shape[r][c])
        board[current.y + r][current.x + c] = current.shape[r][c];
}

function clearLines() {
  let cleared = 0;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r].every(v => v !== 0)) {
      board.splice(r, 1);
      board.unshift(new Array(COLS).fill(0));
      cleared++;
      r++;
    }
  }
  if (cleared) {
    lines += cleared;
    score += (LINE_SCORES[cleared] || 0) * level;
    level = Math.floor(lines / 10) + 1;
    dropInterval = Math.max(100, 1000 - (level - 1) * 90);
    const milestone = Math.floor(lines / POWER_UP_LINE_INTERVAL);
    if (milestone > lastPowerUpMilestone) {
      powerUpPending = true;
      lastPowerUpMilestone = milestone;
    }
    updateHUD();
  }
}

function pieceBounds(p) {
  let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
  for (let r = 0; r < p.shape.length; r++)
    for (let c = 0; c < p.shape[r].length; c++)
      if (p.shape[r][c]) {
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      }
  return { minR, maxR, minC, maxC };
}

function pieceCenterCell(p) {
  const b = pieceBounds(p);
  return { row: p.y + Math.floor((b.minR + b.maxR) / 2), col: p.x + Math.floor((b.minC + b.maxC) / 2) };
}

function destroyArea(cr, cc, radius) {
  for (let r = cr - radius; r <= cr + radius; r++) {
    if (r < 0 || r >= ROWS) continue;
    for (let c = cc - radius; c <= cc + radius; c++) {
      if (c < 0 || c >= COLS) continue;
      board[r][c] = 0;
    }
  }
}

function destroyCross(cr, cc) {
  if (cr >= 0 && cr < ROWS) board[cr].fill(0);
  if (cc >= 0 && cc < COLS) for (let r = 0; r < ROWS; r++) board[r][cc] = 0;
}

function destroyMostFrequentColor() {
  const counts = new Array(COLORS.length).fill(0);
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (board[r][c]) counts[board[r][c]]++;
  let target = 0, max = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > max) { max = counts[i]; target = i; }
  if (!target) return;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (board[r][c] === target) board[r][c] = 0;
}

function compactColumns() {
  for (let c = 0; c < COLS; c++) {
    const values = [];
    for (let r = 0; r < ROWS; r++) if (board[r][c]) values.push(board[r][c]);
    const gap = ROWS - values.length;
    for (let r = 0; r < ROWS; r++) board[r][c] = r < gap ? 0 : values[r - gap];
  }
}

function triggerPowerUp(pieceObj) {
  const type = pieceObj.powerUp;
  const { row, col } = pieceCenterCell(pieceObj);
  switch (type) {
    case 'bomb': destroyArea(row, col, 1); break;
    case 'lightning': destroyCross(row, col); break;
    case 'tint': destroyMostFrequentColor(); break;
    case 'gravity': compactColumns(); break;
    case 'freeze': freezeTimer = POWER_UP_FREEZE_MS; break;
  }
  score += POWER_UP_BONUS;
  showToast(`${POWER_UP_ICONS[type]} ${POWER_UP_LABELS[type]} activado`);
}

function showToast(text, duration) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => toastEl.classList.add('hidden'), duration || 1600);
}

function ghostY() {
  let gy = current.y;
  while (!collide(current.shape, current.x, gy + 1)) gy++;
  return gy;
}

function hardDrop() {
  const gy = ghostY();
  score += (gy - current.y) * 2;
  current.y = gy;
  lockPiece();
}

function softDrop() {
  if (!collide(current.shape, current.x, current.y + 1)) {
    current.y++;
    score += 1;
    updateHUD();
  } else {
    lockPiece();
  }
}

function lockPiece() {
  merge();
  if (current.powerUp) triggerPowerUp(current);
  clearLines();
  spawn();
}

function spawn() {
  current = next;
  next = randomPiece(powerUpPending);
  if (powerUpPending) {
    powerUpPending = false;
    showToast('¡Pieza especial en camino!');
  }
  if (collide(current.shape, current.x, current.y)) {
    endGame();
  }
  drawNext();
}

function updateHUD() {
  scoreEl.textContent = score.toLocaleString();
  linesEl.textContent = lines;
  levelEl.textContent = level;
}

function drawBlock(context, x, y, colorIndex, size, alpha, glow) {
  if (!colorIndex) return;
  const color = COLORS[colorIndex];
  context.globalAlpha = alpha ?? 1;
  context.fillStyle = color;
  context.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
  // highlight
  context.fillStyle = 'rgba(255,255,255,0.12)';
  context.fillRect(x * size + 1, y * size + 1, size - 2, 4);
  context.globalAlpha = 1;
  if (glow) {
    context.save();
    context.shadowColor = '#fff';
    context.shadowBlur = 10 + 4 * Math.sin(performance.now() / 150);
    context.strokeStyle = 'rgba(255,255,255,0.9)';
    context.lineWidth = 2;
    context.strokeRect(x * size + 2, y * size + 2, size - 4, size - 4);
    context.restore();
  }
}

function drawPowerUpBadge(context, pieceObj, originX, originY, size) {
  if (!pieceObj.powerUp) return;
  const b = pieceBounds(pieceObj);
  const cx = (originX + b.minC + (b.maxC - b.minC + 1) / 2) * size;
  const cy = (originY + b.minR + (b.maxR - b.minR + 1) / 2) * size;
  context.save();
  context.globalAlpha = 1;
  context.font = `${size * 0.7}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#fff';
  context.strokeStyle = 'rgba(0,0,0,0.6)';
  context.lineWidth = 3;
  const icon = POWER_UP_ICONS[pieceObj.powerUp];
  context.strokeText(icon, cx, cy);
  context.fillText(icon, cx, cy);
  context.restore();
}

function drawGrid() {
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--grid-line').trim() || '#22222e';
  ctx.lineWidth = 0.5;
  for (let c = 1; c < COLS; c++) {
    ctx.beginPath();
    ctx.moveTo(c * BLOCK, 0);
    ctx.lineTo(c * BLOCK, ROWS * BLOCK);
    ctx.stroke();
  }
  for (let r = 1; r < ROWS; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * BLOCK);
    ctx.lineTo(COLS * BLOCK, r * BLOCK);
    ctx.stroke();
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();

  // board
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      drawBlock(ctx, c, r, board[r][c], BLOCK);

  // ghost
  const gy = ghostY();
  for (let r = 0; r < current.shape.length; r++)
    for (let c = 0; c < current.shape[r].length; c++)
      if (current.shape[r][c])
        drawBlock(ctx, current.x + c, gy + r, current.shape[r][c], BLOCK, 0.2);

  // current piece
  for (let r = 0; r < current.shape.length; r++)
    for (let c = 0; c < current.shape[r].length; c++)
      drawBlock(ctx, current.x + c, current.y + r, current.shape[r][c], BLOCK, 1, !!current.powerUp);

  drawPowerUpBadge(ctx, current, current.x, current.y, BLOCK);
}

function drawNext() {
  const NB = 30;
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  const shape = next.shape;
  const offX = Math.floor((4 - shape[0].length) / 2);
  const offY = Math.floor((4 - shape.length) / 2);
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++)
      drawBlock(nextCtx, offX + c, offY + r, shape[r][c], NB, 1, !!next.powerUp);

  drawPowerUpBadge(nextCtx, next, offX, offY, NB);
}

function endGame() {
  gameOver = true;
  cancelAnimationFrame(animId);
  overlayTitle.textContent = 'GAME OVER';
  overlayScore.textContent = `Puntuación: ${score.toLocaleString()}`;
  overlay.classList.remove('hidden');
}

function togglePause() {
  if (gameOver) return;
  paused = !paused;
  if (!paused) {
    lastTime = performance.now();
    loop(lastTime);
  } else {
    cancelAnimationFrame(animId);
    overlayTitle.textContent = 'PAUSA';
    overlayScore.textContent = '';
    overlay.classList.remove('hidden');
  }
}

function loop(ts) {
  if (gameOver || paused) return;
  const dt = ts - lastTime;
  lastTime = ts;
  if (freezeTimer > 0) {
    freezeTimer = Math.max(0, freezeTimer - dt);
  } else {
    dropAccum += dt;
    if (dropAccum >= dropInterval) {
      dropAccum = 0;
      if (!collide(current.shape, current.x, current.y + 1)) {
        current.y++;
      } else {
        lockPiece();
      }
    }
  }
  draw();
  animId = requestAnimationFrame(loop);
}

function init() {
  board = createBoard();
  score = 0;
  lines = 0;
  level = 1;
  paused = false;
  gameOver = false;
  dropInterval = 1000;
  dropAccum = 0;
  lastTime = performance.now();
  powerUpPending = false;
  lastPowerUpMilestone = 0;
  freezeTimer = 0;
  next = randomPiece();
  spawn();
  updateHUD();
  overlay.classList.add('hidden');
  cancelAnimationFrame(animId);
  animId = requestAnimationFrame(loop);
}

document.addEventListener('keydown', e => {
  if (e.code === 'KeyP') { togglePause(); return; }
  if (paused || gameOver) return;
  switch (e.code) {
    case 'ArrowLeft':
      if (!collide(current.shape, current.x - 1, current.y)) current.x--;
      break;
    case 'ArrowRight':
      if (!collide(current.shape, current.x + 1, current.y)) current.x++;
      break;
    case 'ArrowDown':
      softDrop();
      break;
    case 'ArrowUp':
    case 'KeyX':
      tryRotate();
      break;
    case 'Space':
      e.preventDefault();
      hardDrop();
      break;
  }
  updateHUD();
});

restartBtn.addEventListener('click', init);

// ---- Theme toggle (dark por defecto) ----
const themeSwitch = document.getElementById('theme-switch');
const THEME_KEY = 'tetris-theme';

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  themeSwitch.checked = theme === 'light';
  localStorage.setItem(THEME_KEY, theme);
}

const savedTheme = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
applyTheme(savedTheme);

themeSwitch.addEventListener('change', () => {
  applyTheme(themeSwitch.checked ? 'light' : 'dark');
});

init();
