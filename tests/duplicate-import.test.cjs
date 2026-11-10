const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { File } = require('node:buffer');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.slice(html.indexOf('async function getJigsawSourceFingerprint('), html.indexOf('function processSingleJigsawFile('));
const file = (name, content) => new File([content], name, { type: 'image/png', lastModified: 1 });

function setup({ realtime = false, secure = true } = {}) {
    const elements = {
        jigsawTemplateToggle: { checked: true },
        jigsawPreviewRealtimeSync: { checked: realtime },
        jigsawStatus: { textContent: '' },
        jigsawFileInput: { value: 'selected' }
    };
    class Reader {
        readAsDataURL(blob) {
            blob.arrayBuffer().then(buffer => {
                this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
                this.onload();
            }, () => this.onerror());
        }
    }
    const context = vm.createContext({
        crypto: secure ? webcrypto : undefined,
        FileReader: Reader,
        document: { getElementById: id => elements[id], querySelector: () => ({ value: '2x2' }) },
        _jigsawIsProcessing: false, allJigsawGroupsData: [], totalJigsawImageCount: 0,
        calls: [], previewRefreshes: 0,
        getJigsawPrefix: index => String(index),
        getJigsawCustomGrid: () => ({ cols: 2, rows: 2 })
    });
    context.refreshAllPreviewBar = () => context.previewRefreshes++;
    context.processSingleJigsawFile = async (file, prefix, mode, grid, deferred, sourceFingerprint) => {
        if (file.name === 'broken.png') throw new Error('decode failure');
        const group = { sourceFingerprint, prefix, mode, tasks: [] };
        context.calls.push({ file, deferred });
        context.allJigsawGroupsData.push(group);
    };
    vm.runInContext(source, context);
    return { context, elements };
}

test('content fingerprints ignore name/date but distinguish equal-length different contents', async () => {
    const { context } = setup();
    const fingerprint = context.getJigsawSourceFingerprint;
    assert.equal(await fingerprint(file('a.png', 'abc')), await fingerprint(file('renamed.png', 'abc')));
    assert.notEqual(await fingerprint(file('a.png', 'abc')), await fingerprint(file('a.png', 'abd')));
});

test('insecure-context fallback compares exact bytes independently of MIME type', async () => {
    const { context } = setup({ secure: false });
    const fingerprint = context.getJigsawSourceFingerprint;
    assert.equal(await fingerprint(file('a.png', 'abc')), await fingerprint(new File(['abc'], 'a.jpg', { type: 'image/jpeg' })));
    assert.notEqual(await fingerprint(file('a.png', 'abc')), await fingerprint(file('a.png', 'abd')));
});

test('duplicates within and across batches are skipped before decoding or cutting', async () => {
    const { context, elements } = setup();
    await context.handleJigsawFiles([file('a.png', 'abc'), file('renamed.png', 'abc'), file('a.png', 'abd'), file('again.png', 'abc')]);
    assert.equal(context.calls.length, 2);
    assert.equal(context.totalJigsawImageCount, 2);
    assert.deepEqual(Array.from(context.allJigsawGroupsData, g => g.prefix), ['0', '1']);
    assert.match(elements.jigsawStatus.textContent, /新增 2 张.*跳过 2 张重复/);
    assert.match(elements.jigsawStatus.textContent, /刷新所有切图/);
    assert.ok(context.calls.every(c => c.deferred));
    assert.equal(context.previewRefreshes, 1);
    const firstGroup = context.allJigsawGroupsData[0];
    await context.handleJigsawFiles([file('once-more.png', 'abc')]);
    assert.equal(context.calls.length, 2);
    assert.equal(context.previewRefreshes, 1);
    assert.strictEqual(context.allJigsawGroupsData[0], firstGroup);
    assert.match(elements.jigsawStatus.textContent, /新增 0 张.*跳过 1 张重复/);
    assert.equal(elements.jigsawFileInput.value, '');
    assert.equal(context._jigsawIsProcessing, false);
});

test('realtime mode only cuts newly accepted files', async () => {
    const { context, elements } = setup({ realtime: true });
    await context.handleJigsawFiles([file('a.png', 'abc'), file('a-copy.png', 'abc')]);
    assert.equal(context.calls.length, 1);
    assert.equal(context.calls[0].deferred, false);
    assert.equal(context.previewRefreshes, 0);
    assert.match(elements.jigsawStatus.textContent, /新增图片已切割完毕/);
});

test('deleted or cleared originals can be imported again without stale fingerprint entries', async () => {
    const { context } = setup();
    const original = file('a.png', 'abc');
    await context.handleJigsawFiles([original]);
    context.allJigsawGroupsData = [];
    context.totalJigsawImageCount = 0;
    await context.handleJigsawFiles([original]);
    assert.equal(context.calls.length, 2);
    assert.equal(context.allJigsawGroupsData.length, 1);
});

test('restored previews participate in duplicate checking through their source fingerprint', async () => {
    const { context, elements } = setup();
    const original = file('restored.png', 'png-bytes');
    context.allJigsawGroupsData.push({ sourceFingerprint: await context.getJigsawSourceFingerprint(original), restoredBlob: original });
    await context.handleJigsawFiles([file('renamed-restored.png', 'png-bytes')]);
    assert.equal(context.calls.length, 0);
    assert.match(elements.jigsawStatus.textContent, /跳过 1 张重复/);
});

test('decode and read failures do not reserve fingerprints, consume indices or block later files', async () => {
    const { context, elements } = setup();
    const unreadable = { name: 'unreadable.png', type: 'image/png', arrayBuffer: async () => { throw new Error('read failed'); } };
    await context.handleJigsawFiles([unreadable, file('broken.png', 'abc'), file('valid.png', 'abc')]);
    assert.equal(context.calls.length, 1);
    assert.equal(context.totalJigsawImageCount, 1);
    assert.equal(context.allJigsawGroupsData[0].prefix, '0');
    assert.match(elements.jigsawStatus.textContent, /新增 1 张.*跳过 0 张重复.*2 张读取失败/);
    assert.equal(context._jigsawIsProcessing, false);
});
