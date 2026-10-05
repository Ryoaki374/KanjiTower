'use strict';

// スマホは同じ物理速度のまま、縦の落下距離を広げる。
const mobileLayout = window.matchMedia?.('(max-width: 600px) and (pointer: coarse)').matches ?? false;
const playHeight = mobileLayout
  ? Math.max(760, Math.min(1100, Math.round((window.innerHeight - 150) * 480 / Math.max(280, window.innerWidth - 24))))
  : 580;
const extraFallTime = (playHeight - 580) / 9 * (1000 / 60);

// 速度はMatter.jsの60Hz換算値。シミュレーション自体は120Hzで更新する。
const CONFIG = Object.freeze({
  gravity: 0.75,
  friction: 0.85,
  frictionStatic: 1.4,
  restitution: 0.015,
  density: 0.002,
  angularDamping: 0.025,
  linearDamping: 0.012,
  characterScale: 88,
  rotationSpeed: 0.035,
  horizontalMoveSpeed: 2.5,
  curveSampleStep: 3,
  simplifyTolerance: 0.12,
  massExponent: 1,
  massReferenceArea: 2400, // 1: 黒領域の面積に比例、0.5: 平方根で質量差を圧縮
  aimDuration: 1500,
  aimFallSpeed: 0.45,
  maxFallSpeed: 7,
  settleDuration: 650,
  settleSpeed: 0.38,
  settleAngularSpeed: 0.018,
  fixedDelta: 1000 / 120,
  maxCharacters: 60,
  maxMisses: 3,
  width: 480,
  height: playHeight,
  groundY: playHeight - 68,
  platformWidth: 330,
});

// 自動落下は実時間ではなくシミュレーション時間で予約する。
// タブを離れている間に次の文字が溜まることはない。
const RUSH = Object.freeze({
  countdownMs: 3000,
  initialIntervalMs: 2200 + extraFallTime,
  minimumIntervalMs: 1050 + extraFallTime,
  intervalReductionMs: 140,
  charactersPerLevel: 5,
  nextAfterLandingMs: 200,
  settleDurationMs: 180,
  initialGravity: 1.05,
  gravityPerLevel: 0.08,
  maximumGravity: 1.65,
  maxFallSpeed: 9,
  horizontalMoveSpeed: 3.5,
  openingCharacters: Array.from('一二口日山工土王'),
  characters: Array.from('一二三口日目田山工土王川人木大凹凸中十井立正生上士'),
  difficultCharacters: Array.from('龍鬱傘響驚鷹鶴藤舞飛風夢森轟凛'),
  difficultEvery: 4, // 4・8・12…字目は必ず難字。NEXTにもあらかじめ表示する。
  difficultChance: 0.15,
  difficultChancePerLevel: 0.05,
  maximumDifficultChance: 0.4,
});

