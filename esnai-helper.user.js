// ==UserScript==
// @name         ESNAI继续教育视频学习助手
// @namespace    https://ce.esnai.net/
// @version      10.0.0
// @description  确保视频学习时间正常累计
// @author       GLM
// @match        *://ce.esnai.net/*
// @match        *://*.esnai.net/*
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// @noframes     false
// ==/UserScript==

(function () {
    'use strict';

    var W = unsafeWindow || window;
    var log = function () { console.log.apply(console, ['[ESNAI助手]'].concat(Array.prototype.slice.call(arguments))); };

    // ============================================================
    // 持久化：按课程存储
    // ============================================================
    function getCourseId() {
        try {
            var p = new URLSearchParams(W.location.search);
            return p.get('orderitemid') || p.get('cwid') || 'default';
        } catch (e) { return 'default'; }
    }
    var CID = getCourseId();
    var SKEY = 'esnai_' + CID;

    function loadState() {
        try {
            var s = JSON.parse(localStorage.getItem(SKEY));
            if (s && s.startTime && (Date.now() - s.startTime) < 8 * 3600000) return s;
        } catch (e) { }
        return null;
    }
    function saveState() {
        try {
            localStorage.setItem(SKEY, JSON.stringify({
                startTime: S.startTime,
                lastVideoTime: S.lastVideoTime,
                ts: Date.now()
            }));
        } catch (e) { }
    }

    var prev = loadState();
    var S = {
        startTime: prev ? prev.startTime : Date.now(),
        lastVideoTime: prev ? (prev.lastVideoTime || 0) : 0,
        isRefresh: !!prev,
    };

    function elapsed() { return Math.floor((Date.now() - S.startTime) / 1000); }
    setInterval(saveState, 3000);

    // ============================================================
    // 1. 页面可见性欺骗
    // ============================================================
    try { Object.defineProperty(document, 'hidden', { get: function () { return false; }, configurable: true }); } catch (e) { }
    try { Object.defineProperty(document, 'visibilityState', { get: function () { return 'visible'; }, configurable: true }); } catch (e) { }
    try { Object.defineProperty(document, 'hasFocus', { value: function () { return true; }, writable: false, configurable: true }); } catch (e) { }
    ['visibilitychange', 'webkitvisibilitychange'].forEach(function (e) {
        document.addEventListener(e, function (ev) { ev.stopImmediatePropagation(); ev.preventDefault(); }, true);
    });
    ['blur', 'focusout', 'pagehide'].forEach(function (e) {
        W.addEventListener(e, function (ev) { ev.stopImmediatePropagation(); ev.preventDefault(); }, true);
        document.addEventListener(e, function (ev) { ev.stopImmediatePropagation(); ev.preventDefault(); }, true);
    });

    // ============================================================
    // 2. 弹窗屏蔽
    // ============================================================
    W.alert = function () { };
    W.confirm = function () { return true; };
    W.prompt = function () { return ''; };
    W.close = function () { };
    W.addEventListener('beforeunload', function (e) { e.stopImmediatePropagation(); }, true);

    // ============================================================
    // 3. setInterval 补偿 + stopTimer 拦截
    // ============================================================
    var origSI = W.setInterval;
    var origST = W.setTimeout;

    W.setInterval = function (fn, delay) {
        if (typeof fn !== 'function') return origSI.apply(this, arguments);
        var src = fn.toString();
        if (/stopTimer|stopStudy|pauseTimer|pauseStudy|clearTimer|endStudy/i.test(src)) {
            log('拦截停止定时器');
            return origSI.call(W, function () { }, delay);
        }
        if (delay >= 500 && delay <= 3000) {
            var t0 = Date.now(), last = 0;
            return origSI.call(W, function () {
                var now = Date.now();
                var cur = Math.floor((now - t0) / delay);
                var miss = cur - last;
                if (miss > 1) {
                    var n = Math.min(miss, 5);
                    for (var i = 0; i < n; i++) { try { fn.call(this); } catch (e) { } }
                } else {
                    try { fn.call(this); } catch (e) { }
                }
                last = cur;
            }, delay);
        }
        return origSI.apply(this, arguments);
    };

    W.setTimeout = function (fn, delay) {
        if (typeof fn !== 'function') return origST.apply(this, arguments);
        var src = fn.toString();
        if (/stopTimer|stopStudy|pauseTimer|pauseStudy|clearTimer|endStudy/i.test(src)) {
            log('拦截停止延时器');
            return origST.call(W, function () { }, delay);
        }
        return origST.apply(this, arguments);
    };

    // ============================================================
    // 4. 核心：video.currentTime 推进引擎
    // ============================================================
    function startEngine() {
        var lastVT = -1, lastT = 0, inited = false;

        function waitVideo() {
            var v = document.querySelector('video');
            if (!v) { setTimeout(waitVideo, 500); return; }
            if (v.readyState < 1) {
                v.addEventListener('loadedmetadata', function () { init(v); }, { once: true });
                setTimeout(function () { if (!inited) init(v); }, 5000);
            } else {
                init(v);
            }
        }

        function init(v) {
            if (inited) return;
            inited = true;
            var e = elapsed();

            // 刷新后：立即推进视频到累计学习时间
            if (S.isRefresh && e > v.currentTime + 5) {
                var dur = v.duration;
                var target = (!isNaN(dur) && e > dur) ? dur : e;
                if (!isNaN(dur) && target <= dur || isNaN(dur)) {
                    log('刷新同步:', Math.floor(v.currentTime), '->', Math.floor(target), '秒');
                    v.currentTime = target;
                    lastVT = target;
                } else {
                    lastVT = v.currentTime;
                }
            } else {
                lastVT = v.currentTime;
            }
            lastT = Date.now();
            S.lastVideoTime = lastVT;
            log('引擎初始化: videoPos=' + Math.floor(lastVT) + 's, 累计=' + e + 's');

            // 每2秒检查
            origSI.call(W, function () { tick(v); }, 2000);
        }

        function tick(v) {
            var now = Date.now();

            // 视频正常播放 → 更新跟踪
            if (!v.paused && !v.ended && v.readyState >= 2) {
                lastVT = v.currentTime;
                lastT = now;
                S.lastVideoTime = v.currentTime;
                return;
            }

            // 视频停滞 → 推进
            var gap = (now - lastT) / 1000;
            if (gap > 3 && lastVT >= 0) {
                var target = lastVT + gap;
                var dur = v.duration;
                if (!isNaN(dur) && target > dur) target = dur;
                if (!isNaN(dur) && target <= dur || isNaN(dur)) {
                    v.currentTime = target;
                    lastVT = target;
                    lastT = now;
                    S.lastVideoTime = target;
                }
            }

            // 恢复播放
            if (!v.ended) v.play().catch(function () { });
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitVideo);
        else waitVideo();
    }

    // ============================================================
    // 5. 视频防暂停
    // ============================================================
    function hookVideo() {
        function protect(v) {
            if (v._h) return;
            v._h = true;
            var origPause = v.pause.bind(v);
            var blocked = false;
            v.pause = function () { if (!blocked) return; return origPause(); };
            v.addEventListener('pause', function (e) {
                e.stopImmediatePropagation(); e.preventDefault();
                setTimeout(function () { try { blocked = true; v.play().catch(function () { }); blocked = false; } catch (e) { blocked = false; } }, 50);
            }, true);
            ['waiting', 'stalled', 'suspend'].forEach(function (t) {
                v.addEventListener(t, function (e) { e.stopImmediatePropagation(); }, true);
            });
            try {
                var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
                if (d && d.set) Object.defineProperty(v, 'playbackRate', {
                    get: d.get, set: function (val) { if (val === 0) return; return d.set.call(this, val); }, configurable: true
                });
            } catch (e) { }
            origSI.call(W, function () { if (v.paused && !v.ended) v.play().catch(function () { }); }, 2000);
        }

        function scan() {
            document.querySelectorAll('video').forEach(protect);
            new MutationObserver(function (ms) {
                ms.forEach(function (m) { m.addedNodes.forEach(function (n) {
                    if (n.nodeName === 'VIDEO') protect(n);
                    if (n.querySelectorAll) n.querySelectorAll('video').forEach(protect);
                }); });
            }).observe(document.documentElement, { childList: true, subtree: true });
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
        else scan();
    }

    // ============================================================
    // 6. 自动播放
    // ============================================================
    function autoPlay() {
        function tryPlay() {
            document.querySelectorAll('video').forEach(function (v) {
                if (v.paused && !v.ended) { v.muted = true; v.volume = 0; v.play().catch(function () { }); }
            });
            ['.vjs-big-play-button', '.ckplayer-playswitch', '.ckplayer-play',
                '.play-btn', '.btn-play', 'button[title="Play"]', 'button[title="播放"]'].forEach(function (s) {
                    var b = document.querySelector(s); if (b && b.offsetParent) b.click();
                });
        }
        [500, 1000, 2000, 3000, 5000, 8000, 12000, 20000].forEach(function (t) { setTimeout(tryPlay, t); });
        // 用户交互后重试
        function retry() { tryPlay(); document.removeEventListener('click', retry); document.removeEventListener('keydown', retry); }
        document.addEventListener('click', retry);
        document.addEventListener('keydown', retry);
    }

    // ============================================================
    // 7. 弹窗弹题自动处理
    // ============================================================
    function autoPopup() {
        function handle() {
            // 弹题
            document.querySelectorAll('.quiz-popup,.popup-question,.question-popup,.modal-quiz,.exam-popup,.dialog-quiz,.interact-popup,.exam-interact,.study-interact,.layui-layer').forEach(function (c) {
                if (c.style.display === 'none' || c.offsetParent === null || c._ah) return;
                c._ah = true;
                ['input[type="radio"]', 'input[type="checkbox"]', '.answer-option', '.option-item', '.choice-item', 'li'].forEach(function (s) {
                    var o = c.querySelectorAll(s); if (o.length > 0) o[0].click();
                });
                setTimeout(function () {
                    ['.submit-btn', '.btn-confirm', 'button[type="submit"]', '.btn-submit'].forEach(function (s) {
                        var b = c.querySelector(s); if (b) b.click();
                    });
                }, 300);
            });
            // 确认按钮
            document.querySelectorAll('button,a,input[type="button"],input[type="submit"]').forEach(function (b) {
                var t = (b.textContent || b.value || '').trim();
                if (['继续学习', '继续', '确定', '确认', '知道了', '好的', 'OK', '是'].indexOf(t) !== -1) {
                    if (b.offsetParent && !b._ac) { b._ac = true; b.click(); setTimeout(function () { b._ac = false; }, 5000); }
                }
            });
            // layui 确认
            ['.layui-layer-btn0', '.layui-layer-close1'].forEach(function (s) {
                document.querySelectorAll(s).forEach(function (b) { if (b.offsetParent && !b._ac) { b._ac = true; b.click(); setTimeout(function () { b._ac = false; }, 3000); } });
            });
        }
        origSI.call(W, handle, 2000);
        new MutationObserver(function (ms) {
            var c = false; ms.forEach(function (m) { if (m.addedNodes.length > 0) c = true; });
            if (c) handle();
        }).observe(document.body, { childList: true, subtree: true });
    }

    // ============================================================
    // 8. 模拟用户活动（修复 MouseEvent 构造问题）
    // ============================================================
    function simulateActivity() {
        function mkMouse(type, x, y) {
            try { return new W.MouseEvent(type, { bubbles: true, cancelable: true, view: W, clientX: x, clientY: y }); }
            catch (e) {
                try { var ev = document.createEvent('MouseEvent'); ev.initMouseEvent(type, true, true, null, 0, 0, 0, x, y, false, false, false, false, 0, null); return ev; }
                catch (e2) { return null; }
            }
        }
        (function loop() {
            setTimeout(function () {
                var x = Math.random() * (W.innerWidth || 1920);
                var y = Math.random() * (W.innerHeight || 1080);
                var ev = mkMouse('mousemove', x, y);
                if (ev) { try { var t = document.elementFromPoint(x, y); if (t) t.dispatchEvent(ev); else document.dispatchEvent(ev); } catch (e) { } }
                loop();
            }, 3000 + Math.random() * 5000);
        })();
        origSI.call(W, function () {
            try { document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' })); } catch (e) { }
        }, 60000);
    }

    // ============================================================
    // 9. 拦截平台停止函数
    // ============================================================
    function hookStopFns() {
        function wait() {
            ['stopTimer', 'stopStudy', 'pauseTimer', 'pauseStudy', 'endTimer', 'endStudy',
                'clearTimer', 'clearStudy', 'suspendTimer', 'suspendStudy', 'haltTimer', 'haltStudy'].forEach(function (f) {
                    if (typeof W[f] === 'function') { W[f] = function () { log('拦截:', f); }; }
                });
        }
        [1000, 3000, 5000, 10000].forEach(function (t) { setTimeout(wait, t); });
    }

    // ============================================================
    // 10. 差分扫描平台计时变量
    // ============================================================
    function scanVars() {
        var snap = {};
        function take() { snap = {}; try { for (var k in W) { try { if (typeof W[k] === 'number' && W[k] > 0) snap[k] = W[k]; } catch (e) { } } } catch (e) { } }
        function scan() {
            var e = elapsed();
            ['studyTime', 'studySeconds', 'studySec', 'learnTime', 'learnSeconds', 'learnSec',
                'playTime', 'playSeconds', 'playSec', 'watchTime', 'watchSeconds', 'courseTime',
                'timer', 'timerSeconds', 'timerSec', 'countSeconds', 'elapsedTime', 'elapsedSec',
                'secondCount', 'secCount'].forEach(function (v) {
                    if (W[v] !== undefined && typeof W[v] === 'number' && W[v] >= 0 && W[v] < e) W[v] = e;
                });
            try {
                var ns = {};
                for (var k in W) {
                    try {
                        if (typeof W[k] === 'number' && W[k] > 0) {
                            ns[k] = W[k];
                            if (snap[k] !== undefined) {
                                var d = ns[k] - snap[k];
                                if (d > 0 && d <= 10 && ns[k] < e) {
                                    var kl = k.toLowerCase();
                                    if (!/id|code|status|type|version|timestamp|port|width|height|index|order/.test(kl)) {
                                        log('差分:', k, snap[k], '->', ns[k], '修正:', e);
                                        W[k] = e;
                                    }
                                }
                            }
                        }
                    } catch (e) { }
                }
                snap = ns;
            } catch (e) { }
        }
        take();
        setTimeout(take, 3000);
        origSI.call(W, scan, 3000);
    }

    // ============================================================
    // 11. iframe 处理
    // ============================================================
    function hookIframe() {
        origSI.call(W, function () {
            document.querySelectorAll('iframe').forEach(function (f) {
                try {
                    if (!f.contentDocument) return;
                    f.contentDocument.querySelectorAll('video').forEach(function (v) {
                        if (v._h) return; v._h = true;
                        v.addEventListener('pause', function () { setTimeout(function () { v.play().catch(function () { }); }, 50); });
                    });
                    f.contentWindow.alert = function () { };
                    f.contentWindow.confirm = function () { return true; };
                } catch (e) { }
            });
        }, 5000);
    }

    // ============================================================
    // 12. ckplayer 钩子
    // ============================================================
    function hookPlayer() {
        function find() {
            ['player', 'videoPlayer', 'studyPlayer', 'coursePlayer', 'ckPlayer', 'ckplayer'].forEach(function (n) {
                if (W[n] && typeof W[n] === 'object') {
                    log('播放器:', n);
                    if (W[n].pause) { var o = W[n].pause.bind(W[n]); W[n].pause = function () { }; }
                    if (W[n].video) { try { W[n].video.muted = true; W[n].video.play().catch(function () { }); } catch (e) { } }
                }
            });
        }
        [1000, 3000, 5000, 10000].forEach(function (t) { setTimeout(find, t); });
    }

    // ============================================================
    // 13. Web Worker 计时
    // ============================================================
    try {
        var w = new Worker(URL.createObjectURL(new Blob(['setInterval(function(){postMessage(1)},1000)'], { type: 'application/javascript' })));
        w.onmessage = function () { S.lastVideoTime = S.lastVideoTime; };
    } catch (e) { }

    // ============================================================
    // 初始化
    // ============================================================
    log('========== v10.0 启动 ==========');
    log('课程:', CID, '累计:', elapsed() + 's', S.isRefresh ? '(刷新恢复)' : '(首次)');
    hookVideo();
    startEngine();

    function onReady() {
        autoPlay();
        autoPopup();
        simulateActivity();
        hookStopFns();
        scanVars();
        hookIframe();
        hookPlayer();
        log('========== 初始化完成 ==========');
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
    else onReady();
})();
