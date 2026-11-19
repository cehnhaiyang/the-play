'use strict';
/**
 * HLS 清单签名的回归测试。
 *
 * 真实故障：https://www.acgmho.com/gif/917910.html 能播，一点保存就 403
 * （界面上还只是「Output file does not contain any stream」）。
 *
 * 根因在图床的分层签名：master 带 ?m=&t=，变体清单还要补 `from=<master 路径>`
 * 才放行（curl 实测：无参 → "Invalid Request"，只带 m/t → "Verification Failed"，
 * 带 from → 200；from 必须是路径，绝对地址回 "Directory Mismatch"）。
 * 变体是相对地址，按 RFC 3986 解析不继承 query —— 播放靠渲染层 hls.js 逐请求补签，
 * 下载走 ffmpeg 独立进程，而主进程原先完全没做这件事。
 */
const fs = require('fs');
const path = require('path');

const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'app', 'main', 'main.js');

// 实测清单（2026-11，gif/917910）
const MASTER_TEXT = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=830794,RESOLUTION=720x1080,NAME="720p"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=445065,RESOLUTION=480x720,NAME="480p"
480p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=283035,RESOLUTION=360x540,NAME="360p"
360p/index.m3u8
`;
const MEDIA_TEXT = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:12
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:11.533333,
index0.ts
`;
const MASTER_URL = 'https://gif.acgnngca.com/cv/2026110702/zjrmd10KBaD/master.m3u8?m=f530c79f68e2f5381db1a2203053a826&t=1795194000';
const SIGNED = 'https://gif.acgnngca.com/cv/2026110702/zjrmd10KBaD/720p/index.m3u8'
    + '?m=f530c79f68e2f5381db1a2203053a826&t=1795194000'
    + '&from=%2Fcv%2F2026110702%2Fzjrmd10KBaD%2Fmaster.m3u8';

const run = async () => {
    const fails = [];
    let pass = 0;
    const check = async (name, fn) => {
        try { await fn(); pass += 1; }
        catch (e) { fails.push({ name, message: e.message }); }
    };

    const gallery = require(path.join(ROOT, 'app', 'main', 'gallery.js'));
    // 注册全部站点，注册表才有内容可问
    require(path.join(ROOT, 'app', 'main', 'ehentaiService.js'));
    const acg = require(path.join(ROOT, 'app', 'main', 'acgmhoService.js'));

    await check('签名规则与渲染层同一份（交叉比对 TS 实现）', () => {
        const ts = require(path.join(__dirname, 'build', 'shared', 'core', 'acg.js'));
        assert(typeof ts.signAcgHlsUrl === 'function', 'shared/core/acg.ts 应导出 signAcgHlsUrl');
        const cases = [
            ['https://gif.acgnngca.com/cv/a/720p/index.m3u8', MASTER_URL],
            ['https://gif.acgnngca.com/cv/a/720p/index.m3u8?x=1', MASTER_URL],
            [SIGNED, MASTER_URL],                                                    // 已签名：不重复追加
            ['https://gif.acgnngca.com/cv/a/720p/index.m3u8', 'https://gif.acgnngca.com/cv/a/master.m3u8'], // 无令牌
            ['https://cdn.example.com/a/index.m3u8', MASTER_URL],                    // 非本站域不接管
            ['https://gif.acgnngca.com/cv/a/720p/index0.ts', MASTER_URL],            // 非 m3u8 不碰
            ['https://gif.acgnngca.com/cv/a/video.mp4', MASTER_URL],
        ];
        for (const [req, master] of cases) {
            eq(acg.signAcgHlsUrl(req, master), ts.signAcgHlsUrl(req, master), `两侧签名不一致：${req}`);
        }
    });

    await check('master → 最高码率变体的已签名地址', () => {
        eq(acg.variantStreamUrl(MASTER_TEXT, MASTER_URL), SIGNED);
        // from 必须是 master 的**路径**：绝对地址实测回 Directory Mismatch
        assert(SIGNED.includes('from=%2Fcv%2F'), 'from 必须是 master 路径');
        // 选码率而非选位置：顺序打乱也要挑最高那条
        const shuffled = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100,NAME="low"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900,NAME="high"
high/index.m3u8
`;
        assert(acg.variantStreamUrl(shuffled, MASTER_URL).includes('/high/index.m3u8'),
            '应变体按 BANDWIDTH 取，与顺序无关');
    });

    await check('媒体清单（无变体）原样返回，不改写分片', () => {
        const signed = acg.variantStreamUrl(MEDIA_TEXT, MASTER_URL);
        eq(signed, MASTER_URL, '已是媒体清单时返回签名后的自身地址');
        assert(!/index0\.ts\?/.test(signed), '分片地址不该被改写（会打乱 CDN 缓存键）');
    });

    await check('站点只接管自己的 m3u8，其余返回 null 交给 ffmpeg', async () => {
        eq(await acg.resolveStreamSource('https://gif.acgnngca.com/a/video.mp4'), null, '非 m3u8 不接管');
        eq(await acg.resolveStreamSource('https://www.acgmho.com/gif/917910.html'), null, '详情页不接管');
        eq(await acg.resolveStreamSource(SIGNED), null, '已带 from= 的不重复处理');
        eq(await acg.resolveStreamSource('https://cdn.example.com/a/master.m3u8'), null, '非本站域不接管');
    });

    await check('注册表按站点分发，无人接管则原样返回', async () => {
        assert(typeof gallery.resolveStreamSource === 'function', 'gallery 要导出 resolveStreamSource');
        eq(gallery.getSite('acgmho').resolveStreamSource, acg.resolveStreamSource,
            'acgmho 的改写能力要进注册表');
        eq(gallery.getSite('ehentai').resolveStreamSource, null,
            '没有流媒体的站点应为 null（不接管）');
        const untouched = 'https://cdn.example.com/a/master.m3u8';
        eq(await gallery.resolveStreamSource(untouched), untouched, '无人接管时原样返回');
    });

    await check('main.js：ffmpeg 的 -i 用站点改写后的地址', () => {
        const src = fs.readFileSync(MAIN, 'utf8');
        const start = src.indexOf('async function downloadWithFfmpeg');
        const body = src.slice(start, start + 3000);
        assert(/const inputUrl = await gallery\.resolveStreamSource\(url\)/.test(body),
            'downloadWithFfmpeg 必须先把地址交给站点改写');
        assert(/'-i',\s*\n\s*inputUrl,/.test(body), 'ffmpeg 的 -i 必须用改写后的地址');
        assert(!/'-i',\s*\n\s*url,/.test(body), '不能再用原始地址当 -i');
        // 先起进程再补签名等于没补
        assert(body.indexOf('resolveStreamSource') < body.indexOf('spawn('), '要在 spawn 之前改写');
    });

    if (fails.length > 0) {
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
    }
    console.log(`  HLS 签名 ${pass} pass / ${fails.length} fail`);
    return fails.length === 0;
};

module.exports = { run };
