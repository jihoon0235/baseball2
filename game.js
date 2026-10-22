// ============================================================
//  ⚾  야구 게임 – 심판 시점 + ABS + 정밀 타이밍 + 도루
// ============================================================
//
//  ★ 타이밍 구조 (직구 기준 46프레임 ≈ 0.77초 비행)
//  ┌─────────────────────────────────────────────────────┐
//  │  p < 0.42         → 완전 헛스윙 (Strike)            │
//  │  p 0.42 ~ 0.57    → 너무 빠른 스윙                  │
//  │                     · 볼 밖 : 헛스윙 스트라이크      │
//  │                     · 볼 안 : 팝업/뜬공 아웃 (80%)   │
//  │                              내야 안타 (20%)          │
//  │  p 0.57 ~ 0.88    → ★ 정상 타격 창 (스위트스팟)     │
//  │                     · 히트/홈런 등 기존 로직          │
//  │  p 0.88 ~ 0.97    → 너무 늦은 스윙                   │
//  │                     · 볼 밖 : 헛스윙 스트라이크      │
//  │                     · 볼 안 : 땅볼 아웃 (60%)         │
//  │                              내야 안타 (40%)          │
//  │  p > 0.97         → 완전 헛스윙 (Strike)             │
//  └─────────────────────────────────────────────────────┘
//
//  ★ 도루 조작: 타자석에서 [S] 키 또는 [도루!] 버튼
//  ★ 스윙 조작: 스페이스바 / 캔버스 클릭 (오른쪽 절반)
//
// ============================================================

const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
const W = 800, H = 520;
canvas.width  = W;
canvas.height = H;

const TOTAL_INNINGS = 3;

// 스트라이크존 (심판 정면 시점)
const SZ = {
  x: W/2 - 52,
  y: H/2 - 80,
  w: 104,
  h: 155,
};

// ── 상태
const G = {
  phase: 'idle',
  inning: 1, half: 'top',
  outs: 0, strikes: 0, balls: 0,
  score: { me: 0, opp: 0 },
  bases: [false, false, false],   // [1루, 2루, 3루]
  ball: null,
  swung: false,
  swingActive: false,
  swingAnim: 0,
  pitchType: 'straight',
  pitchTarget: { x: 0.5, y: 0.5 },
  pitchFixed: false,
  ceremony: null,
  runners: [],
  absResult: null,
  // 도루 상태
  stealAnim: null,   // { fromBase, toBase, t, dur, success }
  stealLocked: false, // 이미 도루 시도 중
  // 구속 레이더건
  radarGun: null,    // { kph, type, frame, dur, isAI }
};

// ============================================================
//  HUD
// ============================================================
function hud() {
  document.getElementById('sbInning').textContent =
    `${G.inning}회 ${G.half === 'top' ? '초' : '말'}`;
  document.getElementById('sbMe').textContent  = G.score.me;
  document.getElementById('sbOpp').textContent = G.score.opp;
  function dots(id, count, max, cls) {
    const el = document.getElementById(id);
    el.innerHTML = '';
    for (let i = 0; i < max; i++) {
      const d = document.createElement('div');
      d.className = 'dot' + (i < count ? ' ' + cls : '');
      el.appendChild(d);
    }
  }
  dots('dotOuts',    G.outs,    3, 'on-out');
  dots('dotStrikes', G.strikes, 3, 'on-strike');
  dots('dotBalls',   G.balls,   4, 'on-ball');

  // 도루 버튼 가시성
  const stealBtn = document.getElementById('stealBtn');
  const canSteal = G.phase === 'batting' && !G.stealLocked && !G.ball &&
                   (G.bases[0] || G.bases[1]); // 1루 또는 2루 주자
  stealBtn.style.display = canSteal ? 'block' : 'none';
}

// ============================================================
//  오버레이
// ============================================================
function showOverlay(title, sub, btnTxt, cb) {
  const el = document.getElementById('overlay');
  document.getElementById('ovTitle').textContent = title;
  document.getElementById('ovSub').textContent   = sub;
  const btn = document.getElementById('ovBtn');
  btn.textContent = btnTxt;
  btn.onclick = () => { el.classList.add('hidden'); cb && cb(); };
  el.classList.remove('hidden');
}

function setUI() {
  const pitch = document.getElementById('pitchPanel');
  const hint  = document.getElementById('batterHint');
  if (G.phase === 'pitching') {
    pitch.classList.remove('hidden');
    hint.classList.add('hidden');
  } else if (G.phase === 'batting') {
    pitch.classList.add('hidden');
    hint.classList.remove('hidden');
  } else {
    pitch.classList.add('hidden');
    hint.classList.add('hidden');
  }
  hud();
}

// ============================================================
//  투수 패널 – 드래그로 세밀한 위치 선택
// ============================================================
const szOuter  = document.getElementById('szOuter');
const szTarget = document.getElementById('szTarget');

function updateTargetPos(clientX, clientY) {
  const r = szOuter.getBoundingClientRect();
  const px = Math.max(0, Math.min(clientX - r.left, r.width));
  const py = Math.max(0, Math.min(clientY - r.top,  r.height));
  G.pitchTarget = { x: px / r.width, y: py / r.height };
  szTarget.style.left = px + 'px';
  szTarget.style.top  = py + 'px';
  szTarget.style.display = 'block';
}

let isDragging = false;

szOuter.addEventListener('mousedown', e => {
  isDragging = true;
  G.pitchFixed = false;
  szTarget.style.background = 'radial-gradient(circle, #06d6a0 40%, #059669)';
  szTarget.style.boxShadow  = '0 0 14px #06d6a0';
  updateTargetPos(e.clientX, e.clientY);
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!isDragging) return;
  updateTargetPos(e.clientX, e.clientY);
});
document.addEventListener('mouseup', e => {
  if (!isDragging) return;
  isDragging = false;
  G.pitchFixed = true;
  szTarget.style.background = 'radial-gradient(circle, #f9c74f 40%, #f77f00)';
  szTarget.style.boxShadow  = '0 0 14px #f9c74f';
  highlightSector();
});
szOuter.addEventListener('mouseleave', () => {
  if (!G.pitchFixed && !isDragging) szTarget.style.display = 'none';
});

function highlightSector() {
  document.querySelectorAll('.sz-cell').forEach(el => el.classList.remove('selected'));
  const r = szOuter.getBoundingClientRect();
  const outerW = r.width, outerH = r.height;
  const pickerW = 120, pickerH = 120;
  const offX = (outerW - pickerW) / 2;
  const offY = (outerH - pickerH) / 2;
  const px = G.pitchTarget.x * outerW - offX;
  const py = G.pitchTarget.y * outerH - offY;
  if (px >= 0 && px <= pickerW && py >= 0 && py <= pickerH) {
    const col = Math.min(Math.floor(px / (pickerW / 5)), 4);
    const row = Math.min(Math.floor(py / (pickerH / 5)), 4);
    const cells = document.querySelectorAll('.sz-cell');
    if (cells[row * 5 + col]) cells[row * 5 + col].classList.add('selected');
  }
}

// 25분할 (5×5) 셀
const szGrid = document.getElementById('szGrid');
for (let i = 0; i < 25; i++) {
  const c = document.createElement('div');
  c.className = 'sz-cell';
  c.addEventListener('click', e => {
    e.stopPropagation();
    const row = Math.floor(i / 5), col = i % 5;
    const outerW = 200, outerH = 200;
    const pickerW = 120, pickerH = 120;
    const offX = (outerW - pickerW) / 2;
    const offY = (outerH - pickerH) / 2;
    const cx = offX + (col + 0.5) * (pickerW / 5);
    const cy = offY + (row + 0.5) * (pickerH / 5);
    G.pitchTarget = { x: cx / outerW, y: cy / outerH };
    G.pitchFixed = true;
    szTarget.style.left = cx + 'px';
    szTarget.style.top  = cy + 'px';
    szTarget.style.display = 'block';
    szTarget.style.background = 'radial-gradient(circle, #f9c74f 40%, #f77f00)';
    szTarget.style.boxShadow  = '0 0 14px #f9c74f';
    document.querySelectorAll('.sz-cell').forEach(el => el.classList.remove('selected'));
    c.classList.add('selected');
  });
  szGrid.appendChild(c);
}