(() => {
  const getElement = (id) => document.getElementById(id);
  const canvas = getElement('game');
  const context = canvas.getContext('2d');
  const pressedKeys = new Set();
  const geometryCache = new Map();
  let gesture = null;

  function clearControls() {
    pressedKeys.clear();
    gesture = null;
  }

  function beginGesture(event) {
    if (event.pointerType === 'mouse' || gesture || !active || active.touched || gameOver) return;
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    gesture = {
      pointerId: event.pointerId, bodyId: active.body.id,
      startX: event.clientX, startY: event.clientY, lastX: event.clientX,
      startedAt: performance.now(), width: bounds.width,
      direction: event.clientX < bounds.left + bounds.width / 2 ? -1 : 1,
      rotating: false, pendingAngle: 0,
    };
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({ preventScroll: true });
  }

  function moveGesture(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    if (!active || active.touched || gameOver || active.body.id !== gesture.bodyId) {
      gesture = null;
      return;
    }
    // 指を置いたままなら移動、なぞり始めたら回転に切り替える。
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 10)
      gesture.rotating = true;
    if (gesture.rotating)
      gesture.pendingAngle += (event.clientX - gesture.lastX) / gesture.width * Math.PI * 2;
    gesture.lastX = event.clientX;
  }

  function endGesture(event) {
    if (gesture?.pointerId === event.pointerId) gesture = null;
  }

  // 落ちた文字も使用済みに残す。リスタートしたときだけ解除する。
  const usedCharacters = new Set();

  let mode = null;
  let practice = false;
  let nextCharacters = [];
  let nextDropAt = Infinity;
  let dropIntervalMs = RUSH.initialIntervalMs;
  let spawnedCount = 0;
  let feedbackUntil = 0;
  const recordsByBodyId = new Map();

  let font;
  let engine;
  let ground;
  let characters = [];
  let active = null;
  let lost = 0;
  let peakHeight = 0;
  let gameOver = false;
  let debug = false;
  let cameraY = 0;
  let simulationTime = 0;
  let lastFrameTime = 0;
  let accumulator = 0;
  let composing = false;
  let lastCompositionEnd = -Infinity;

  const { Engine, Body, Bodies, Composite, Events, Sleeping } = window.Matter || {};

  function message(text, error = false) {
    getElement('message').textContent = text;
    getElement('message').classList.toggle('error', error);
  }


  function updateUsedCharacters() {
    getElement('used-characters').textContent = usedCharacters.size
      ? `使用済み：${Array.from(usedCharacters).join('・')}`
      : '使用済み：なし';

    document.querySelectorAll('[data-char]').forEach((button) => {
      const isUsed = usedCharacters.has(button.dataset.char);
      button.disabled = isUsed;
      button.title = isUsed ? 'このゲームでは使用済みです' : '';
    });
  }

  async function loadFont() {
    if (!window.Matter || !window.opentype || !window.earcut)
      throw new Error('ライブラリを読み込めません。lib フォルダーを確認してください。');
    const response = await fetch('font/NotoSansCJKjp-Bold.otf');
    if (!response.ok)
      throw new Error('フォントを読み込めません。HTTPサーバーから開いてください。');
    font = opentype.parse(await response.arrayBuffer());
  }

  function getMissLimit() {
    if (mode === 'dopamine') return 1;
    return practice ? Infinity : CONFIG.maxMisses;
  }

  function getRushLevel() {
    const stacked = characters.filter((record) => record.settled).length;
    return 1 + Math.floor(stacked / RUSH.charactersPerLevel);
  }

  function getRushInterval() {
    return Math.max(
      RUSH.minimumIntervalMs,
      RUSH.initialIntervalMs - (getRushLevel() - 1) * RUSH.intervalReductionMs,
    );
  }

  function updateModeDisplay() {
    const isRush = mode === 'dopamine';
    document.body.dataset.mode = mode || 'menu';
    getElement('mode-select').hidden = mode !== null;
    getElement('input-panel').hidden = mode !== 'score';
    getElement('rush-panel').hidden = !isRush;
    getElement('change-mode').hidden = mode === null;
    getElement('restart').disabled = !mode;
    getElement('mode-label').textContent = !mode
      ? '遊び方を選ぼう'
      : isRush
        ? 'ドーパミンモード / 1ミスで終了'
        : practice
          ? 'スコアモード / 練習・ミス無制限'
          : 'スコアモード / スコアアタック';
  }

  function startMode(selectedMode) {
    if (!font) return;
    mode = selectedMode;
    practice =
      mode === 'score' &&
      document.querySelector('[name="score-rule"]:checked').value === 'practice';
    restart();
    canvas.focus({ preventScroll: true });
  }

  function showModeMenu() {
    mode = null;
    practice = false;
    restart();
    getElement('start-score').focus({ preventScroll: true });
  }

  function refillQueue() {
    while (nextCharacters.length < 3) {
      const ordinal = spawnedCount + nextCharacters.length + 1;
      const difficultChance = Math.min(
        RUSH.maximumDifficultChance,
        RUSH.difficultChance + (getRushLevel() - 1) * RUSH.difficultChancePerLevel,
      );
      const isDifficult =
        ordinal > 2 &&
        (ordinal % RUSH.difficultEvery === 0 || Math.random() < difficultChance);
      const pool = isDifficult
        ? RUSH.difficultCharacters
        : ordinal <= 5
          ? RUSH.openingCharacters
          : RUSH.characters;
      nextCharacters.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    getElement('next-characters').replaceChildren(
      ...nextCharacters.map((character) => {
        const tile = document.createElement('span');
        tile.textContent = character;
        return tile;
      }),
    );
  }

  function finishGame(title, explanation) {
    gameOver = true;
    clearControls();
    nextDropAt = Infinity;
    getElement('instructions').hidden = true;
    getElement('stack-feedback').hidden = true;
    getElement('spawn').disabled = true;
    getElement('game-over').hidden = false;
    getElement('result-title').textContent = title;
    const count = characters.filter((record) => record.settled).length;
    getElement('result').textContent =
      explanation + ' / ' + count + ' 字 / 最大 ' + Math.round(peakHeight) + ' px';
    getElement('active-label').textContent = '終了';
    message(explanation);
  }

  function updateAutomaticDrops() {
    if (mode !== 'dopamine' || gameOver) return;

    if (simulationTime < nextDropAt) return;

    // デモの負荷上限。最後の字の着地を待ってからクリアにする。
    if (characters.length >= CONFIG.maxCharacters) {
      if (characters.every((record) => record.settled)) {
        finishGame('60字、積み切った！', 'ドーパミンモード クリア');
      }
      return;
    }

    const character = nextCharacters.shift();
    try {
      createCharacter(character, true);
      spawnedCount++;
      refillQueue();
      dropIntervalMs = getRushInterval();
      nextDropAt = simulationTime + dropIntervalMs;
    } catch (error) {
      console.error(error);
      finishGame('生成を中断しました', error.message);
    }
  }

  function updateRushDisplay() {
    if (mode !== 'dopamine') return;
    const remaining = Math.max(0, nextDropAt - simulationTime);
    getElement('speed-level').textContent =
      'SPEED ' + String(getRushLevel()).padStart(2, '0');
    getElement('drop-time').textContent = gameOver
      ? 'FINISH'
      : spawnedCount === 0
        ? 'まもなくスタート'
        : characters.length >= CONFIG.maxCharacters
          ? '最後の着地を待っています'
          : '次の一字まで ' + (remaining / 1000).toFixed(1) + ' 秒';
    getElement('drop-progress').style.transform =
      'scaleX(' + (gameOver ? 0 : Math.min(1, remaining / dropIntervalMs)) + ')';
    getElement('stack-feedback').hidden = gameOver || simulationTime >= feedbackUntil;
  }

  function restart() {
    clearControls();
    usedCharacters.clear();
    recordsByBodyId.clear();
    nextCharacters = [];
    spawnedCount = 0;
    feedbackUntil = 0;
    nextDropAt = mode === 'dopamine' ? RUSH.countdownMs : Infinity;
    dropIntervalMs = RUSH.initialIntervalMs;
    updateModeDisplay();
    getElement('stack-feedback').hidden = true;

    if (mode === 'dopamine') refillQueue();
    updateUsedCharacters();
    if (engine) {
      Events.off(engine);
      Composite.clear(engine.world, false);
      Engine.clear(engine);
    }
    engine = Engine.create({
      enableSleeping: true,
      positionIterations: 10,
      velocityIterations: 8,
    });
    engine.gravity.y = CONFIG.gravity;
    ground = Bodies.rectangle(
      CONFIG.width / 2,
      CONFIG.groundY + 12,
      CONFIG.platformWidth,
      24,
      {
        isStatic: true,
        friction: CONFIG.friction,
        frictionStatic: CONFIG.frictionStatic,
        restitution: 0,
        label: 'ground',
      },
    );
    Composite.add(engine.world, ground);
    characters = [];
    active = null;
    lost = 0;
    peakHeight = 0;
    cameraY = 0;
    simulationTime = 0;
    accumulator = 0;
    lastFrameTime = 0;
    gameOver = false;
    getElement('game-over').hidden = true;
    getElement('empty').hidden = mode !== 'score';
    getElement('spawn').disabled = !font || mode !== 'score';
    getElement('active-label').textContent = '待機中';
    Events.on(engine, 'collisionStart', onContact);
    Events.on(engine, 'collisionActive', onContact);
    updateScore();
    if (mode === 'dopamine') {
      // リトライボタンにフォーカスが残ると、入力保護がゲームキーも遮断してしまう。
      canvas.focus({ preventScroll: true });
    }
    updateInstructions();
    if (font) message('漢字を1文字入力して、生成してください。');
  }

  function onContact(event) {
    for (const pair of event.pairs) {
      for (const body of [pair.bodyA.parent, pair.bodyB.parent]) {
        const record = recordsByBodyId.get(body.id);
        if (record && !record.settled) {
          record.lastContact = simulationTime;
          const firstContact = !record.touched;
          record.touched = true;
          if (firstContact && record === active) {
            // 接触した瞬間に操作を終える。跳ね返って離れても再開しない。
            // 速度や位置は固定せず、その後の滑り・転がりは物理演算に任せる。
            clearControls();
            getElement('active-label').textContent =
              '操作終了「' + record.character + '」';
            if (mode === 'score')
              message('接触したので操作終了。動きが落ち着くと次の一字へ。');
          }
        }
      }
    }
  }

  function createCharacter(character, automatic = false) {
    let geometry = geometryCache.get(character);
    if (!geometry) {
      geometry = GlyphGeometry.createGlyphGeometry(font, character, CONFIG);
      geometryCache.set(character, geometry);
    }
    updateCamera();
    const horizontalOffset = automatic ? (Math.random() - 0.5) * 65 : 0;
    const body = GlyphGeometry.glyphToMatterBody(
      geometry,
      CONFIG.width / 2 + horizontalOffset,
      cameraY + 85,
      CONFIG,
    );
    if (automatic) {
      Body.setAngle(body, (Math.random() - 0.5) * 0.12);
      Body.setVelocity(body, { x: 0, y: 2.8 });
    }
    const record = {
      body,
      character,
      settled: false,
      spawnTime: simulationTime,
      lastContact: -Infinity,
      touched: false,
      stableFor: 0,
      fastDrop: automatic,
    };
    characters.push(record);
    recordsByBodyId.set(body.id, record);
    active = record;
    Composite.add(engine.world, body);
    if (!automatic) {
      // 生成成功時だけ消費する。自動落下では同じ字も出現する。
      usedCharacters.add(character);
      updateUsedCharacters();
    }
    getElement('empty').hidden = true;
    getElement('spawn').disabled = true;
    getElement('active-label').textContent = '操作中「' + character + '」';
    clearControls();
  }

  function spawnCharacter(value) {
    if (mode !== 'score' || simulationTime < RUSH.countdownMs) return false;
    if (!font) {
      message('フォントを読み込み中です。', true);
      return false;
    }
    const inputCharacters = Array.from(value.trim());
    if (inputCharacters.length !== 1) {
      message(
        inputCharacters.length
          ? '漢字は1文字だけ入力してください。'
          : '漢字を1文字入力してください。',
        true,
      );
      return false;
    }
    if (font.charToGlyph(inputCharacters[0]).index === 0) {
      message('この文字は現在のフォントでは使用できません', true);
      return false;
    }
    if (!/\p{Script=Han}/u.test(inputCharacters[0])) {
      message('漢字を1文字入力してください。', true);
      return false;
    }
    if (gameOver) {
      message('リスタートすると、もう一度遊べます。', true);
      return false;
    }
    if (usedCharacters.has(inputCharacters[0])) {
      message(
        `「${inputCharacters[0]}」は使用済みです。同じ漢字は1ゲームにつき1回だけ使えます。`,
        true,
      );
      return false;
    }
    if (active) {
      message('今の文字が着地するまでお待ちください。', true);
      return false;
    }
    if (characters.length >= CONFIG.maxCharacters) {
      message('デモの上限（60文字）です。リスタートして遊んでください。', true);
      return false;
    }
    try {
      createCharacter(inputCharacters[0]);
      message('← → で移動 / Q E で回転 / Space で落下');
      canvas.focus({ preventScroll: true });
      return true;
    } catch (error) {
      console.error(error);
      message(error.message, true);
      return false;
    }
  }

  function dropActive() {
    if (!active || active.touched || gameOver) return;
    active.fastDrop = true;
    Sleeping.set(active.body, false);
    Body.setVelocity(active.body, {
      x: 0,
      y: mode === 'dopamine' ? RUSH.maxFallSpeed : CONFIG.maxFallSpeed,
    });
  }

  function updateActiveBody(deltaMs) {
    if (!active || active.touched || gameOver) return;
    const body = active.body;
    let direction =
      Number(pressedKeys.has('ArrowRight') || pressedKeys.has('KeyD')) -
      Number(pressedKeys.has('ArrowLeft') || pressedKeys.has('KeyA'));
    let rotation = Number(pressedKeys.has('KeyE')) - Number(pressedKeys.has('KeyQ'));
    if (gesture && gesture.bodyId === body.id) {
      if (gesture.rotating) {
        const turn = Math.max(-0.08, Math.min(0.08, gesture.pendingAngle));
        gesture.pendingAngle -= turn;
        rotation = turn / CONFIG.rotationSpeed;
        Body.setAngularVelocity(body, turn);
      } else if (performance.now() - gesture.startedAt >= 180) {
        direction = gesture.direction;
      }
    }
    if (direction || rotation) Sleeping.set(body, false);
    // 座標を直接動かさず、速度を変えて衝突判定を通す。
    if (direction)
      Body.setVelocity(body, {
        x:
          direction *
          (mode === 'dopamine' ? RUSH.horizontalMoveSpeed : CONFIG.horizontalMoveSpeed),
        y: body.velocity.y,
      });
    else if (!active.touched)
      Body.setVelocity(body, { x: body.velocity.x * 0.85, y: body.velocity.y });
    if (rotation) Body.setAngularVelocity(body, rotation * CONFIG.rotationSpeed);
    if (
      mode === 'score' &&
      !active.fastDrop &&
      !active.touched &&
      simulationTime - active.spawnTime < CONFIG.aimDuration
    ) {
      Body.setVelocity(body, {
        x: body.velocity.x,
        y: Math.min(body.velocity.y, CONFIG.aimFallSpeed),
      });
    }
  }

  function updateSettledCharacters(deltaMs) {
    const requiredTime =
      mode === 'dopamine' ? RUSH.settleDurationMs : CONFIG.settleDuration;
    for (const record of characters) {
      if (record.settled) continue;
      const body = record.body;
      const contact =
        simulationTime - record.lastContact < deltaMs * 3 ||
        (body.isSleeping && record.touched);
      if (
        contact &&
        body.speed < CONFIG.settleSpeed &&
        body.angularSpeed < CONFIG.settleAngularSpeed
      ) {
        record.stableFor += deltaMs;
      } else {
        record.stableFor = 0;
      }
      if (record.stableFor < requiredTime) continue;
      record.settled = true;
      if (record === active) {
        active = null;
        clearControls();
        getElement('spawn').disabled = mode !== 'score';
        getElement('active-label').textContent =
          mode === 'score' ? '入力待ち' : '次の一字へ';
        if (mode === 'score') {
          message('着地しました。次の漢字を入力して生成してください。');
        } else {
          // 早く積めたら待ち時間を短縮。未着地でも期限が来たら次の字へ進む。
          nextDropAt = Math.min(nextDropAt, simulationTime + RUSH.nextAfterLandingMs);
        }
      }
      if (mode === 'dopamine') {
        feedbackUntil = simulationTime + 550;
        const count = characters.filter((item) => item.settled).length;
        getElement('stack-feedback').textContent =
          count % 5 === 0 ? 'SPEED UP ↑' : '+1 / ' + count + ' STACK';
      }
    }
  }

  function checkGameOver() {
    const fallen = characters.filter(
      (record) =>
        record.body.bounds.min.y > CONFIG.groundY + 95 ||
        record.body.bounds.max.x < 0 ||
        record.body.bounds.min.x > CONFIG.width,
    );
    for (const record of fallen) {
      Composite.remove(engine.world, record.body);
      recordsByBodyId.delete(record.body.id);
      characters.splice(characters.indexOf(record), 1);
      lost++;
      if (active === record) {
        active = null;
        clearControls();
        getElement('spawn').disabled = mode !== 'score';
        getElement('active-label').textContent = '入力待ち';
      }
      const remaining = Math.max(0, getMissLimit() - lost);
      message(
        practice
          ? '落ちても大丈夫。形を試して、もう一字。'
          : '文字が台の外へ落ちました。残り ' + remaining + ' 回。',
      );
    }
    if (!gameOver && lost >= getMissLimit()) {
      finishGame(
        'ゲーム終了',
        mode === 'dopamine'
          ? '一字が落下。次はもっと高く！'
          : '3文字が台の外へ落ちました。',
      );
    }
  }

  function updateScore() {
    const settled = characters.filter((characterRecord) => characterRecord.settled);
    const top = settled.reduce(
      (v, characterRecord) => Math.min(v, characterRecord.body.bounds.min.y),
      CONFIG.groundY,
    );
    peakHeight = Math.max(peakHeight, CONFIG.groundY - top);
    getElement('score').innerHTML = `${settled.length}<small>点</small>`;
    getElement('count').innerHTML = `${settled.length}<small>字</small>`;
    getElement('height').innerHTML = `${Math.round(peakHeight)}<small>px</small>`;
    getElement('lost').innerHTML =
      `${lost}<small>/ ${Number.isFinite(getMissLimit()) ? getMissLimit() : '∞'}</small>`;
  }

  function step(deltaMs) {
    if (!mode || gameOver) return;
    simulationTime += deltaMs;
    updateInstructions();
    updateAutomaticDrops();
    if (gameOver) return;
    engine.gravity.y =
      mode === 'dopamine'
        ? Math.min(
            RUSH.maximumGravity,
            RUSH.initialGravity + (getRushLevel() - 1) * RUSH.gravityPerLevel,
          )
        : CONFIG.gravity;
    const maxFallSpeed = mode === 'dopamine' ? RUSH.maxFallSpeed : CONFIG.maxFallSpeed;
    updateActiveBody(deltaMs);
    for (const characterRecord of characters) {
      if (characterRecord.body.isSleeping) continue;
      Body.setAngularVelocity(
        characterRecord.body,
        characterRecord.body.angularVelocity *
          (1 - (CONFIG.angularDamping * deltaMs) / (1000 / 60)),
      );
      if (characterRecord.body.velocity.y > maxFallSpeed)
        Body.setVelocity(characterRecord.body, {
          x: characterRecord.body.velocity.x,
          y: maxFallSpeed,
        });
    }
    Engine.update(engine, deltaMs);
    updateSettledCharacters(deltaMs);
    checkGameOver();
  }

  function polygonPath(points) {
    context.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y);
    context.closePath();
  }

  function drawCharacter(characterRecord) {
    const body = characterRecord.body;
    context.save();
    context.translate(body.position.x, body.position.y);
    context.rotate(body.angle);
    context.fillStyle =
      characterRecord === active && !characterRecord.touched ? '#be4a34' : '#303b30';
    // パーツを一度に塗り、境界に描画上の継ぎ目が出るのを防ぐ。
    context.beginPath();
    for (const polygon of body.plugin.glyph.localPolygons) polygonPath(polygon);
    context.fill();
    context.restore();
  }

  function drawDebugBody(body) {
    const parts = body.parts.length > 1 ? body.parts.slice(1) : [body];
    context.strokeStyle = '#1ba39e';
    context.lineWidth = 0.65;
    for (const part of parts) {
      context.beginPath();
      polygonPath(part.vertices);
      context.stroke();
    }
    context.strokeStyle = '#be4a34';
    context.setLineDash([3, 3]);
    context.strokeRect(
      body.bounds.min.x,
      body.bounds.min.y,
      body.bounds.max.x - body.bounds.min.x,
      body.bounds.max.y - body.bounds.min.y,
    );
    context.setLineDash([]);
    context.fillStyle = '#bd3471';
    context.beginPath();
    context.arc(body.position.x, body.position.y, 2.5, 0, Math.PI * 2);
    context.fill();
    context.font = '9px monospace';
    context.fillText(
      '#' + body.id + ' / ' + parts.length + ' parts',
      body.bounds.min.x,
      body.bounds.min.y - 6,
    );
  }

  function updateCamera() {
    const top = characters.reduce(
      (height, record) => Math.min(height, record.body.bounds.min.y),
      CONFIG.groundY,
    );
    // 上端からはみ出したときだけ、次の一字を置く余白を作る。
    // タワーが低くなっても表示位置を戻さず、揺れによる往復を防ぐ。
    if (top < cameraY) cameraY = top - 160;
  }

  function updateInstructions() {
    const visible = !!mode && !gameOver && simulationTime < RUSH.countdownMs;
    getElement('instructions').hidden = !visible;
    getElement('instruction-time').textContent = visible
      ? String(Math.ceil((RUSH.countdownMs - simulationTime) / 1000)) : '';
    if (mode === 'score' && !active && !gameOver)
      getElement('spawn').disabled = !font || visible;
  }

  function renderScene() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(CONFIG.width * pixelRatio) ||
        canvas.height !== Math.round(CONFIG.height * pixelRatio)) {
      canvas.width = Math.round(CONFIG.width * pixelRatio);
      canvas.height = Math.round(CONFIG.height * pixelRatio);
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, CONFIG.width, CONFIG.height);
    context.save();
    context.translate(0, -cameraY);
    const bottom = cameraY + CONFIG.height;
    context.font = '600 20px system-ui';
    context.fillStyle = '#000000';
    context.strokeStyle = '#dce1d4';
    context.lineWidth = 0.7;
    for (let y = CONFIG.groundY; y > cameraY; y -= 100) {
      if (y > bottom || y < cameraY + 55) continue;
      context.beginPath();
      context.moveTo(14, y);
      context.lineTo(24, y);
      context.stroke();
      context.fillText(String(CONFIG.groundY - y), 29, y + 7);
    }
    const platformLeft = (CONFIG.width - CONFIG.platformWidth) / 2;
    context.fillStyle = '#303a30';
    context.fillRect(platformLeft, CONFIG.groundY, CONFIG.platformWidth, 24);
    context.fillStyle = '#d8ddce';
    context.fillRect(platformLeft, CONFIG.groundY + 24, CONFIG.platformWidth, 3);
    if (CONFIG.groundY > bottom) {
      context.fillStyle = '#000000';
      context.fillText(
        '↓ 地面まで ' + Math.round(CONFIG.groundY - bottom) + ' px',
        20,
        bottom - 35,
      );
    }
    for (const characterRecord of characters) {
      drawCharacter(characterRecord);
      if (debug) drawDebugBody(characterRecord.body);
    }
    context.restore();
  }

  function frame(time) {
    if (!lastFrameTime) lastFrameTime = time;
    accumulator += Math.min(time - lastFrameTime, 80);
    lastFrameTime = time;
    if (document.hidden) accumulator = 0;
    while (accumulator >= CONFIG.fixedDelta) {
      step(CONFIG.fixedDelta);
      accumulator -= CONFIG.fixedDelta;
    }
    if (!gameOver) updateCamera();
    updateScore();
    updateRushDisplay();
    renderScene();
    requestAnimationFrame(frame);
  }

  function bindInputEvents() {
    canvas.addEventListener('pointerdown', beginGesture);
    canvas.addEventListener('pointermove', moveGesture);
    canvas.addEventListener('pointerup', endGesture);
    canvas.addEventListener('pointercancel', endGesture);
    canvas.addEventListener('lostpointercapture', endGesture);
    getElement('start-score').addEventListener('click', () => startMode('score'));
    getElement('start-dopamine').addEventListener('click', () => startMode('dopamine'));
    getElement('change-mode').addEventListener('click', showModeMenu);
    getElement('spawn-form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!composing && performance.now() - lastCompositionEnd > 100)
        spawnCharacter(getElement('character').value);
    });
    getElement('character').addEventListener('compositionstart', () => {
      composing = true;
    });
    getElement('character').addEventListener('compositionend', () => {
      composing = false;
      lastCompositionEnd = performance.now();
    });
    getElement('character').addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) {
        if (event.key === 'Enter') event.preventDefault();
      }
    });
    document.querySelectorAll('[data-char]').forEach((button) =>
      button.addEventListener('click', () => {
        getElement('character').value = button.dataset.char;
        getElement('character').focus();
      }),
    );
    getElement('restart').addEventListener('click', restart);
    getElement('retry').addEventListener('click', restart);
    getElement('debug').addEventListener('change', (event) => {
      debug = event.target.checked;
    });
    const controls = ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'Space'];
    window.addEventListener('keydown', (event) => {
      if (
        event.isComposing ||
        /INPUT|TEXTAREA|BUTTON/.test(event.target.tagName) ||
        !controls.includes(event.code)
      )
        return;
      event.preventDefault();
      if (!active || active.touched || gameOver) return;
      pressedKeys.add(event.code);
      if (event.code === 'Space' && !event.repeat) dropActive();
    });
    window.addEventListener('keyup', (event) => pressedKeys.delete(event.code));
    window.addEventListener('blur', () => pressedKeys.clear());
    document.addEventListener('visibilitychange', () => {
      clearControls();
      accumulator = 0;
      lastFrameTime = 0;
    });
  }

  // 動作確認用。内部のSetや剛体を直接書き換えられないよう値をコピーして返す。
  window.KanjiTower = {
    config: CONFIG,
    getState: () => ({
      ready: !!font,
      mode,
      practice,
      level: getRushLevel(),
      spawnedCount,
      nextCharacters: [...nextCharacters],
      nextDropInMs: Number.isFinite(nextDropAt)
        ? Math.max(0, nextDropAt - simulationTime)
        : null,
      dropIntervalMs,
      simulationTime,
      active: active?.character ?? null,
      controllable: !!active && !active.touched && !gameOver,
      count: characters.filter((characterRecord) => characterRecord.settled).length,
      lost,
      peakHeight,
      gameOver,
      cameraY,
      usedCharacters: Array.from(usedCharacters),
      bodies: characters.map((characterRecord) => ({
        id: characterRecord.body.id,
        character: characterRecord.character,
        x: characterRecord.body.position.x,
        y: characterRecord.body.position.y,
        angle: characterRecord.body.angle,
        parts: characterRecord.body.parts.length,
        area: characterRecord.body.area,
        mass: characterRecord.body.mass,
        sleeping: characterRecord.body.isSleeping,
        settled: characterRecord.settled,
        touched: characterRecord.touched,
      })),
    }),
  };

  async function init() {
    try {
      await loadFont();
      // 抽選中に待たせないよう、候補の形状は開始前に一度だけ作っておく。
      for (const character of [...RUSH.characters, ...RUSH.difficultCharacters]) {
        geometryCache.set(
          character,
          GlyphGeometry.createGlyphGeometry(font, character, CONFIG),
        );
      }
      getElement('start-score').disabled = false;
      getElement('start-dopamine').disabled = false;
      getElement('mode-loading').textContent = ''; 
      restart();
      requestAnimationFrame(frame);
    } catch (error) {
      console.error(error);
      message(error.message + ' ページを再読み込みして再試行してください。', true);
      getElement('mode-loading').textContent =
        error.message + ' 再読み込みしてください。';
      getElement('restart').disabled = true;
      getElement('retry').disabled = true;
    }
  }
  bindInputEvents();
  init();
})();

