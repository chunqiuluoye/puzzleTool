const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const helpers = html.slice(html.indexOf('function writeSingleCropFields('), html.indexOf('function updateSingleCropView('));
const sync = html.slice(html.indexOf('function syncSingleCropFields('), html.indexOf('function loadSingleCropImage('));
const listeners = html.slice(html.indexOf("document.querySelectorAll('input[name=\"singleCropAlignment\"]').forEach(input => {"), html.indexOf("document.getElementById('singleCropConfirmBtn').addEventListener"));
function setup(fixed = false) {
    const elements = {};
    function element(id) {
        return elements[id] ||= { style: {}, events: {}, addEventListener(type, fn) { this.events[type] = fn; }, setPointerCapture() {} };
    }
    const state = { img: { width: 800, height: 600 }, x: 100, y: 100, width: 200, height: 160, dragging: null };
    const alignments = [0, 0.5, 1].flatMap(y => [0, 0.5, 1].map(x => Object.assign(element(`align-${x}-${y}`), { dataset: { x: String(x), y: String(y) }, checked: false })));
    const context = vm.createContext({
        singleCropState: state,
        singleCropFields: ['x', 'y', 'width', 'height'].map(key => ({ value: state[key] })),
        singleCropFixedRatio: { checked: fixed }, singleCropRatio: { value: 1.25 },
        singleCropImage: { clientWidth: 400, clientHeight: 300 }, singleCropSelection: element('selection'),
        document: { getElementById: element, querySelectorAll: () => alignments }, window: {}, clearTimeout,
        updateSingleCropView: () => context.updateSingleCropAlignmentControls()
    });
    vm.runInContext(helpers + sync + listeners, context);
    const send = (type, x = 0, y = 0, handle = '', pointerId = 1) => element('selection').events[type]({
        button: 0, pointerId, clientX: x, clientY: y, target: { className: handle }, preventDefault() {}
    });
    const drag = (x, y, handle = '') => { send('pointerdown', 0, 0, handle); send('pointermove', x, y); send('pointerup'); };
    return { context, state, elements, alignments, send, drag };
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('center preserves size and lock X permits only vertical movement; unlocking restores movement', () => {
    const { context: c, state: s, drag } = setup();
    c.alignSingleCrop(0.5, 0.5);
    assert.deepEqual([s.x, s.y, s.width, s.height], [300, 220, 200, 160]);
    c.setSingleCropAxisLock('x', true);
    drag(45, 30);
    assert.deepEqual([s.x, s.y, s.width, s.height], [300, 280, 200, 160]);
    assert.equal(c.singleCropFields[0].disabled, true);
    c.setSingleCropAxisLock('x', false);
    drag(20, 10);
    assert.deepEqual([s.x, s.y], [340, 300]);
});

test('lock Y permits horizontal movement, both locks prevent translation, center repositions locked axes', () => {
    const { context: c, state: s, drag } = setup();
    c.setSingleCropAxisLock('y', true);
    drag(20, 30);
    assert.deepEqual([s.x, s.y], [140, 100]);
    c.setSingleCropAxisLock('x', true);
    drag(100, -50);
    assert.deepEqual([s.x, s.y], [140, 100]);
    c.alignSingleCrop(0.5, 0.5);
    assert.deepEqual([s.lockX, s.lockY, s.x, s.y], [true, true, 300, 220]);
});

test('axis locks leave all four resize handles identical to unlocked behavior, including image boundaries', () => {
    for (const fixed of [false, true]) for (const axes of [['x'], ['y'], ['x', 'y']]) {
        for (const handle of ['tl', 'tr', 'bl', 'br']) for (const distance of [15, -15, 1000, -1000]) {
            const { context: c, state: s, drag } = setup(fixed);
            const unlocked = setup(fixed);
            axes.forEach(axis => c.setSingleCropAxisLock(axis, true));
            drag(distance, distance / 2, handle);
            unlocked.drag(distance, distance / 2, handle);
            for (const key of ['x', 'y', 'width', 'height']) close(s[key], unlocked.state[key]);
            assert.ok(s.width > 0 && s.height > 0);
            assert.ok(s.x >= -1e-8 && s.y >= -1e-8 && s.x + s.width <= 800 + 1e-8 && s.y + s.height <= 600 + 1e-8);
            if (fixed) close(s.width / s.height, 1.25);
            if (Math.abs(distance) === 15) assert.notEqual(s.width, 200);
        }
    }
});

test('numeric size changes work normally without locking dimensions or forcing a ratio', () => {
    const { context: c, state: s } = setup();
    c.alignSingleCrop(0.5, 0.5);
    c.setSingleCropAxisLock('x', true);
    c.setSingleCropAxisLock('y', true);
    c.singleCropFields[2].value = 300;
    c.singleCropFields[3].value = 100;
    c.syncSingleCropFields();
    assert.deepEqual([s.x, s.y, s.width, s.height], [300, 220, 300, 100]);
    c.singleCropFields[2].value = 2000;
    c.singleCropFields[3].value = 2000;
    c.syncSingleCropFields();
    assert.deepEqual([s.x, s.y, s.width, s.height], [0, 0, 800, 600]);
});

test('after resizing from the left corner, lock X holds the new position while moving vertically', () => {
    const { context: c, state: s, drag } = setup();
    c.setSingleCropAxisLock('x', true);
    drag(20, 10, 'tl');
    assert.deepEqual([s.x, s.y, s.width, s.height], [140, 120, 160, 140]);
    drag(30, 20);
    assert.deepEqual([s.x, s.y, s.width, s.height], [140, 160, 160, 140]);
});

test('pointer cancellation ends the drag and unrelated pointers cannot move the crop', () => {
    for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        const { state: s, send } = setup();
        send('pointerdown');
        send('pointermove', 100, 100, '', 2);
        assert.deepEqual([s.x, s.y], [100, 100]);
        send(end);
        send('pointermove', 100, 100);
        assert.deepEqual([s.x, s.y], [100, 100]);
        assert.equal(s.dragging, null);
    }
});

