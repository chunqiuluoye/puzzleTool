const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const helpers = html.slice(html.indexOf('function readSingleCropSettings('), html.indexOf('function openUnifiedCropEditor('));
const gridHelper = html.slice(html.indexOf('function getSingleCropGrid('), html.indexOf('function autoAdjustCropRatio('));
const ratioHelper = html.slice(html.indexOf('function getJigsawGroupGrid('), html.indexOf('function getJigsawDefaultRatio('));
const outputHelpers = html.slice(html.indexOf('function getJigsawPieceOutputSize('), html.indexOf('async function refreshAllJigsawWithCurrentSettings('));
const plain = value => JSON.parse(JSON.stringify(value));
const image = { width: 800, height: 600 };
const template = {
    crop: { x: 80, y: 60, width: 250, height: 150 },
    mode: 'custom', modeIsCustom: true, cutCols: 3, cutRows: 2,
    freeRatioCrop: true, ratioUnit: 65, cropOutputRatio: { w: 10, h: 9 }
};

function setup(overrides = {}) {
    const fields = {
        singleCropGroupGrid: { value: 'custom' },
        singleCropGroupCols: { value: '3' },
        singleCropGroupRows: { value: '2' },
        singleCropRatioUnit: { value: '65' }
    };
    for (const [key, value] of Object.entries(overrides)) fields[key].value = value;
    const context = vm.createContext({
        document: { getElementById: id => fields[id] },
        singleCropState: { ...template.crop, img: image, dragging: null },
        singleCropFixedRatio: { checked: false },
        getJigsawRatioUnit: () => 100,
        getJigsawFullRatioUnit: () => 200,
        getJigsawDefaultRatio: () => ({ w: 3, h: 4 })
    });
    vm.runInContext(helpers + gridHelper + ratioHelper + outputHelpers, context);
    return context;
}

test('template captures pixel crop, custom grid, aspect lock and output resolution together', () => {
    const context = setup();
    assert.deepEqual(plain(context.readSingleCropSettings()), template);
    context.singleCropFixedRatio.checked = true;
    assert.equal(context.readSingleCropSettings().freeRatioCrop, false);
});

test('equal-resolution images keep exact coordinates and different resolutions scale all four edges', () => {
    const { copyJigsawCropSettings: copy } = setup();
    assert.deepEqual(plain(copy(template, image, image)), template);
    for (const freeRatioCrop of [true, false]) {
        for (const scale of [0.5, 2, 333 / 800]) {
            const target = { width: image.width * scale, height: image.height * scale };
            const result = copy({ ...template, freeRatioCrop }, target, image);
            for (const key of ['x', 'y', 'width', 'height']) {
                assert.ok(Math.abs(result.crop[key] - template.crop[key] * scale) < 1e-8, key);
            }
            assert.equal(result.mode, template.mode);
            assert.equal(result.ratioUnit, template.ratioUnit);
            assert.deepEqual(plain(result.cropOutputRatio), template.cropOutputRatio);
        }
    }
});

test('free crops map horizontal and vertical percentages independently across aspect ratios', () => {
    const { copyJigsawCropSettings: copy } = setup();
    const result = copy(template, { width: 400, height: 900 }, image);
    assert.deepEqual(plain(result.crop), { x: 40, y: 90, width: 125, height: 225 });
    assert.deepEqual(plain(result.cropOutputRatio), { w: 10, h: 9 });
});

test('fixed crops retain shape, relative center and relative fitted size on portrait images', () => {
    const { copyJigsawCropSettings: copy } = setup();
    const result = copy({ ...template, freeRatioCrop: false }, { width: 400, height: 900 }, image);
    for (const [key, expected] of Object.entries({ x: 40, y: 165, width: 125, height: 75 })) {
        assert.ok(Math.abs(result.crop[key] - expected) < 1e-8, key);
    }
    assert.equal(result.crop.width / result.crop.height, template.crop.width / template.crop.height);
});

test('each group has an independent crop and settings copy', () => {
    const { copyJigsawCropSettings: copy } = setup();
    const first = copy(template, image), second = copy(template, image);
    first.crop.x = 200;
    first.cutCols = 7;
    first.ratioUnit = 90;
    first.cropOutputRatio.w = 42;
    assert.deepEqual(plain(second), template);
    assert.deepEqual(template.crop, { x: 80, y: 60, width: 250, height: 150 });
});

test('pending template leaves current crop, modes and output tasks unchanged until applied', () => {
    const { copyJigsawCropSettings: copy, applyPendingJigsawCropSettings: apply } = setup();
    const crop = { x: 0, y: 0, width: 150, height: 400 };
    const tasks = [{ id: '1', url: 'blob:existing-output' }];
    const group = { crop, mode: '1x2', modeIsCustom: false, cutCols: 1, cutRows: 2, ratioUnit: 100,
        freeRatioCrop: false, tasks, prefix: 'custom-name' };
    group.pendingCropSettings = copy(template, image);
    assert.strictEqual(group.crop, crop);
    assert.strictEqual(group.tasks, tasks);
    assert.equal(group.mode, '1x2');
    assert.equal(group.ratioUnit, 100);

    apply(group);
    const { tasks: remainingTasks, prefix, ...settings } = group;
    assert.deepEqual(plain(settings), template);
    assert.strictEqual(remainingTasks, tasks);
    assert.equal(prefix, 'custom-name');
    assert.equal(group.pendingCropSettings, undefined);
    const appliedCrop = group.crop;
    apply(group);
    assert.strictEqual(group.crop, appliedCrop);
});

