const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const naming = html.slice(html.indexOf('function recomputeJigsawFileNames('), html.indexOf('const jigsawDropZone'));
const prefixes = html.slice(html.indexOf('let jigsawPrefixStart ='), html.indexOf('let _autoRefreshTimer'));
const confirm = html.slice(html.indexOf('async function confirmJigsawPreviewCut('), html.indexOf('// 排序只会影响少数组的位置'));
function setup() {
    const input = { value: '0', validity: '', setCustomValidity(value) { this.validity = value; }, reportValidity() {}, addEventListener() {} };
    const radios = [{ value: 'alpha', checked: true }, { value: 'number', checked: false }];
    const groups = Array.from({ length: 3 }, (_, id) => ({ id, prefix: `custom-${id}`, isCustom: true, mode: 'custom', crop: { x: 10, y: 20, width: 30, height: 40 }, tasks: [{ id: 1, url: `blob:${id}` }] }));
    const c = vm.createContext({
        allJigsawGroupsData: groups, editable: true, previewRefreshes: 0, outputRefreshes: 0,
        _jigsawPreviewFullRefreshInProgress: false, _autoRefreshTimer: null, clearTimeout,
        document: {
            getElementById: id => id === 'jigsawPrefixStart' ? input : {},
            querySelector: () => radios.find(r => r.checked),
            querySelectorAll: query => query.startsWith('input') ? radios : []
        },
        canEditJigsawPreviews: () => c.editable,
        refreshAllPreviewBar: () => c.previewRefreshes++,
        refreshAllJigsawWithCurrentSettings: async () => { c.outputRefreshes++; c.recomputeJigsawFileNames(); }
    });
    vm.runInContext(naming + prefixes + confirm, c);
    c.recomputeJigsawFileNames();
    return { c, input, radios, groups };
}

test('apply changes only preview prefixes, including when download naming is recomputed', () => {
    const { c, input, groups, radios } = setup();
    const original = JSON.stringify(groups);
    input.value = '3'; c.applyJigsawPrefixStart();
    assert.deepEqual(groups.map((g, i) => c.getJigsawPreviewPrefix(g, i)), ['3', '4', '5']);
    assert.equal(c.previewRefreshes, 1); assert.equal(c.outputRefreshes, 0);
    assert.equal(JSON.stringify(groups), original);
    c.recomputeJigsawFileNames();
    assert.equal(JSON.stringify(groups), original);
    assert.equal(radios[0].checked, true);
});

test('explicit refresh commits pending prefixes and download names without changing crop settings', async () => {
    const { c, input, groups, radios } = setup();
    const crops = groups.map(g => g.crop), tasks = groups.map(g => g.tasks);
    input.value = '3'; c.applyJigsawPrefixStart();
    await c.confirmJigsawPreviewCut();
    assert.deepEqual(groups.map(g => g.prefix), ['3', '4', '5']);
    assert.deepEqual(groups.map(g => g.folderName), ['image_3', 'image_4', 'image_5']);
    assert.deepEqual(groups.map(g => g.tasks[0].fileName), ['3-1.jpeg', '4-1.jpeg', '5-1.jpeg']);
    groups.forEach((g, i) => { assert.equal(g.crop, crops[i]); assert.equal(g.tasks, tasks[i]); assert.equal(g.mode, 'custom'); assert.equal(g.isCustom, false); });
    assert.equal(radios[1].checked, true);
    assert.equal(c.getJigsawPrefix(3), '6');
    assert.equal(c.outputRefreshes, 1);
    // Once committed, individual custom prefixes appear normally in the preview again.
    groups[0].prefix = 'hero';
    assert.equal(c.getJigsawPreviewPrefix(groups[0], 0), 'hero');
});

test('unconfirmed and invalid values cannot change the applied starting number', () => {
    const { c, input, groups } = setup();
    input.value = '3'; c.applyJigsawPrefixStart();
    input.value = '10'; assert.equal(c.getJigsawPreviewPrefix(groups[0], 0), '3');
    for (const value of ['', '-1', '1.5', 'NaN', '9007199254740992']) {
        input.value = value; c.applyJigsawPrefixStart();
        assert.ok(input.validity); assert.equal(c.getJigsawPreviewPrefix(groups[0], 0), '3');
        assert.deepEqual(groups.map(g => g.prefix), ['custom-0', 'custom-1', 'custom-2']);
    }
    input.value = '0'; c.applyJigsawPrefixStart();
    assert.equal(input.validity, ''); assert.equal(c.getJigsawPreviewPrefix(groups[0], 0), '0');
});

test('busy image processing blocks preview changes and commits; alphabetic naming stays unchanged until refresh', async () => {
    const { c, input, groups, radios } = setup();
    input.value = '3'; c.editable = false; c.applyJigsawPrefixStart();
    assert.equal(groups[0].prefix, 'custom-0'); assert.equal(c.getJigsawPrefix(0), 'a');
    c.editable = true; c.applyJigsawPrefixStart();
    assert.equal(c.getJigsawPrefix(0), 'a'); assert.equal(c.getJigsawPrefix(26), 'aa');
    c.editable = false; await c.confirmJigsawPreviewCut();
    assert.equal(groups[0].prefix, 'custom-0'); assert.equal(c.outputRefreshes, 0);
    assert.equal(c.getJigsawPreviewPrefix(groups[0], 0), '3');
});

test('preview follows current order and newest applied start; unrelated output refresh cannot commit it', async () => {
    const { c, input, groups } = setup();
    input.value = '3'; c.applyJigsawPrefixStart();
    groups.reverse();
    groups.push({ id: 4, prefix: 'new', isCustom: true, tasks: [] });
    input.value = '8'; c.applyJigsawPrefixStart();
    await c.refreshAllJigsawWithCurrentSettings();
    assert.deepEqual(groups.map(g => g.prefix), ['custom-2', 'custom-1', 'custom-0', 'new']);
    assert.deepEqual(groups.map((g, i) => c.getJigsawPreviewPrefix(g, i)), ['8', '9', '10', '11']);
    await c.confirmJigsawPreviewCut();
    assert.deepEqual(groups.map(g => g.prefix), ['8', '9', '10', '11']);
});
