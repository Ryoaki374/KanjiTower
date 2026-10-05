// 実際のゲームコードとMatter.jsを使い、描画だけを省いて接触前後の操作を検証する。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const Matter = require(path.join(root, 'lib/matter.min.js'));
const fontBytes = fs.readFileSync(path.join(root, 'font/NotoSansCJKjp-Bold.otf'));
const elements = new Map();
const listeners = new Map();

function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      value: 'attack', style: {}, dataset: {}, classList: { toggle() {} },
      setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, width: 480 }),
      addEventListener() {}, replaceChildren() {}, focus() {}, getContext: () => ({}),
    });
  }
  return elements.get(id);
}

const sandbox = {
  Matter,
  opentype: require(path.join(root, 'lib/opentype.min.js')),
  earcut: require(path.join(root, 'lib/earcut.min.js')),
  console,
  performance,
  innerWidth: 390, innerHeight: 844,
  matchMedia: () => ({ matches: process.env.TEST_MOBILE === '1' }),
  requestAnimationFrame() {},
  fetch: async () => ({ ok: true, arrayBuffer: async () => fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength) }),
  document: {
    getElementById: element,
    querySelectorAll: () => [],
    querySelector: () => ({ value: 'attack' }),
    createElement: () => ({}),
    addEventListener() {},
    body: { dataset: {} },
  },
  addEventListener(name, handler) { listeners.set(name, handler); },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'geometry.js'), 'utf8'), sandbox);

// テスト用の窓口はメモリー内だけに追加し、配布ゲームには公開しない。
let source = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
source = source.replace('  init();', `
  window.testGame = {
    initialize: loadFont, startMode, createCharacter, step,
    updateActiveBody, dropActive, beginGesture, moveGesture, endGesture, updateCamera, spawnCharacter,
    holdGesture: () => { gesture.startedAt -= 200; },
    pressedKeys,
    activeRecord: () => active,
    difficultCharacters: RUSH.difficultCharacters,
    geometry: character => GlyphGeometry.createGlyphGeometry(font, character, CONFIG),
    takeQueuedCharacter() {
      const character = nextCharacters.shift();
      spawnedCount++;
      refillQueue();
      return character;
    },
  };`);
vm.runInContext(source, sandbox);