test('a later individual crop replaces the template only for its own group', () => {
    const { copyJigsawCropSettings: copy, applyPendingJigsawCropSettings: apply } = setup();
    const groups = [0, 1, 2].map(() => ({ pendingCropSettings: copy(template, image) }));
    groups[1].pendingCropSettings = copy({ ...template, mode: '1x1', cutCols: 1, cutRows: 1,
        crop: { x: 20, y: 10, width: 120, height: 160 } }, image);
    groups.forEach(apply);
    assert.equal(groups[1].mode, '1x1');
    assert.deepEqual(plain(groups[0]), template);
    assert.deepEqual(plain(groups[2]), template);
});

test('smaller image bounds keep the crop valid without stretching its shape', () => {
    const { copyJigsawCropSettings: copy } = setup();
    for (const target of [{ width: 100, height: 90 }, { width: 1, height: 1 }, { width: 300, height: 180 }]) {
        const result = copy({ ...template, freeRatioCrop: false }, target, image);
        const { x, y, width, height } = result.crop;
        assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
        assert.ok(x + width <= target.width + 1e-8 && y + height <= target.height + 1e-8);
        assert.ok(Math.abs(width / height - template.crop.width / template.crop.height) < 1e-8);
        assert.equal(result.mode, template.mode);
        assert.equal(result.ratioUnit, template.ratioUnit);
    }
});

test('refresh commits mapped coordinates once and never scales them again', () => {
    const { copyJigsawCropSettings: copy, applyPendingJigsawCropSettings: apply } = setup();
    const group = { pendingCropSettings: copy(template, { width: 1600, height: 1200 }, image) };
    apply(group);
    assert.deepEqual(plain(group.crop), { x: 160, y: 120, width: 500, height: 300 });
    apply(group);
    assert.deepEqual(plain(group.crop), { x: 160, y: 120, width: 500, height: 300 });
});

test('reopening an unchanged mapped crop preserves template output ratio; edits recalculate it', () => {
    const context = setup();
    const mapped = context.copyJigsawCropSettings(template, { width: 400, height: 900 }, image);
    Object.assign(context.singleCropState, mapped.crop, { savedSettings: mapped });
    assert.deepEqual(plain(context.readSingleCropSettings().cropOutputRatio), { w: 10, h: 9 });
    context.singleCropState.width = 135;
    assert.deepEqual(plain(context.readSingleCropSettings().cropOutputRatio), { w: 2, h: 5 });
    context.singleCropFixedRatio.checked = true;
    assert.equal(context.readSingleCropSettings().cropOutputRatio, null);
});

test('template grid and resolution inputs are bounded, including the 1x1 preset', () => {
    const settings = setup({ singleCropGroupCols: '500', singleCropGroupRows: '-1', singleCropRatioUnit: '20000' }).readSingleCropSettings();
    assert.equal(settings.cutCols, 20);
    assert.equal(settings.cutRows, 1);
    assert.equal(settings.ratioUnit, 10000);
    const preset = setup({ singleCropGroupGrid: '1x1', singleCropRatioUnit: '' }).readSingleCropSettings();
    assert.equal(preset.cutCols, 1);
    assert.equal(preset.cutRows, 1);
    assert.equal(preset.ratioUnit, 100);
});

test('all inline scripts parse successfully', () => {
    for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script);
});

test('fixed-ratio size display uses the current piece unit and full-image unit independently', () => {
    const context = setup({ singleCropGroupGrid: '1x2', singleCropRatioUnit: '100' });
    context.singleCropFixedRatio.checked = true;
    const settings = context.readSingleCropSettings();
    assert.deepEqual(plain(context.getJigsawPieceOutputSize(settings)), { w: 300, h: 400 });
    assert.deepEqual(plain(context.getJigsawFullOutputSize(settings)), { w: 600, h: 1600 });
});

test('free-ratio size display preserves saved template output ratio across different source resolutions', () => {
    const context = setup();
    const settings = context.copyJigsawCropSettings(template, { width: 400, height: 900 }, image);
    assert.deepEqual(plain(context.getJigsawPieceOutputSize(settings)), { w: 650, h: 585 });
    assert.deepEqual(plain(context.getJigsawFullOutputSize(settings)), { w: 1000, h: 600 });
});

test('size display follows export limits instead of showing dimensions larger than exported images', () => {
    const context = setup();
    const settings = { ...template, cropOutputRatio: { w: 1, h: 3 }, ratioUnit: 10000 };
    assert.deepEqual(plain(context.getJigsawPieceOutputSize(settings)), { w: 3333, h: 10000 });
    context.getJigsawFullRatioUnit = () => 20000;
    assert.deepEqual(plain(context.getJigsawFullOutputSize(settings)), { w: 10000, h: 20000 });
});
