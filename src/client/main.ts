import { CONFIG as C } from '../shared/config';
import type { PlayerSnap, Phase, Team } from '../shared/protocol';
import { Net, type StateMsg } from './net';
import { Input } from './input';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;

const net = new Net();
const input = new Input($('kick'));
const isTouch = 'ontouchstart' in window;

// ---------- session state ----------
let playerId: string | null = null;
let myTeam: Team = 'A';
let roomCode = '';
let phase: Phase = 'lobby';
let inLobbyUi = false;
let winner: Team | 'draw' | null = null;
let seq = 0;
let lastSent = { mx: 0, my: 0, kick: false, at: 0 };

// ---------- menu / lobby wiring ----------
const nameInput = $('name') as HTMLInputElement;
nameInput.value = localStorage.getItem('elevens-name') ?? '';

function myName() {
  const n = nameInput.value.trim() || 'Player';
  localStorage.setItem('elevens-name', n);
  return n;
}

async function join(room: string | null) {
  $('menu-err').textContent = '';
  try {
    if (!net.connected) await net.connect();
    net.send({ type: 'join', room, name: myName() });
  } catch {
    $('menu-err').textContent = 'Could not reach server';
  }
}

$('create').onclick = () => join(null);
$('join').onclick = () => {
  const code = ($('code') as HTMLInputElement).value.trim().toUpperCase();
  if (code.length !== 4) {
    $('menu-err').textContent = 'Code is 4 letters';
    return;
  }
  join(code);
};
$('start').onclick = () => net.send({ type: 'start' });
$('rematch').onclick = () => {
  net.send({ type: 'rematch' });
  $('rematch-note').textContent = 'Waiting for the others…';
};

function showScreen(which: 'menu' | 'lobby' | 'end' | null) {
  $('menu').classList.toggle('hidden', which !== 'menu');
  $('lobby').classList.toggle('hidden', which !== 'lobby');
  $('end').classList.toggle('hidden', which !== 'end');
  inLobbyUi = which === 'lobby';
  const playing = which === null;
  input.enabled = playing;
  $('kick').classList.toggle('hidden', !(playing && isTouch));
}