(async () => {
  const game = sandbox.testGame;
  await game.initialize();
  for (const mode of ['score', 'dopamine']) {
    game.startMode(mode);
    assert.equal(element('instructions').hidden, false, '開始時に操作説明');
    assert.equal(game.spawnCharacter('山'), false, '説明中は生成しない');
    for (let i = 0; i < 590; i++) game.step(1000 / 120);
    assert.equal(element('instructions').hidden, false, '約5秒間説明する');
    for (let i = 0; i < 12; i++) game.step(1000 / 120);
    assert.equal(element('instructions').hidden, true, '説明後にプレー開始');
    game.startMode(mode);
    game.createCharacter('山');
    const body = game.activeRecord().body;
    Matter.Body.translate(body, { x: 0, y: 21 - body.bounds.min.y });
    game.activeRecord().touched = true;
    game.updateCamera();
    assert.equal(sandbox.KanjiTower.getState().cameraY, 0, '上端内なら固定');
    Matter.Body.translate(body, { x: 0, y: -22 });
    game.updateCamera();
    const scrolled = sandbox.KanjiTower.getState().cameraY;
    assert(scrolled < 0, '上端を越えたらスクロール');
    Matter.Body.translate(body, { x: 0, y: 50 });
    game.updateCamera();
    assert.equal(sandbox.KanjiTower.getState().cameraY, scrolled, '収まった後は固定');
  }
  const config = sandbox.KanjiTower.config;
  assert.equal(config.gravity, 0.75, '重力を変更しない');
  assert.equal(config.maxFallSpeed, 7, '落下速度の上限を変更しない');
  assert.equal(config.height, process.env.TEST_MOBILE === '1' ? 910 : 580);
  game.startMode('score');
  game.createCharacter('山');
  const fallDistance = config.groundY - game.activeRecord().body.position.y;
  assert.equal(config.height, 468, 'スコアモードは短い画面');
  assert.equal(fallDistance, 315, 'スコアモードの落下距離');
  game.activeRecord().touched = true;
  const scoreBody = game.activeRecord().body;
  for (const [height, expected] of [[379, 0], [380, -150], [529, -150], [530, -300], [200, -300]]) {
    Matter.Body.translate(scoreBody, { x: 0, y: config.groundY - height - scoreBody.bounds.min.y });
    game.updateCamera();
    assert.equal(sandbox.KanjiTower.getState().cameraY, expected, '380pxから150px刻みでスクロール');
  }
  for (const mode of ['score', 'dopamine']) {
    game.startMode(mode);
    game.createCharacter('山', mode === 'dopamine');
    const touch = (x, id = 1) => ({ pointerType: 'touch', pointerId: id, clientX: x, clientY: 200, preventDefault() {} });
    game.beginGesture(touch(400));
    game.updateActiveBody(1000 / 120);
    assert.equal(game.activeRecord().body.velocity.x, 0, '短いタップは移動しない');
    game.holdGesture();
    game.updateActiveBody(1000 / 120);
    assert(game.activeRecord().body.velocity.x > 0, '右長押しで右移動');
    game.moveGesture(touch(350));
    game.updateActiveBody(1000 / 120);
    assert(game.activeRecord().body.angularVelocity < 0, '左になぞると左回転');
    game.endGesture(touch(350));
    game.beginGesture(touch(30));
    game.holdGesture();
    game.updateActiveBody(1000 / 120);
    assert(game.activeRecord().body.velocity.x < 0, '左長押しで左移動');
    game.activeRecord().touched = true;
    const velocity = game.activeRecord().body.velocity.x;
    game.moveGesture(touch(200));
    game.updateActiveBody(1000 / 120);
    assert.equal(game.activeRecord().body.velocity.x, velocity, '接触後はタッチ操作無効');
    game.startMode(mode);
    game.createCharacter('口', mode === 'dopamine');
    game.updateActiveBody(1000 / 120);
    assert.equal(game.activeRecord().body.velocity.x, 0, 'リセット後に長押しを持ち越さない');
    for (const supportType of ['floor', 'glyph']) {
      game.startMode(mode);
      let contactHeight = sandbox.KanjiTower.config.groundY;
      if (supportType === 'glyph') {
        game.createCharacter('一', mode === 'dopamine');
        const support = game.activeRecord().body;
        Matter.Body.setPosition(support, { x: 240, y: 300 });
        Matter.Body.setStatic(support, true);
        contactHeight = support.bounds.min.y;
      }
      game.createCharacter('山', mode === 'dopamine');
      const record = game.activeRecord();
      game.pressedKeys.add('ArrowRight');
      game.pressedKeys.add('KeyE');
      game.updateActiveBody(1000 / 120);
      assert(record.body.velocity.x > 0, '接触前は移動できる');
      assert(record.body.angularVelocity > 0, '接触前は回転できる');
      game.pressedKeys.clear();
      Matter.Body.setAngle(record.body, 0);
      Matter.Body.setAngularVelocity(record.body, 0);
      Matter.Body.translate(record.body, { x: 240 - record.body.position.x, y: contactHeight - 1 - record.body.bounds.max.y });
      Matter.Body.setVelocity(record.body, { x: 0, y: 3 });
      for (let step = 0; step < 120 && !record.touched; step++) game.step(1000 / 120);
      assert(record.touched, '実際の物理接触を検出する');
      assert(!record.settled, '静止確定より先に操作を終了する');
      assert.equal(sandbox.KanjiTower.getState().controllable, false);

      const motion = () => JSON.stringify({ position: record.body.position, velocity: record.body.velocity, angle: record.body.angle, angularVelocity: record.body.angularVelocity });
      for (const key of ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'Space']) {
        const before = motion();
        listeners.get('keydown')({ code: key, target: { tagName: 'CANVAS' }, preventDefault() {} });
        assert.equal(game.pressedKeys.size, 0, '接触後のキーは受け付けない');
        game.pressedKeys.add(key); // 既存の押しっぱなし状態も操作関数側で防ぐ。
        game.updateActiveBody(1000 / 120);
        game.dropActive();
        assert.equal(motion(), before, '接触後は位置・速度・回転を操作で変えない');
        game.pressedKeys.clear();
      }
      Matter.Body.translate(record.body, { x: 0, y: -80 });
      game.step(1000 / 120);
      assert(record.touched, '接触が解けても操作を再開しない');
      assert(!record.body.isStatic, '文字は固定されず物理演算を続ける');
      console.log('PASS contact lock:', mode, supportType);
    }
  }

  game.startMode('dopamine');
  const sequence = Array.from({ length: 20 }, () => game.takeQueuedCharacter());
  assert(!game.difficultCharacters.includes(sequence[0]));
  assert(!game.difficultCharacters.includes(sequence[1]));
  for (let index = 3; index < sequence.length; index += 4) {
    assert(game.difficultCharacters.includes(sequence[index]), '4字ごとに難字を保証する');
  }
  for (const character of game.difficultCharacters) {
    const geometry = game.geometry(character);
    assert(geometry.polygons.length > 0, character + ' の形状を生成できる');
  }
  console.log('PASS difficult queue:', sequence.join(' '));
  console.log('PASS all 15 difficult glyphs');
})().catch(error => { console.error(error); process.exitCode = 1; });