document.querySelectorAll('.pt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    G.pitchType = btn.dataset.type;
  });
});

document.getElementById('throwBtn').addEventListener('click', () => {
  if (G.phase === 'pitching') launchPitch(false);
});

// ============================================================
//  타자 입력 (스윙) – 클릭 정확도 개선
//  캔버스 우측 절반 클릭 or 스페이스바
// ============================================================
document.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); trySwing(); }
  if (e.code === 'KeyS')  { e.preventDefault(); trySteal(); }
});

// 캔버스 클릭: pitchPanel이 left에 있으므로 캔버스 전체에서 스윙 가능
canvas.addEventListener('click', e => {
  // pitchPanel 영역(좌측 UI) 클릭은 제외
  const rect = canvas.getBoundingClientRect();
  const cx   = e.clientX - rect.left;
  // 좌측 224px (패널 영역)은 제외 → 실제로 패널은 absolute 위에 있음
  // 타격 페이즈에서만 반응
  if (G.phase === 'batting') trySwing();
});

// 도루 버튼
document.getElementById('stealBtn').addEventListener('click', () => trySteal());

// ============================================================
//  게임 흐름
// ============================================================
function startGame() {
  Object.assign(G, {
    phase: 'idle', inning: 1, half: 'top',
    outs: 0, strikes: 0, balls: 0,
    score: { me: 0, opp: 0 },
    bases: [false, false, false],
    ball: null, swung: false, swingActive: false,
    swingAnim: 0, ceremony: null, runners: [],
    pitchFixed: false, absResult: null,
    stealAnim: null, stealLocked: false,
  });
  hud();
  startHalf();
}

function startHalf() {
  Object.assign(G, {
    outs: 0, strikes: 0, balls: 0,
    bases: [false, false, false],
    ball: null, swung: false, swingActive: false,
    swingAnim: 0, ceremony: null, runners: [],
    absResult: null, stealAnim: null, stealLocked: false,
  });
  const isTop = G.half === 'top';
  showOverlay(
    `${G.inning}회 ${isTop ? '초' : '말'}`,
    isTop
      ? '🏏 당신이 타자!\n스페이스·클릭으로 스윙, [S]로 도루!'
      : '⚾ 당신이 투수!\n위치·구종 선택 후 던지세요',
    '시작!',
    () => {
      G.phase = isTop ? 'batting' : 'pitching';
      setUI();
      if (isTop) scheduleAIPitch();
    }
  );
}

function nextBatter() {
  G.strikes = 0; G.balls = 0;
  G.ball = null; G.swung = false; G.swingActive = false;
  G.swingAnim = 0; G.pitchFixed = false; G.absResult = null;
  G.stealLocked = false;
  szTarget.style.display = 'none';
  szTarget.style.background = '';
  szTarget.style.boxShadow  = '';
  document.querySelectorAll('.sz-cell').forEach(el => el.classList.remove('selected'));
  setUI();
  if (G.half === 'top') scheduleAIPitch();
  else G.phase = 'pitching', setUI();
}

function doOut(msg) {
  G.outs++;
  flash(msg, '#e63946');
  hud();
  if (G.outs >= 3) setTimeout(endHalf, 1700);
  else             setTimeout(nextBatter, 1900);
}

function endHalf() {
  if (G.half === 'top') { G.half = 'bottom'; startHalf(); }
  else {
    if (G.inning >= TOTAL_INNINGS) endGame();
    else { G.inning++; G.half = 'top'; startHalf(); }
  }
}

function endGame() {
  G.phase = 'gameover';
  const me = G.score.me, op = G.score.opp;
  const title = me > op ? '🏆 승리!' : me < op ? '😢 패배...' : '🤝 무승부';
  showOverlay(title, `최종 스코어  나 ${me} : 상대 ${op}`, '다시 하기!', startGame);
}

// ============================================================
//  투구
// ============================================================
const PITCH_START_X = W / 2;
const PITCH_START_Y = H * 0.46;  // 투수 마운드 위치

function launchPitch(isAI) {
  G.phase = 'animating';
  G.swung = false;
  G.absResult = null;
  G.stealLocked = true;  // 투구 시작되면 도루 잠금
  setUI();

  let endX, endY;
  if (isAI) {
    if (Math.random() < 0.62) {
      endX = SZ.x + Math.random() * SZ.w;
      endY = SZ.y + Math.random() * SZ.h;
    } else {
      const side = Math.floor(Math.random() * 4);
      const mg = 38;
      if      (side === 0) { endX = SZ.x - mg - Math.random()*18; endY = SZ.y + Math.random()*SZ.h; }
      else if (side === 1) { endX = SZ.x+SZ.w+mg+Math.random()*18; endY = SZ.y+Math.random()*SZ.h; }
      else if (side === 2) { endX = SZ.x+Math.random()*SZ.w; endY = SZ.y-mg-Math.random()*18; }
      else                 { endX = SZ.x+Math.random()*SZ.w; endY = SZ.y+SZ.h+mg+Math.random()*18; }
    }
  } else {
    const marginX = SZ.w * 0.70;
    const marginY = SZ.h * 0.48;
    endX = (SZ.x - marginX) + G.pitchTarget.x * (SZ.w + marginX * 2);
    endY = (SZ.y - marginY) + G.pitchTarget.y * (SZ.h + marginY * 2);
  }

  const type = isAI
    ? ['straight','curve','slider','changeup','cutter'][Math.floor(Math.random()*5)]
    : G.pitchType;

  // ★ 구종별 속도 범위 (km/h) + 애니메이션 프레임
  //   실제 KBO 기준 속도:
  //   직구(straight) : 145~153 km/h → 44프레임
  //   커터(cutter)   : 136~143 km/h → 47프레임
  //   슬라이더       : 128~136 km/h → 51프레임
  //   커브           : 118~127 km/h → 57프레임
  //   체인지업       : 110~120 km/h → 63프레임
  const SPEED_TABLE = {
    straight: { min: 145, max: 153, dur: 44 },
    cutter:   { min: 136, max: 143, dur: 47 },
    slider:   { min: 128, max: 136, dur: 51 },
    curve:    { min: 118, max: 127, dur: 57 },
    changeup: { min: 110, max: 120, dur: 63 },
  };
  const sp  = SPEED_TABLE[type] || SPEED_TABLE.straight;
  const dur = sp.dur;
  // km/h: 범위 내 랜덤 + 소수점 없이
  const kph = Math.round(sp.min + Math.random() * (sp.max - sp.min));

  const inSZ = endX >= SZ.x && endX <= SZ.x+SZ.w && endY >= SZ.y && endY <= SZ.y+SZ.h;

  G.ball = {
    x: PITCH_START_X, y: PITCH_START_Y,
    startX: PITCH_START_X, startY: PITCH_START_Y,
    endX, endY, t: 0, dur, type, isAI, hit: false, inSZ, kph,
  };

  // 레이더건 표시 준비 (공이 도착하면 표시)
  G.radarGun = null;

  if (isAI) { G.phase = 'batting'; setUI(); }
}

function scheduleAIPitch() {
  G.stealLocked = false;
  hud();  // 도루 버튼 업데이트
  if (G.phase !== 'batting') return;
  setTimeout(() => {
    if (G.phase !== 'batting') return;
    G.swung = false;
    launchPitch(true);
  }, 1000 + Math.random() * 700);
}