// ---------- server messages ----------
let bannerTimer = 0;
function banner(text: string, ms = 1600) {
  const el = $('banner');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

net.onClose = () => {
  showScreen('menu');
  $('menu-err').textContent = 'Disconnected';
  playerId = null;
  net.buffer.length = 0;
};

net.onMsg = (m) => {
  switch (m.type) {
    case 'joined':
      playerId = m.playerId;
      myTeam = m.team;
      roomCode = m.room;
      $('room-code').textContent = roomCode;
      break;
    case 'lobby': {
      const fill = (team: Team, el: HTMLElement) => {
        el.innerHTML = '';
        for (const p of m.players.filter((p) => p.team === team)) {
          const li = document.createElement('li');
          li.textContent = p.name + (p.host ? ' ★' : '') + (p.id === playerId ? ' (you)' : '');
          el.appendChild(li);
        }
      };
      fill('A', $('teamA'));
      fill('B', $('teamB'));
      $('start').classList.toggle('hidden', !m.youAreHost);
      $('wait-host').classList.toggle('hidden', m.youAreHost);
      if (phase === 'lobby') showScreen('lobby');
      break;
    }
    case 'state': {
      const prev = phase;
      phase = m.phase;
      // phase drives the UI — covers joins mid-match, rematches, everything
      if (phase === 'lobby' && prev !== 'lobby' && playerId) showScreen('lobby');
      if ((phase === 'playing' || phase === 'goal') && (prev === 'lobby' || prev === 'ended' || inLobbyUi)) {
        showScreen(null);
      }
      if (phase === 'ended' && prev !== 'ended') {
        const [a, b] = m.score;
        const text =
          winner === 'draw' ? 'DRAW' : winner === myTeam ? 'YOU WIN 🎉' : winner === null ? 'FULL TIME' : 'YOU LOSE';
        $('result').textContent = text;
        $('final-score').textContent = `Team A ${a} — ${b} Team B`;
        $('rematch-note').textContent = '';
        showScreen('end');
      }
      break;
    }
    case 'event':
      if (m.kind === 'goal' && m.score) {
        banner(`GOAL!  ${m.score[0]} — ${m.score[1]}`);
        if (navigator.vibrate) navigator.vibrate(80);
      }
      if (m.kind === 'matchEnd') winner = m.winner ?? null;
      if (m.kind === 'kickoff') winner = null;
      break;
    case 'error':
      $('menu-err').textContent = m.msg;
      break;
  }
};

// ---------- interpolation ----------
// THE core netcode trick: render the world INTERP_DELAY_MS in the past and
// blend between the two snapshots that straddle that moment. Snapshots arrive
// with network jitter, but because we look slightly into the past there are
// (almost) always two of them to blend between — motion stays butter-smooth
// without any prediction.
interface View {
  players: PlayerSnap[];
  ball: { x: number; y: number };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function sampleView(now: number): { view: View; latest: StateMsg } | null {
  const buf = net.buffer;
  if (!buf.length) return null;
  const target = now - C.INTERP_DELAY_MS;

  let older = buf[0];
  let newer = buf[buf.length - 1];
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].at <= target) {
      older = buf[i];
      newer = buf[i + 1] ?? buf[i];
      break;
    }
  }
  const span = newer.at - older.at;
  const t = span > 0 ? Math.min(1, Math.max(0, (target - older.at) / span)) : 1;

  const players = newer.s.players.map((np) => {
    const op = older.s.players.find((p) => p.id === np.id) ?? np;
    return {
      ...np,
      x: lerp(op.x, np.x, t),
      y: lerp(op.y, np.y, t),
      dir: lerpAngle(op.dir, np.dir, t),
    };
  });
  const ball = {
    x: lerp(older.s.ball.x, newer.s.ball.x, t),
    y: lerp(older.s.ball.y, newer.s.ball.y, t),
  };
  return { view: { players, ball }, latest: buf[buf.length - 1].s };
}

// ---------- rendering ----------
let dpr = 1;
function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
}
addEventListener('resize', resize);
resize();

const TEAM_COLOR: Record<Team, string> = { A: '#3b82f6', B: '#ef4444' };

function drawPitch() {
  g.fillStyle = '#2f9e44';
  g.fillRect(0, 0, C.PITCH_W, C.PITCH_H);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 8; i += 2) g.fillRect((i * C.PITCH_W) / 8, 0, C.PITCH_W / 8, C.PITCH_H);

  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, C.PITCH_W - 3, C.PITCH_H - 3);
  g.beginPath();
  g.moveTo(C.PITCH_W / 2, 0);
  g.lineTo(C.PITCH_W / 2, C.PITCH_H);
  g.stroke();
  g.beginPath();
  g.arc(C.PITCH_W / 2, C.PITCH_H / 2, 70, 0, Math.PI * 2);
  g.stroke();

  // goal mouths
  const gy = C.PITCH_H / 2 - C.GOAL_WIDTH / 2;
  g.fillStyle = 'rgba(255,255,255,0.3)';
  g.fillRect(-12, gy, 12, C.GOAL_WIDTH);
  g.fillRect(C.PITCH_W, gy, 12, C.GOAL_WIDTH);
}