test('all nine alignments move the crop to the chosen image anchor without changing dimensions or locks', () => {
    const { context: c, state: s, alignments } = setup();
    c.setSingleCropAxisLock('x', true); c.setSingleCropAxisLock('y', true);
    for (const horizontal of [0, 0.5, 1]) for (const vertical of [0, 0.5, 1]) {
        c.alignSingleCrop(horizontal, vertical);
        assert.deepEqual([s.x, s.y, s.width, s.height], [600 * horizontal, 440 * vertical, 200, 160]);
        assert.equal(s.lockX, true); assert.equal(s.lockY, true);
        const checked = alignments.filter(input => input.checked);
        assert.equal(checked.length, 1);
        assert.deepEqual(checked[0].dataset, { x: String(horizontal), y: String(vertical) });
    }
});

test('moving away from an anchor clears its selection and does not keep recentering the crop', () => {
    const { context: c, state: s, alignments, drag } = setup();
    c.alignSingleCrop(0.5, 0.5);
    drag(20, 10);
    assert.deepEqual([s.x, s.y], [340, 240]);
    assert.equal(alignments.some(input => input.checked), false);
    c.alignSingleCrop(0, 0);
    drag(10, 20, 'br');
    assert.deepEqual([s.x, s.y, s.width, s.height], [0, 0, 220, 200]);
    assert.equal(alignments[0].checked, true);
});

test('alignment handles fractional centers and full-image crops with a single selected tile', () => {
    const { context: c, state: s, alignments } = setup();
    s.width = 201; s.height = 161;
    c.alignSingleCrop(0.5, 0.5);
    assert.deepEqual([s.x, s.y], [299.5, 219.5]);
    s.width = 800; s.height = 600;
    c.alignSingleCrop(1, 1);
    assert.deepEqual([s.x, s.y], [0, 0]);
    assert.equal(alignments.filter(input => input.checked).length, 1);
});
