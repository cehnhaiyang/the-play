'use strict';
/**
 * 保存收尾口径的回归测试。
 *
 * 真实故障：一个文件都没下下来时，界面照样打绿勾、写
 * "保存完成：成功 0/1 页"，进度停在 0/1，而失败原因（403 / ECONNRESET / 超时）
 * 只进了 records，用户完全看不到。用户的原话是
 * "有些明明没下载下来却显示保存成功，而且进度是 0/1"。
 *
 * 判据只有一份：gallery.saveOutcome。三个落盘入口（acgmho 图集、ehentai 图集、
 * 媒体）与两个"全本下载"都走它，所以这里测它就等于测全部。
 */
const path = require('path');

const check = (name, fn, state) => {
    try { fn(); state.pass += 1; }
    catch (e) { state.fails.push({ name, message: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};

const run = () => {
    const state = { pass: 0, fails: [] };
    const G = require(path.join(__dirname, '..', 'app', 'main', 'gallery.js'));
    const outcome = G.saveOutcome;

    check('0 个成功必须是 error，不能是 completed', () => {
        const r = outcome({ savedCount: 0, totalFiles: 1, errors: [{ error: 'HTTP 403' }] });
        eq(r.status, 'error', '一个都没存下时必须报错');
        assert(!/^保存完成/.test(r.message), `失败不能以"保存完成"开头：${r.message}`);
        assert(/保存失败/.test(r.message), `消息应说明失败：${r.message}`);
        assert(/0\/1/.test(r.message), `消息要带 0/1 进度：${r.message}`);
    }, state);

    check('0 个成功时必须带出首个失败原因', () => {
        const r = outcome({ savedCount: 0, totalFiles: 5, errors: [{ error: 'read ECONNRESET' }, { error: 'HTTP 403' }] });
        eq(r.status, 'error');
        assert(/ECONNRESET/.test(r.message), `必须显示真实原因，实际：${r.message}`);
        assert(!/HTTP 403/.test(r.message), '只带首个原因，不堆砌');
    }, state);

    check('0 个成功且没有任何错误记录时也不能谎报成功', () => {
        const r = outcome({ savedCount: 0, totalFiles: 1, errors: [] });
        eq(r.status, 'error');
        assert(/保存失败/.test(r.message), `没有原因也要报失败：${r.message}`);
    }, state);

    check('部分失败：completed，但消息写明失败数量与原因', () => {
        const r = outcome({
            savedCount: 3, totalFiles: 5, errors: [{ error: 'Timeout downloading' }, { error: 'HTTP 403' }],
        });
        eq(r.status, 'completed');
        assert(/3\/5/.test(r.message), `要带成功进度：${r.message}`);
        assert(/2/.test(r.message) && /失败/.test(r.message), `要说明 2 页失败：${r.message}`);
        assert(/Timeout/.test(r.message), `要带首个原因：${r.message}`);
    }, state);

    check('全部成功：completed，不带失败噪声', () => {
        const r = outcome({ savedCount: 4, totalFiles: 4, errors: [] });
        eq(r.status, 'completed');
        assert(/4\/4/.test(r.message), r.message);
        assert(!/失败/.test(r.message), `全部成功不该提失败：${r.message}`);
    }, state);

    check('取消优先于成功/失败判定', () => {
        eq(outcome({ savedCount: 0, totalFiles: 3, cancelled: true }).status, 'cancelled');
        eq(outcome({ savedCount: 2, totalFiles: 3, cancelled: true }).status, 'cancelled');
    }, state);

    check('单位可区分（图集用「页」，媒体用「个文件」）', () => {
        assert(/页/.test(outcome({ savedCount: 1, totalFiles: 1, unit: '页' }).message));
        assert(/个文件/.test(outcome({ savedCount: 1, totalFiles: 1, unit: '个文件' }).message));
    }, state);

    /* ---- 三个落盘入口必须都走同一份口径 ---- */
    check('三个落盘入口与两个全本下载都改用 saveOutcome', () => {
        const fs = require('fs');
        const files = {
            'ehentaiService.js': path.join(__dirname, '..', 'app', 'main', 'ehentaiService.js'),
            'acgmhoService.js': path.join(__dirname, '..', 'app', 'main', 'acgmhoService.js'),
            'main.js': path.join(__dirname, '..', 'app', 'main', 'main.js'),
        };
        for (const [name, file] of Object.entries(files)) {
            const src = fs.readFileSync(file, 'utf8');
            assert(/saveOutcome\s*\(/.test(src), `${name} 必须使用 saveOutcome`);
            // 旧的谎报写法不许回潮
            assert(!/status:\s*cancelled\s*\?\s*'cancelled'\s*:\s*'completed'/.test(src),
                `${name} 里还有"0 个成功也报 completed"的旧写法`);
            assert(!/保存完成：成功 \$\{savedFiles\.length\}/.test(src),
                `${name} 里还有直接拼"保存完成：成功 N/M"的旧写法`);
        }
    }, state);

    if (state.fails.length > 0) {
        for (const f of state.fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
    }
    console.log(`  保存收尾口径 ${state.pass} pass / ${state.fails.length} fail`);
    return state.fails.length === 0;
};

module.exports = { run };
