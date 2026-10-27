const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.slice(html.indexOf('function getJigsawReverseGridOptions('), html.indexOf('function loadJigsawReverseImage('));
const context = vm.createContext({ Intl });
vm.runInContext(source, context);
const collect = paths => context.collectJigsawReverseGroups(paths.map(p => ({ name: p.split('/').pop(), webkitRelativePath: p })));
const plain = value => JSON.parse(JSON.stringify(value));

test('exported folders and pieces use numeric ordering, including 10 after 9', () => {
    const files = ['bundle/image_10/10-1.jpeg', 'bundle/image_2/2-2.jpeg', 'bundle/image_2/2-1.jpeg'];
    for (let i = 12; i >= 1; i--) files.push(`bundle/image_0/0-${i}.jpeg`);
    const { groups } = collect(files);
    assert.deepEqual(plain(groups.map(g => g.prefix)), ['0', '2', '10']);
    assert.deepEqual(plain(groups[0].pieces.map(p => p.sequence)), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.ok(groups.every(g => g.selected && !g.error));
});

test('same prefixes in different folders remain separate', () => {
    const { groups } = collect(['root/a/hero-1.png', 'root/b/hero-1.png', 'root/a/hero-2.png']);
    assert.equal(groups.length, 2);
    assert.deepEqual(plain(groups.map(g => g.pieces.length)), [2, 1]);
});

test('flat folders group hyphenated prefixes, underscore names and plain numbers', () => {
    const { groups } = collect(['root/my-art-1.PNG', 'root/my-art-2.webp', 'root/other_1.jpg', 'root/02.jpg', 'root/01.jpg']);
    assert.equal(groups.length, 3);
    const numbered = groups.find(g => g.prefix === '');
    assert.deepEqual(plain(numbered.pieces.map(p => p.sequence)), [1, 2]);
    assert.equal(groups.find(g => g.prefix === 'my-art').pieces.length, 2);
});

test('missing, zero-based and duplicate sequences are excluded from import', () => {
    for (const files of [
        ['set/0-1.jpg', 'set/0-3.jpg'],
        ['set/0-0.jpg', 'set/0-1.jpg'],
        ['set/0-1.jpg', 'set/0-01.png'],
        ['set/0-9007199254740992.jpg'],
    ]) {
        const { groups } = collect(files);
        assert.equal(groups.length, 1);
        assert.equal(groups[0].selected, false);
        assert.ok(groups[0].error);
    }
});

test('non-piece files and platform metadata do not pollute groups', () => {
    const result = collect(['root/0-1.jpeg', 'root/readme.txt', 'root/cover.png', 'root/__MACOSX/0-1.jpeg', 'root/.cache/0-2.jpeg']);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].pieces.length, 1);
    assert.equal(result.ignored, 4);
});

test('two-piece legacy template suggestions preserve vertical vs horizontal layout', () => {
    assert.deepEqual(plain(context.suggestJigsawReverseGrid(2, '0')), { cols: 1, rows: 2 });
    assert.deepEqual(plain(context.suggestJigsawReverseGrid(2, '1')), { cols: 1, rows: 2 });
    assert.deepEqual(plain(context.suggestJigsawReverseGrid(2, '2')), { cols: 2, rows: 1 });
    assert.deepEqual(plain(context.getJigsawReverseGridOptions(2)), [{ cols: 1, rows: 2 }, { cols: 2, rows: 1 }]);
});

test('custom layouts offer exact factor pairs and respect supported grid limits', () => {
    assert.deepEqual(plain(context.getJigsawReverseGridOptions(6)), [
        { cols: 1, rows: 6 }, { cols: 2, rows: 3 }, { cols: 3, rows: 2 }, { cols: 6, rows: 1 },
    ]);
    assert.deepEqual(plain(context.getJigsawReverseGridOptions(23)), []);
    assert.deepEqual(plain(context.getJigsawReverseGridOptions(400)), [{ cols: 20, rows: 20 }]);
    assert.deepEqual(plain(context.getJigsawReverseGridOptions(0)), []);
    assert.deepEqual(plain(context.suggestJigsawReverseGrid(20, 'hero')), { cols: 4, rows: 5 });
});