// ============================================================
//  공 업데이트 (원근감 – 작게→크게 날아옴)
// ============================================================
function updateBall() {
  const b = G.ball; if (!b) return;
  if (b.t >= b.dur) {
    if (!b.hit) ballLanded(b);
    G.ball = null; return;
  }
  b.t++;
  const p  = b.t / b.dur;
  const ep = p * p;   // easeIn

  b.x = lerp(b.startX, b.endX, ep);
  b.y = lerp(b.startY, b.endY, ep);

  // 구종별 변화 (심판 시점)
  if      (b.type === 'curve')    { b.x += Math.sin(p*Math.PI)*22; b.y -= Math.sin(p*Math.PI)*16; }
  else if (b.type === 'slider')   { b.x += Math.sin(p*Math.PI)*20; }
  else if (b.type === 'changeup') { b.y += Math.sin(p*Math.PI)*14; }
  else if (b.type === 'cutter')   { b.x -= Math.sin(p*Math.PI)*15; }

  // 원근감: 공 크기
  b.r = 1.8 + p * 11;
}

// ============================================================
//  공 착지 처리
// ============================================================
function ballLanded(b) {
  G.absResult = { inSZ: b.inSZ, x: b.endX, y: b.endY, frame: 0, dur: 85 };
  // 레이더건 표시 (착지 시 나타나서 2.5초간 유지)
  G.radarGun  = { kph: b.kph, type: b.type, isAI: b.isAI, frame: 0, dur: 150 };

  if (b.isAI) {
    if (!G.swung) {
      if (b.inSZ) {
        G.strikes++;
        flash('스트라이크! ⚾', '#f9c74f');
        hud();
        if (G.strikes >= 3) setTimeout(() => doOut('삼진 아웃! ⚾'), 900);
        else { G.phase = 'batting'; setUI(); setTimeout(scheduleAIPitch, 1300); }
      } else {
        G.balls++;
        flash('볼!', '#06d6a0');
        hud();
        if (G.balls >= 4) doWalk();
        else { G.phase = 'batting'; setUI(); setTimeout(scheduleAIPitch, 1200); }
      }
    }
    G.swung = false;
    G.swingActive = false;
  } else {
    aiDecide(b);
  }
}

// ============================================================
//  타격 판정 – 정밀 타이밍 시스템
// ============================================================
function trySwing() {
  if (G.phase !== 'batting' || G.swung || !G.ball) return;
  G.swung      = true;
  G.swingActive = true;
  G.swingAnim  = 0;

  const b = G.ball;
  const p = b.t / b.dur;

  // ── 타이밍 구간 판별
  const TOO_EARLY_MIN  = 0.42;
  const EARLY_START    = 0.42;
  const EARLY_END      = 0.57;
  const WINDOW_START   = 0.57;
  const WINDOW_END     = 0.88;
  const LATE_START     = 0.88;
  const LATE_END       = 0.97;
  // p > 0.97 → 헛스윙

  if (p < TOO_EARLY_MIN) {
    // 완전 헛스윙
    G.strikes++;
    flash('너무 빠른 스윙! 💨', '#f9c74f');
    hud();
    afterMiss();
    return;
  }

  if (p > LATE_END) {
    // 완전 헛스윙
    G.strikes++;
    flash('타이밍 너무 늦었어요! 💨', '#f9c74f');
    hud();
    afterMiss();
    return;
  }

  if (p >= EARLY_START && p < EARLY_END) {
    // 빠른 스윙 → 볼 안이면 팝업/뜬공, 밖이면 헛스윙
    if (!b.inSZ) {
      G.strikes++;
      flash('빠른 헛스윙!', '#f9c74f');
      hud();
      afterMiss();
    } else {
      // 뜬공 아웃 80%, 내야 안타 20%
      if (Math.random() < 0.80) {
        const flyTypes = ['팝업 아웃! 🙄', '뜬공 아웃! ✋', '플라이 아웃! 🖐️'];
        flash(flyTypes[Math.floor(Math.random()*flyTypes.length)], '#ff9944');
        G.ball && (G.ball.hit = true);
        G.swingActive = true;
        setTimeout(() => doOut('플라이 아웃!'), 900);
      } else {
        // 내야 안타 (빠른 타이밍)
        G.ball && (G.ball.hit = true);
        flash('내야 안타! 😮', '#06d6a0');
        advanceBases(1, true);
        setTimeout(() => { G.strikes=0; G.balls=0; hud(); G.phase='batting'; setUI(); scheduleAIPitch(); }, 2000);
      }
    }
    return;
  }

  if (p >= LATE_START && p <= LATE_END) {
    // 늦은 스윙 → 볼 안이면 땅볼/내야 안타, 밖이면 헛스윙
    if (!b.inSZ) {
      G.strikes++;
      flash('늦은 헛스윙!', '#f9c74f');
      hud();
      afterMiss();
    } else {
      // 땅볼 아웃 60%, 내야 안타 40%
      if (Math.random() < 0.60) {
        flash('땅볼 아웃! 🏃', '#ff9944');
        G.ball && (G.ball.hit = true);
        setTimeout(() => doOut('땅볼 아웃!'), 900);
      } else {
        G.ball && (G.ball.hit = true);
        flash('땅볼 내야 안타! 😅', '#06d6a0');
        advanceBases(1, true);
        setTimeout(() => { G.strikes=0; G.balls=0; hud(); G.phase='batting'; setUI(); scheduleAIPitch(); }, 2000);
      }
    }
    return;
  }

  // ── 정상 타격 창 (0.57 ~ 0.88)
  // ★ 홈런 확률: 타이밍 정밀도 × 투구 위치로 결정
  //   타이밍 중심(0.725) 기준 ±0.08 이내 = 퍼펙트 타이밍
  //   + 스트라이크존 내 공일 때만 홈런 가능
  const hitProb = b.inSZ ? 0.68 : 0.20;
  if (Math.random() < hitProb) {
    G.ball && (G.ball.hit = true);
    // 타이밍 정밀도 (0=최악, 1=퍼펙트)
    const timingCenter = 0.725;  // 스위트스팟 중심
    const timingDist   = Math.abs(p - timingCenter) / 0.155;  // 0~1
    const timingScore  = Math.max(0, 1 - timingDist);         // 1=퍼펙트
    // 홈런 확률: 퍼펙트 타이밍 + 볼 존 중앙 → 최대 30%
    const hrChance  = b.inSZ ? timingScore * 0.30 : 0;
    const triChance = timingScore * 0.16;
    const dblChance = 0.24;
    const r = Math.random();
    const hitType = r < hrChance ? 'homerun'
                  : r < hrChance + triChance ? 'triple'
                  : r < hrChance + triChance + dblChance ? 'double'
                  : 'single';
    triggerHit(hitType, false);
  } else {
    G.strikes++;
    flash('헛스윙! 💨', '#f9c74f');
    hud();
    afterMiss();
  }
}

function afterMiss() {
  if (G.strikes >= 3) setTimeout(() => doOut('삼진 아웃!'), 900);
  else setTimeout(() => {
    G.swung = false; G.swingActive = false; G.swingAnim = 0;
    scheduleAIPitch();
  }, 1400);
}

// ============================================================
//  도루 (Steal)
// ============================================================
function trySteal() {
  if (G.phase !== 'batting') return;
  if (G.stealLocked) return;
  if (G.ball) return;  // 공 이미 날아가는 중

  // 도루 가능 주자 찾기: 1루 → 2루, 2루 → 3루 (3루 → 홈 불가)
  let stealFrom = -1;
  if (G.bases[1]) stealFrom = 1;       // 2루 주자가 우선 (3루로)
  else if (G.bases[0]) stealFrom = 0;  // 1루 주자 (2루로)

  if (stealFrom === -1) {
    flash('도루할 주자가 없어요!', '#aaa');
    return;
  }

  G.stealLocked = true;
  hud();

  const stealTo = stealFrom + 1;
  const successRate = 0.62;  // 도루 성공률 62%

  // 도루 애니메이션 시작
  G.stealAnim = {
    fromBase: stealFrom + 1,  // 경로 인덱스 (1=1루, 2=2루, 3=3루)
    toBase:   stealTo   + 1,
    t: 0, dur: 55,
    success: Math.random() < successRate,
    baseIdx: stealFrom,       // G.bases 인덱스
    toBaseIdx: stealTo,
  };

  flash('도루 시도! 🏃💨', '#f9c74f');
}