function drawFrame() {
  const now = performance.now();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#14532d';
  g.fillRect(0, 0, canvas.width, canvas.height);

  // fit pitch to screen, centered (16px margin for the HUD)
  const scale = Math.min((innerWidth - 16) / C.PITCH_W, (innerHeight - 56) / C.PITCH_H);
  const offX = (innerWidth - C.PITCH_W * scale) / 2;
  const offY = (innerHeight - C.PITCH_H * scale) / 2 + 14;
  g.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offX, dpr * offY);

  drawPitch();

  const sampled = sampleView(now);
  if (sampled) {
    const { view, latest } = sampled;

    // ball shadow + ball
    g.beginPath();
    g.arc(view.ball.x + 2, view.ball.y + 3, C.BALL_RADIUS, 0, Math.PI * 2);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fill();
    g.beginPath();
    g.arc(view.ball.x, view.ball.y, C.BALL_RADIUS, 0, Math.PI * 2);
    g.fillStyle = '#fff';
    g.fill();
    g.strokeStyle = '#333';
    g.lineWidth = 1.5;
    g.stroke();

    for (const p of view.players) {
      const me = p.id === playerId;
      // body
      g.beginPath();
      g.arc(p.x, p.y, C.PLAYER_RADIUS, 0, Math.PI * 2);
      g.fillStyle = TEAM_COLOR[p.team];
      g.fill();
      g.lineWidth = me ? 3.5 : 1.5;
      g.strokeStyle = me ? '#fff' : 'rgba(0,0,0,0.35)';
      g.stroke();
      // facing dot
      g.beginPath();
      g.arc(p.x + Math.cos(p.dir) * (C.PLAYER_RADIUS - 4), p.y + Math.sin(p.dir) * (C.PLAYER_RADIUS - 4), 3, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.fill();
      // charge ring — for MY player use local hold time (zero-latency feel);
      // everyone else renders the (slightly delayed) server charge value
      const charge = me && input.kick
        ? Math.min(1, (now - input.kickHeldSince) / C.KICK_CHARGE_MS)
        : p.charge;
      if (charge > 0.02) {
        g.beginPath();
        g.arc(p.x, p.y, C.PLAYER_RADIUS + 5, -Math.PI / 2, -Math.PI / 2 + charge * Math.PI * 2);
        g.strokeStyle = '#facc15';
        g.lineWidth = 3;
        g.stroke();
      }
      // name
      g.font = '11px system-ui';
      g.textAlign = 'center';
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillText(p.name, p.x, p.y - C.PLAYER_RADIUS - 7);
    }

    // HUD (screen space)
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (latest.phase !== 'lobby') {
      const t = Math.max(0, latest.timeLeft);
      const mm = Math.floor(t / 60);
      const ss = String(Math.floor(t % 60)).padStart(2, '0');
      g.font = '700 22px system-ui';
      g.textAlign = 'center';
      g.fillStyle = '#fff';
      g.fillText(`${latest.score[0]}  —  ${latest.score[1]}     ${mm}:${ss}`, innerWidth / 2, 30);
      g.font = '12px system-ui';
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillText(`room ${roomCode}`, innerWidth / 2, 48);
    }
  }

  // virtual joystick overlay (screen space)
  if (input.joyActive) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.beginPath();
    g.arc(input.joyBase.x, input.joyBase.y, 52, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    g.lineWidth = 2;
    g.stroke();
    const dx = input.joyKnob.x - input.joyBase.x;
    const dy = input.joyKnob.y - input.joyBase.y;
    const d = Math.hypot(dx, dy);
    const k = d > 52 ? 52 / d : 1;
    g.beginPath();
    g.arc(input.joyBase.x + dx * k, input.joyBase.y + dy * k, 22, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fill();
  }
}

// ---------- main loop ----------
function tickFrame() {
  input.update();

  // send held input on any change, plus a 100ms heartbeat so the server
  // state can never go stale if a packet is dropped
  if (playerId && net.connected) {
    const now = performance.now();
    const changed =
      input.mx !== lastSent.mx || input.my !== lastSent.my || input.kick !== lastSent.kick;
    if (changed || now - lastSent.at > 100) {
      net.send({ type: 'input', seq: seq++, mx: input.mx, my: input.my, kick: input.kick });
      lastSent = { mx: input.mx, my: input.my, kick: input.kick, at: now };
    }
  }

  drawFrame();
  requestAnimationFrame(tickFrame);
}

showScreen('menu');
requestAnimationFrame(tickFrame);