function updateSteal() {
  const sa = G.stealAnim; if (!sa) return;
  sa.t++;

  if (sa.t >= sa.dur) {
    if (sa.success) {
      // 도루 성공
      G.bases[sa.baseIdx]   = false;
      G.bases[sa.toBaseIdx] = true;
      flash('도루 성공! 🎉', '#06d6a0');
      hud();
    } else {
      // 도루 실패 → 아웃
      G.bases[sa.baseIdx] = false;
      flash('도루 실패! 태그 아웃! 😱', '#e63946');
      G.stealAnim = null;
      doOut('도루 실패 아웃!');
      return;
    }
    G.stealAnim = null;
    G.stealLocked = false;
    hud();
    setTimeout(scheduleAIPitch, 800);
  }
}

// 베이스 경로
const BASE_PATH = [
  { x: W/2,     y: H - 50  }, // 홈 [0]
  { x: W/2+140, y: H - 155 }, // 1루 [1]
  { x: W/2,     y: H - 262 }, // 2루 [2]
  { x: W/2-140, y: H - 155 }, // 3루 [3]
  { x: W/2,     y: H - 50  }, // 홈 (귀환) [4]
];

function drawStealRunner() {
  const sa = G.stealAnim; if (!sa) return;
  const p  = sa.t / sa.dur;
  const from = BASE_PATH[sa.fromBase];
  const to   = BASE_PATH[sa.toBase];
  const pos  = { x: lerp(from.x, to.x, easeInOut(p)), y: lerp(from.y, to.y, easeInOut(p)) };

  // 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(pos.x, pos.y+12,9,3,0,0,Math.PI*2); ctx.fill();

  // 주자 (빨간색 – 플레이어)
  const leg = Math.sin(sa.t * 0.45) * 0.5;
  ctx.fillStyle = '#e63946';
  ctx.beginPath(); ctx.roundRect(pos.x-6, pos.y-20, 12,14,2); ctx.fill();
  ctx.fillStyle = '#f5cba7';
  ctx.beginPath(); ctx.arc(pos.x, pos.y-27, 7, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = '#e63946'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(pos.x-2,pos.y-6); ctx.lineTo(pos.x-2+Math.cos(leg)*8, pos.y+Math.sin(leg)*5+2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pos.x+2,pos.y-6); ctx.lineTo(pos.x+2+Math.cos(leg+Math.PI)*8, pos.y+Math.sin(leg+Math.PI)*5+2); ctx.stroke();

  // 슬라이딩 효과 (80% 이후)
  if (!sa.success && p > 0.75) {
    ctx.fillStyle = 'rgba(200,140,60,0.5)';
    ctx.beginPath(); ctx.ellipse(pos.x-12, pos.y+8, 20,5,-0.3,0,Math.PI*2); ctx.fill();
  }

  // 성공 예정이면 녹색 빛, 실패 예정이면 빨간 빛
  if (p > 0.6) {
    ctx.globalAlpha = (p-0.6)*2.5 * 0.4;
    ctx.fillStyle = sa.success ? '#06d6a0' : '#e63946';
    ctx.beginPath(); ctx.arc(pos.x, pos.y-14, 18,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ============================================================
//  AI 타자 판정
//
//  ★ 홈런 확률 구조 (투구 위치 연동):
//    - 존 정중앙 직구  → AI 홈런 확률 최대 ~28%
//    - 존 가장자리     → AI 홈런 확률 최소 ~5%
//    - 볼 존           → AI 홈런 확률 ~2%
//    centerRatio(0~1): 1=정중앙, 0=존 끝
// ============================================================
function aiDecide(b) {
  // 존 중앙까지의 거리 비율 계산 (1 = 정중앙, 0 = 존 가장자리)
  const szCX = SZ.x + SZ.w / 2;
  const szCY = SZ.y + SZ.h / 2;
  const distX = Math.abs(b.endX - szCX) / (SZ.w / 2);
  const distY = Math.abs(b.endY - szCY) / (SZ.h / 2);
  const centerRatio = b.inSZ ? Math.max(0, 1 - Math.max(distX, distY)) : 0;
  // centerRatio: 정중앙=1, 존 끝=0, 볼=0

  const swingP = b.inSZ ? 0.80 : 0.20;  // 스트라이크면 80% 스윙
  if (Math.random() < swingP) {
    // ── 스윙! 타자 애니메이션 트리거
    G.swingActive = true;
    G.swingAnim   = 0;
    setTimeout(() => { G.swingActive = false; }, 500);

    const hitP = b.inSZ ? 0.52 : 0.14;  // 스트라이크면 52% 안타
    if (Math.random() < hitP) {
      // ── 타구 종류 결정 (투구 위치 연동)
      // 중앙일수록 홈런, 가장자리일수록 단타
      const hrChance  = b.inSZ ? 0.05 + centerRatio * 0.23 : 0.02; // 5~28%
      const triChance = 0.14;
      const dblChance = 0.28;
      const r = Math.random();
      const hitType = r < hrChance ? 'homerun'
                    : r < hrChance + triChance ? 'triple'
                    : r < hrChance + triChance + dblChance ? 'double'
                    : 'single';
      triggerHit(hitType, true);
    } else {
      G.strikes++;
      flash('헛스윙 스트라이크!', '#f9c74f');
      hud();
      if (G.strikes >= 3) setTimeout(() => doOut('삼진 아웃! 🎉'), 800);
      else { G.phase = 'pitching'; setUI(); }
    }
  } else {
    // ── 안 침
    if (b.inSZ) {
      G.strikes++;
      flash('루킹 스트라이크!', '#f9c74f');
      hud();
      if (G.strikes >= 3) setTimeout(() => doOut('삼진 아웃! 🎉'), 800);
      else { G.phase = 'pitching'; setUI(); }
    } else {
      G.balls++;
      flash('볼!', '#06d6a0');
      hud();
      if (G.balls >= 4) aiWalk();
      else { G.phase = 'pitching'; setUI(); }
    }
  }
}

// ============================================================
//  베이스 진루 & 득점
// ============================================================
function advanceBases(adv, playerHit) {
  const nb = [false, false, false];
  let scored = 0;
  for (let i = 2; i >= 0; i--) {
    if (!G.bases[i]) continue;
    const np = i + adv;
    if (np >= 3) scored++;
    else nb[np] = true;
  }
  const bp = adv - 1;
  if (bp >= 3) scored++;
  else if (bp >= 0) nb[bp] = true;
  spawnRunnerAnim(G.bases, adv, playerHit);
  G.bases = nb;
  if (playerHit) G.score.me  += scored;
  else            G.score.opp += scored;
  hud();
  return scored;
}

function doWalk() {
  flash('볼넷! 출루! 🏃', '#06d6a0');
  advanceBases(1, true);
  setTimeout(() => {
    G.strikes = 0; G.balls = 0;
    G.phase = 'batting'; setUI(); scheduleAIPitch();
  }, 1400);
}

function aiWalk() {
  flash('볼넷! AI 출루!', '#ff8888');
  advanceBases(1, false);
  setTimeout(() => {
    G.strikes = 0; G.balls = 0;
    G.phase = 'pitching'; setUI();
  }, 1400);
}

// ============================================================
//  타구 처리
// ============================================================
function triggerHit(type, isAI) {
  G.phase = 'animating'; setUI();
  const adv = { single: 1, double: 2, triple: 3, homerun: 4 }[type];
  const labels = { single: '안타! 🎯', double: '2루타! 💥', triple: '3루타! 🔥', homerun: '홈런! 🎉' };
  flash(labels[type], type === 'homerun' ? '#f77f00' : '#06d6a0');
  if (type === 'homerun') {
    startCeremony(isAI, adv);
  } else {
    advanceBases(adv, !isAI);
    setTimeout(() => {
      G.strikes = 0; G.balls = 0; hud();
      if (G.half === 'top') { G.phase = 'batting'; setUI(); scheduleAIPitch(); }
      else { G.phase = 'pitching'; setUI(); }
    }, 2000);
  }
}

// ============================================================
//  주자 애니메이션
// ============================================================
function spawnRunnerAnim(oldBases, adv, playerHit) {
  for (let i = 2; i >= 0; i--) {
    if (!oldBases[i]) continue;
    const startBase = i + 1;
    const endBase   = Math.min(startBase + adv, 4);
    G.runners.push({ pathStart: startBase, pathEnd: endBase, t: 0, dur: 60+adv*18, playerHit });
  }
  const endBase = Math.min(adv, 4);
  G.runners.push({ pathStart: 0, pathEnd: endBase, t: 0, dur: 60+adv*18, playerHit });
}

function updateRunners() {
  G.runners.forEach(r => { r.t = Math.min(r.t+1, r.dur); });
  G.runners = G.runners.filter(r => r.t < r.dur);
}

function getRunnerPos(r) {
  const segCount = r.pathEnd - r.pathStart;
  if (segCount <= 0) return BASE_PATH[r.pathEnd];
  const totalT = r.t / r.dur;
  const seg    = Math.min(Math.floor(totalT * segCount), segCount-1);
  const segT   = (totalT * segCount) - seg;
  const from   = BASE_PATH[r.pathStart + seg];
  const to     = BASE_PATH[r.pathStart + seg + 1];
  return { x: lerp(from.x, to.x, easeInOut(segT)), y: lerp(from.y, to.y, easeInOut(segT)) };
}

function drawRunners() {
  G.runners.forEach(r => {
    const pos = getRunnerPos(r);
    const color = r.playerHit ? '#e63946' : '#1e4d8c';
    ctx.fillStyle='rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(pos.x,pos.y+12,8,3,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle=color;
    ctx.beginPath(); ctx.roundRect(pos.x-5,pos.y-18,10,12,2); ctx.fill();
    ctx.fillStyle='#f5cba7';
    ctx.beginPath(); ctx.arc(pos.x,pos.y-24,6,0,Math.PI*2); ctx.fill();
    const leg = Math.sin(r.t*0.4)*0.5;
    ctx.strokeStyle=color; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.moveTo(pos.x-2,pos.y-6); ctx.lineTo(pos.x-2+Math.cos(leg)*7,pos.y+Math.sin(leg)*5+2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pos.x+2,pos.y-6); ctx.lineTo(pos.x+2+Math.cos(leg+Math.PI)*7,pos.y+Math.sin(leg+Math.PI)*5+2); ctx.stroke();
  });
}

// ============================================================
//  홈런 세레머니
// ============================================================
const CEREMONIES = [
  { name: '배트 플립! 💫',  color: '#f77f00', emoji: '🏏' },
  { name: '슬라이딩 홈인!', color: '#118ab2', emoji: '🏃' },
  { name: '점프 세레머니!', color: '#9b5de5', emoji: '🎉' },
  { name: '경례! 🫡',       color: '#06d6a0', emoji: '🫡' },
  { name: '팀 포옹! 🤗',    color: '#f9c74f', emoji: '🤗' },
];
function startCeremony(isAI, adv) {
  const c = CEREMONIES[Math.floor(Math.random()*CEREMONIES.length)];
  G.ceremony = {
    ...c, isAI, adv, frame: 0, dur: 200,
    particles: Array.from({length:80},()=>({
      x:W/2+(Math.random()-.5)*300, y:H/2,
      vx:(Math.random()-.5)*12, vy:-9-Math.random()*9,
      r:3+Math.random()*5, life:1,
      decay:0.009+Math.random()*0.011,
      color:`hsl(${Math.random()*360},90%,62%)`,
    })),
    fireworks: Array.from({length:10},()=>({
      x:80+Math.random()*640, y:40+Math.random()*160,
      delay:Math.floor(Math.random()*60),
      color:`hsl(${Math.random()*360},90%,65%)`,
    })),
  };
}
function updateCeremony() {
  const c = G.ceremony; if (!c) return;
  c.frame++;
  c.particles.forEach(p=>{p.x+=p.vx;p.y+=p.vy;p.vy+=0.2;p.life-=p.decay;});
  c.particles=c.particles.filter(p=>p.life>0);
  if (c.frame>=c.dur) {
    const {isAI,adv}=c; G.ceremony=null;
    advanceBases(adv,!isAI);
    setTimeout(()=>{
      G.strikes=0;G.balls=0;hud();
      if(G.half==='top'){G.phase='batting';setUI();scheduleAIPitch();}
      else{G.phase='pitching';setUI();}
    },600);
  }
}
function drawCeremony() {
  const c=G.ceremony; if(!c) return;
  const prog=c.frame/c.dur;
  c.particles.forEach(p=>{
    ctx.globalAlpha=p.life*0.9;
    ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
    ctx.fillStyle=p.color;ctx.fill();
  });
  ctx.globalAlpha=1;
  c.fireworks.forEach(fw=>{
    const f=c.frame-fw.delay;if(f<0)return;
    const fp=(f%50)/50;
    for(let i=0;i<12;i++){
      const a=i/12*Math.PI*2;
      ctx.strokeStyle=fw.color;ctx.lineWidth=2;
      ctx.globalAlpha=Math.max(0,1-fp*1.8);
      ctx.beginPath();ctx.moveTo(fw.x,fw.y);
      ctx.lineTo(fw.x+Math.cos(a)*40*fp,fw.y+Math.sin(a)*40*fp);ctx.stroke();
    }
    ctx.globalAlpha=1;
  });
  const alpha=prog<0.15?prog/0.15:prog>0.8?(1-prog)/0.2:1;
  ctx.globalAlpha=alpha;
  const grd=ctx.createRadialGradient(W/2,H/2-40,0,W/2,H/2-40,160);
  grd.addColorStop(0,c.color+'99');grd.addColorStop(1,'transparent');
  ctx.fillStyle=grd;ctx.beginPath();ctx.arc(W/2,H/2-40,160,0,Math.PI*2);ctx.fill();
  const sc=1+Math.sin(c.frame*0.1)*0.04;
  ctx.save();ctx.translate(W/2,H/2-60);ctx.scale(sc,sc);
  ctx.font='80px serif';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(c.emoji,0,-10);
  ctx.font='bold 26px Outfit';ctx.fillStyle='#fff';
  ctx.shadowColor=c.color;ctx.shadowBlur=20;
  ctx.fillText(c.name,0,64);ctx.shadowBlur=0;ctx.restore();
  ctx.font='bold 68px Outfit';ctx.textAlign='center';ctx.textBaseline='top';
  const g2=ctx.createLinearGradient(W/2-130,0,W/2+130,0);
  g2.addColorStop(0,'#f9c74f');g2.addColorStop(0.5,'#f77f00');g2.addColorStop(1,'#e63946');
  ctx.fillStyle=g2;ctx.shadowColor='#f77f00';ctx.shadowBlur=30;
  ctx.fillText('홈런! 🎉',W/2,60+Math.sin(c.frame*0.09)*5);
  ctx.shadowBlur=0;ctx.globalAlpha=1;
}

// ============================================================
//  플래시
// ============================================================
let flashAnim = null;
function flash(text, color='#fff') { flashAnim = {text, color, f:0, dur:70}; }
function drawFlash() {
  if (!flashAnim) return;
  flashAnim.f++;
  const p = flashAnim.f / flashAnim.dur;
  const a = p<0.2 ? p*5 : Math.max(0, 1-(p-0.2)/0.8);
  ctx.globalAlpha = a;
  ctx.font = 'bold 40px Outfit'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillStyle=flashAnim.color; ctx.shadowColor=flashAnim.color; ctx.shadowBlur=22;
  ctx.fillText(flashAnim.text, W/2, 78);
  ctx.shadowBlur=0; ctx.globalAlpha=1;
  if (flashAnim.f >= flashAnim.dur) flashAnim = null;
}

// ============================================================
//  ABS 판정 결과 표시
// ============================================================
function drawABSResult() {
  const r = G.absResult; if (!r) return;
  r.frame++;
  if (r.frame > r.dur) { G.absResult = null; return; }
  const a = r.frame<10 ? r.frame/10 : r.frame>r.dur-15 ? (r.dur-r.frame)/15 : 1;
  ctx.globalAlpha = a;

  // 착지 링
  const ringR = 11 + Math.sin(r.frame*0.18)*2;
  ctx.strokeStyle = r.inSZ ? '#f9c74f' : '#06d6a0';
  ctx.lineWidth=3; ctx.shadowColor=r.inSZ?'#f9c74f':'#06d6a0'; ctx.shadowBlur=16;
  ctx.beginPath(); ctx.arc(r.x, r.y, ringR, 0, Math.PI*2); ctx.stroke();

  // 펄스 링
  const outerR = ringR + (r.frame%28)*1.4;
  ctx.globalAlpha = a*Math.max(0,1-(r.frame%28)/28);
  ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.arc(r.x, r.y, outerR, 0, Math.PI*2); ctx.stroke();

  ctx.shadowBlur=0; ctx.globalAlpha=a;
  const label = r.inSZ ? '✓ STRIKE' : '✗ BALL';
  ctx.font='bold 11px Outfit'; ctx.textAlign='center'; ctx.textBaseline='bottom';
  ctx.fillStyle=r.inSZ?'#f9c74f':'#06d6a0';
  ctx.shadowColor=r.inSZ?'#f9c74f':'#06d6a0'; ctx.shadowBlur=10;
  ctx.fillText(label, r.x, r.y-15);
  ctx.shadowBlur=0; ctx.globalAlpha=1;

  // 스트라이크존 강조
  ctx.strokeStyle=r.inSZ?'rgba(249,199,79,0.55)':'rgba(6,214,160,0.55)';
  ctx.lineWidth=2.5; ctx.setLineDash([6,4]);
  ctx.strokeRect(SZ.x,SZ.y,SZ.w,SZ.h);
  ctx.setLineDash([]);
}

// ============================================================
//  타이밍 바 (타자 시점 UI)
// ============================================================
function drawTimingBar() {
  if (G.phase !== 'batting' || !G.ball) return;
  const b = G.ball;
  const p = b.t / b.dur;

  const barX = W/2 - 160, barY = H - 18, barW = 320, barH = 10;

  // 배경
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath(); ctx.roundRect(barX-2, barY-2, barW+4, barH+4, 5); ctx.fill();

  // 구간 색상
  // 완전 헛스윙 | 이른 접촉 | 스위트스팟 | 늦은 접촉 | 완전 헛스윙
  const zones = [
    { from:0,    to:0.42, color:'rgba(150,80,80,0.6)'  },  // 너무 이름
    { from:0.42, to:0.57, color:'rgba(255,140,60,0.7)' },  // 이른 스윙
    { from:0.57, to:0.88, color:'rgba(80,210,120,0.75)'},  // 스위트스팟
    { from:0.88, to:0.97, color:'rgba(255,140,60,0.7)' },  // 늦은 스윙
    { from:0.97, to:1.0,  color:'rgba(150,80,80,0.6)'  },  // 너무 늦음
  ];
  zones.forEach(z => {
    ctx.fillStyle = z.color;
    ctx.fillRect(barX + z.from*barW, barY, (z.to-z.from)*barW, barH);
  });

  // 현재 공 위치 마커
  ctx.fillStyle = '#fff';
  ctx.shadowColor = '#fff'; ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.roundRect(barX + p*barW - 2, barY-3, 4, barH+6, 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // 라벨
  ctx.font = 'bold 9px Outfit'; ctx.textAlign='center'; ctx.textBaseline='top';
  ctx.fillStyle='rgba(255,255,255,0.45)';
  ctx.fillText('이름', barX+0.49*0.42*barW*2, barY+barH+3);
  ctx.fillStyle='rgba(80,255,140,0.7)';
  ctx.fillText('★ SWEET SPOT ★', barX+(0.57+0.155)*barW, barY+barH+3);
  ctx.fillStyle='rgba(255,255,255,0.45)';
  ctx.fillText('늦음', barX+(0.88+0.045)*barW*2/2+barW*0.03, barY+barH+3);
}

// ============================================================
//  배경
// ============================================================
function drawBG() {
  const sky=ctx.createLinearGradient(0,0,0,H*0.45);
  sky.addColorStop(0,'#080d1a'); sky.addColorStop(1,'#182a42');
  ctx.fillStyle=sky; ctx.fillRect(0,0,W,H);

  if (!drawBG._s) drawBG._s=Array.from({length:80},()=>({x:Math.random()*W,y:Math.random()*H*0.4,r:Math.random()*1.4+0.2}));
  ctx.fillStyle='rgba(255,255,255,0.48)';
  drawBG._s.forEach(s=>{ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,Math.PI*2);ctx.fill();});

  // 외야 벽
  const wallGrd=ctx.createLinearGradient(0,H*0.34,0,H*0.49);
  wallGrd.addColorStop(0,'#182218'); wallGrd.addColorStop(1,'#2a4a2a');
  ctx.fillStyle=wallGrd; ctx.fillRect(0,H*0.34,W,H*0.13);

  // 광고판
  const adC=['#e63946','#118ab2','#f9c74f','#9b5de5'];
  const adT=['BASEBALL','HOME RUN','ABS ZONE','STADIUM'];
  for(let i=0;i<4;i++){
    const ax=30+i*188,ay=H*0.355,aw=165,ah=36;
    ctx.fillStyle=adC[i]; ctx.beginPath(); ctx.roundRect(ax,ay,aw,ah,4); ctx.fill();
    ctx.fillStyle='#fff'; ctx.font='bold 12px Outfit'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(adT[i],ax+aw/2,ay+ah/2);
  }

  // 관중석
  for(let row=0;row<4;row++){
    ctx.fillStyle=`rgba(${38+row*7},${18+row*4},${72+row*10},${0.62+row*0.09})`;
    ctx.fillRect(0,H*0.0+row*H*0.083,W,H*0.083+2);
    for(let c=0;c<58;c++){
      const cx2=(c+0.5)*(W/58)+Math.sin(c*row*1.4)*3.5;
      const cy2=H*0.024+row*H*0.083+Math.cos(c*2.2)*3.5;
      ctx.fillStyle=`hsl(${(c*37+row*70)%360},55%,52%)`;
      ctx.beginPath();ctx.arc(cx2,cy2,3.5,0,Math.PI*2);ctx.fill();
    }
  }

  // 잔디
  const grassGrd=ctx.createLinearGradient(0,H*0.46,0,H);
  grassGrd.addColorStop(0,'#2d8a3a'); grassGrd.addColorStop(1,'#1e5828');
  ctx.fillStyle=grassGrd; ctx.fillRect(0,H*0.46,W,H);
  for(let i=0;i<14;i++){
    ctx.fillStyle=i%2===0?'rgba(0,0,0,0.06)':'rgba(255,255,255,0.025)';
    ctx.fillRect(i*(W/14),H*0.46,W/14,H);
  }

  // 내야 흙
  const dirtGrd=ctx.createRadialGradient(W/2,H+200,20,W/2,H+200,H*0.9);
  dirtGrd.addColorStop(0,'#c9874c'); dirtGrd.addColorStop(1,'#8a5020');
  ctx.fillStyle=dirtGrd;
  ctx.beginPath(); ctx.ellipse(W/2,H,340,150,0,Math.PI,0); ctx.fill();

  // 투수 마운드
  const mX=W/2, mY=H*0.47;
  const mGrd=ctx.createRadialGradient(mX,mY+5,2,mX,mY+10,26);
  mGrd.addColorStop(0,'#d4935a'); mGrd.addColorStop(1,'#a06030');
  ctx.fillStyle=mGrd;
  ctx.beginPath(); ctx.ellipse(mX,mY+10,28,11,0,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#e0a060';
  ctx.beginPath(); ctx.ellipse(mX,mY,20,7,0,Math.PI,0); ctx.fill();
}

// ============================================================
//  스트라이크존
// ============================================================
function drawStrikeZone() {
  if (!['batting','animating','pitching'].includes(G.phase)) return;
  const {x,y,w,h}=SZ;
  ctx.fillStyle='rgba(6,214,160,0.04)'; ctx.fillRect(x,y,w,h);
  ctx.strokeStyle='rgba(6,214,160,0.12)'; ctx.lineWidth=0.7;
  for(let i=1;i<5;i++){
    ctx.beginPath();ctx.moveTo(x+i*w/5,y);ctx.lineTo(x+i*w/5,y+h);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x,y+i*h/5);ctx.lineTo(x+w,y+i*h/5);ctx.stroke();
  }
  ctx.strokeStyle='rgba(6,214,160,0.65)'; ctx.lineWidth=2.5;
  ctx.setLineDash([6,4]); ctx.strokeRect(x,y,w,h); ctx.setLineDash([]);
  ctx.font='11px Outfit'; ctx.fillStyle='rgba(6,214,160,0.75)';
  ctx.textAlign='center'; ctx.textBaseline='bottom';
  ctx.fillText('STRIKE ZONE (ABS)',x+w/2,y-5);
  ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.lineWidth=1; ctx.setLineDash([3,5]);
  ctx.beginPath();ctx.moveTo(W/2,y);ctx.lineTo(W/2,y+h);ctx.stroke();
  ctx.setLineDash([]);
}

// ============================================================
//  홈플레이트
// ============================================================
function drawHomePlate() {
  const px=W/2, py=H-28;
  ctx.fillStyle='rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(px-22,py-6); ctx.lineTo(px+22,py-6);
  ctx.lineTo(px+24,py+2); ctx.lineTo(px,py+10); ctx.lineTo(px-24,py+2);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle='rgba(180,180,180,0.5)'; ctx.lineWidth=1.5; ctx.stroke();
}

// ============================================================
//  베이스
// ============================================================
function drawBases() {
  const bpos=[BASE_PATH[1],BASE_PATH[2],BASE_PATH[3]];
  bpos.forEach((b,i)=>{
    ctx.save(); ctx.translate(b.x,b.y); ctx.rotate(Math.PI/4);
    ctx.fillStyle=G.bases[i]?'#f9c74f':'rgba(255,255,255,0.82)';
    if(G.bases[i]){ctx.shadowColor='#f9c74f';ctx.shadowBlur=14;}
    ctx.fillRect(-9,-9,18,18);
    ctx.shadowBlur=0; ctx.restore();
    ctx.font='bold 9px Outfit'; ctx.fillStyle='rgba(255,255,255,0.65)';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(i+1+'루',b.x,b.y-20);
  });
}

function drawBaselines() {
  ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.lineWidth=2; ctx.setLineDash([8,6]);
  ctx.beginPath();
  ctx.moveTo(BASE_PATH[0].x,BASE_PATH[0].y);
  ctx.lineTo(BASE_PATH[1].x,BASE_PATH[1].y);
  ctx.lineTo(BASE_PATH[2].x,BASE_PATH[2].y);
  ctx.lineTo(BASE_PATH[3].x,BASE_PATH[3].y);
  ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
}

// ============================================================
//  투수
// ============================================================
function drawPitcher() {
  const x=W/2, y=H*0.47-5;
  const bob=Math.sin(Date.now()/500)*1;
  const throwing=G.ball&&G.ball.t<12;
  const windupT=G.ball?Math.min(G.ball.t/12,1):0;
  const sc=0.62;
  ctx.save(); ctx.translate(x,y); ctx.scale(sc,sc);
  ctx.fillStyle='#1a3a6a';
  ctx.fillRect(-7,18+bob,6,22); ctx.fillRect(2,18+bob,6,22);
  ctx.fillStyle='#111';
  ctx.fillRect(-9,38+bob,10,7); ctx.fillRect(1,38+bob,10,7);
  const bg=ctx.createLinearGradient(-12,0,12,0);
  bg.addColorStop(0,'#1e4d8c'); bg.addColorStop(1,'#2563b0');
  ctx.fillStyle=bg; ctx.beginPath(); ctx.roundRect(-12,bob,24,20,4); ctx.fill();
  const armRot=throwing?lerp(-0.3,-1.4,windupT):-0.3;
  ctx.save(); ctx.translate(10,6+bob); ctx.rotate(armRot);
  ctx.fillStyle='#f5cba7'; ctx.beginPath(); ctx.roundRect(-3,-3,6,18,2); ctx.fill();
  ctx.restore();
  ctx.fillStyle='#8B5E3C'; ctx.beginPath(); ctx.arc(-18,12+bob,7,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#f5cba7'; ctx.beginPath(); ctx.arc(0,-7+bob,11,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#1e4d8c'; ctx.fillRect(-12,-17+bob,24,6);
  ctx.beginPath(); ctx.arc(0,-17+bob,9,Math.PI,0); ctx.fill();
  ctx.fillRect(-14,-11+bob,28,4);
  ctx.restore();
}

// ============================================================
//  타자 (정면 시점)
// ============================================================
function drawBatter() {
  const x=W/2-48, y=H-55;
  if(G.swingActive) G.swingAnim=Math.min(G.swingAnim+0.09,1);
  else G.swingAnim=Math.max(G.swingAnim-0.05,0);
  const sa=G.swingAnim;
  const batAngle=lerp(-1.6,0.3,easeInOut(sa));

  ctx.save(); ctx.translate(x,y);
  ctx.fillStyle='#8B0000';
  ctx.fillRect(-10,-55,9,55); ctx.fillRect(2,-55,9,55);
  ctx.fillStyle='#333';
  ctx.fillRect(-13,-9,13,9); ctx.fillRect(1,-9,13,9);
  const tg=ctx.createLinearGradient(-14,-70,14,-30);
  tg.addColorStop(0,'#b71c1c'); tg.addColorStop(1,'#d32f2f');
  ctx.fillStyle=tg; ctx.beginPath(); ctx.roundRect(-13,-85,26,38,5); ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.moveTo(-4,-85); ctx.lineTo(-4,-47); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(4,-85); ctx.lineTo(4,-47); ctx.stroke();
  ctx.save(); ctx.translate(0,-65); ctx.rotate(batAngle);
  ctx.fillStyle='#5D2E0C';
  ctx.beginPath(); ctx.roundRect(-3,0,6,18,2); ctx.fill();
  const batGrd=ctx.createLinearGradient(-5,-45,5,0);
  batGrd.addColorStop(0,'#c8a040'); batGrd.addColorStop(0.4,'#8B5E20'); batGrd.addColorStop(1,'#5D3A10');
  ctx.fillStyle=batGrd;
  ctx.beginPath(); ctx.roundRect(-5,-45,10,45,4); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.roundRect(-3,-43,3,28,2); ctx.fill();
  ctx.fillStyle='#c8a040';
  ctx.beginPath(); ctx.arc(0,-45,5,0,Math.PI*2); ctx.fill();
  ctx.restore();
  ctx.fillStyle='#f5cba7';
  ctx.save(); ctx.translate(0,-70); ctx.rotate(batAngle*0.5);
  ctx.beginPath(); ctx.roundRect(-4,-5,8,18,3); ctx.fill(); ctx.restore();
  ctx.save(); ctx.translate(12,-65); ctx.rotate(batAngle*0.4+0.2);
  ctx.beginPath(); ctx.roundRect(-4,-4,8,16,3); ctx.fill(); ctx.restore();
  ctx.fillStyle='#f5cba7'; ctx.beginPath(); ctx.arc(0,-96,12,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#1a1a1a'; ctx.fillRect(-14,-107,28,8);
  ctx.beginPath(); ctx.arc(0,-107,12,Math.PI,0); ctx.fill();
  ctx.beginPath(); ctx.arc(12,-102,4,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.8)'; ctx.font='bold 9px Outfit';
  ctx.textAlign='center'; ctx.fillText('9',0,-68);
  ctx.restore();
}

// ============================================================
//  포수
// ============================================================
function drawCatcher() {
  const x=W/2+62, y=H-40;
  ctx.save(); ctx.translate(x,y);
  ctx.fillStyle='#333';
  ctx.fillRect(-16,-40,14,40); ctx.fillRect(3,-40,14,40);
  ctx.fillStyle='#222'; ctx.fillRect(-19,-6,17,9); ctx.fillRect(2,-6,17,9);
  ctx.fillStyle='#2a2a3a';
  ctx.beginPath(); ctx.roundRect(-22,-72,44,34,6); ctx.fill();
  ctx.fillStyle='#3a3a4a';
  ctx.beginPath(); ctx.roundRect(-20,-70,40,30,5); ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.09)'; ctx.lineWidth=1;
  for(let i=1;i<3;i++){ctx.beginPath();ctx.moveTo(-20,-70+i*10);ctx.lineTo(20,-70+i*10);ctx.stroke();}
  ctx.fillStyle='#8B5E3C'; ctx.beginPath(); ctx.arc(-32,-50,14,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#5a3a1a'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.arc(-32,-50,10,0.3,Math.PI*0.8); ctx.stroke();
  ctx.fillStyle='#f5cba7'; ctx.beginPath(); ctx.arc(0,-80,12,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#222'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(0,-80,12,0,Math.PI*2); ctx.stroke();
  for(let i=-8;i<=8;i+=4){ctx.beginPath();ctx.moveTo(i,-92);ctx.lineTo(i,-68);ctx.stroke();}
  for(let i=-10;i<=0;i+=4){ctx.beginPath();ctx.moveTo(-12,i-80);ctx.lineTo(12,i-80);ctx.stroke();}
  ctx.restore();
}

// ============================================================
//  공 (원근감)
// ============================================================
function drawBall() {
  const b=G.ball; if(!b) return;
  const p=b.t/b.dur;
  if(p>0.3){
    const prevP=Math.max(0,p-0.07);
    const prevEp=prevP*prevP;
    const prevX=lerp(b.startX,b.endX,prevEp);
    const prevY=lerp(b.startY,b.endY,prevEp);
    const prevR=1.8+prevP*11;
    ctx.globalAlpha=0.18;
    ctx.fillStyle='#fff';
    ctx.beginPath();ctx.arc(prevX,prevY,prevR*0.65,0,Math.PI*2);ctx.fill();
    ctx.globalAlpha=1;
  }
  const shadowX=lerp(W/2,b.endX,p*p);
  ctx.fillStyle='rgba(0,0,0,0.13)';
  ctx.beginPath();ctx.ellipse(shadowX,H-26,b.r*1.7*p,b.r*0.38,0,0,Math.PI*2);ctx.fill();
  const bg=ctx.createRadialGradient(b.x-b.r*0.3,b.y-b.r*0.3,0,b.x,b.y,b.r);
  bg.addColorStop(0,'#fff');bg.addColorStop(0.5,'#f0e8d8');bg.addColorStop(1,'#c8a87a');
  ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);
  ctx.fillStyle=bg;ctx.fill();
  if(b.r>5){
    ctx.globalAlpha=Math.min(1,(b.r-5)/7);
    ctx.strokeStyle='#cc3333';ctx.lineWidth=Math.max(0.6,b.r*0.07);
    ctx.beginPath();ctx.arc(b.x,b.y,b.r*0.45,-0.4,0.85);ctx.stroke();
    ctx.beginPath();ctx.arc(b.x,b.y,b.r*0.45,Math.PI-0.85,Math.PI+0.4);ctx.stroke();
    ctx.globalAlpha=1;
  }
  if(p<0.28&&b.type!=='straight'){
    const tn={curve:'커브',slider:'슬라이더',changeup:'체인지업',cutter:'커터'};
    ctx.font='bold 11px Outfit';ctx.fillStyle='rgba(249,199,79,0.8)';
    ctx.textAlign='center';ctx.textBaseline='bottom';
    ctx.fillText(tn[b.type]||'',b.x,b.y-b.r-4);
  }
}

// ============================================================
//  레이더건 구속 표시
// ============================================================
const TYPE_KO = { straight:'직구', cutter:'커터', slider:'슬라이더', curve:'커브', changeup:'체인지업' };
const TYPE_COLOR = {
  straight: '#f9c74f',  // 노랑
  cutter:   '#e63946',  // 빨강
  slider:   '#06d6a0',  // 초록
  curve:    '#9b5de5',  // 보라
  changeup: '#118ab2',  // 파랑
};

function drawRadarGun() {
  // 비행 중 공이 있으면 구종 + 속도 미리 표시 (페이드인)
  const b = G.ball;
  if (b && b.t > 5) {
    const p = b.t / b.dur;
    const a = Math.min(p * 4, 1) * 0.85;
    _renderRadar(b.kph, b.type, a, true);
  }
  // 착지 후 레이더건 표시
  const rg = G.radarGun;
  if (!rg) return;
  rg.frame++;
  if (rg.frame > rg.dur) { G.radarGun = null; return; }
  const a = rg.frame < 10 ? rg.frame / 10 : rg.frame > rg.dur - 20 ? (rg.dur - rg.frame) / 20 : 1;
  // 착지 후엔 공이 없으므로 단독 표시
  if (!b) _renderRadar(rg.kph, rg.type, a, false);
}

function _renderRadar(kph, type, alpha, inFlight) {
  const RX = W - 14, RY = 14;   // 우측 상단 고정
  const rw = 130, rh = 72;
  const rx = RX - rw, ry = RY;
  const col = TYPE_COLOR[type] || '#f9c74f';

  ctx.globalAlpha = alpha;

  // 배경 패널
  ctx.fillStyle = 'rgba(4,8,20,0.88)';
  ctx.beginPath(); ctx.roundRect(rx, ry, rw, rh, 10); ctx.fill();
  ctx.strokeStyle = col + '80';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(rx, ry, rw, rh, 10); ctx.stroke();

  // 상단 레이블 "RADAR GUN"
  ctx.font = 'bold 9px Outfit';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillText('RADAR GUN', rx + rw/2, ry + 7);

  // 구속 숫자 (크게)
  ctx.font = 'bold 36px Outfit';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = col; ctx.shadowBlur = inFlight ? 6 : 18;
  ctx.fillText(kph, rx + rw - 32, ry + rh/2 + 4);
  ctx.shadowBlur = 0;

  // km/h 단위
  ctx.font = 'bold 11px Outfit';
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('km/h', rx + rw - 28, ry + rh/2 + 16);

  // 구종 배지
  const badgeX = rx + 10, badgeY = ry + rh - 20;
  ctx.fillStyle = col + 'cc';
  ctx.beginPath(); ctx.roundRect(badgeX, badgeY, 50, 18, 4); ctx.fill();
  ctx.font = 'bold 11px Outfit';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(TYPE_KO[type] || type, badgeX + 25, badgeY + 9);

  // 속도 바 (시각적 게이지)
  const barX = rx + 10, barY = ry + 22, barW = rw - 20, barH = 5;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 3); ctx.fill();
  // 직구 최대(153) 기준 비율
  const ratio = Math.min((kph - 108) / (153 - 108), 1);
  const barGrd = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  barGrd.addColorStop(0, '#118ab2'); barGrd.addColorStop(0.5, '#06d6a0'); barGrd.addColorStop(1, '#f9c74f');
  ctx.fillStyle = barGrd;
  ctx.beginPath(); ctx.roundRect(barX, barY, barW * ratio, barH, 3); ctx.fill();

  ctx.globalAlpha = 1;
}

// ============================================================
//  메인 루프
// ============================================================
function loop() {
  ctx.clearRect(0,0,W,H);
  drawBG();
  drawBaselines();
  drawBases();
  drawStrikeZone();
  drawHomePlate();
  drawPitcher();
  drawCatcher();
  drawBatter();
  updateBall(); drawBall();
  updateRunners(); drawRunners();
  updateSteal(); drawStealRunner();
  drawABSResult();
  drawTimingBar();
  drawRadarGun();
  drawFlash();
  if(G.ceremony){updateCeremony();drawCeremony();}
  requestAnimationFrame(loop);
}

// ── utils ──
function lerp(a,b,t)  { return a+(b-a)*t; }
function easeInOut(t) { return t<0.5?2*t*t:-1+(4-2*t)*t; }

// ============================================================
//  시작
// ============================================================
showOverlay('⚾ 야구 게임', '3이닝 실전 야구! 타자 & 투수를 모두 경험해요', '게임 시작!', startGame);
loop();
