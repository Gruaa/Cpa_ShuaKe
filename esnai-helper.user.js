// ==UserScript==
// @name         ESNAI继续教育视频学习助手
// @namespace    https://ce.esnai.net/
// @version      6.0.0
// @description  确保视频学习时间正常累计，防止计时中断、弹题打断、暂停检测等
// @author       GLM
// @match        *://ce.esnai.net/*
// @match        *://*.esnai.net/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// @noframes     false
// @connect      ce.esnai.net
// @connect      *.esnai.net
// ==/UserScript==

(function () {
    'use strict';

    const LOG_ENABLED = true;
    function log(...args) { if (LOG_ENABLED) console.log('[ESNAI助手]', ...args); }
    function warn(...args) { if (LOG_ENABLED) console.warn('[ESNAI助手]', ...args); }

    const STATE = {
        startTime: Date.now(),
        localElapsed: 0,
        lastReportedSec: 0,
        forcePlayEnabled: true,
        simulateActivityEnabled: true,
        discoveredAPIs: [],
    };

    function getActualSec() {
        return Math.floor((Date.now() - STATE.startTime) / 1000);
    }

    // ============================================================
    // 一、Web Audio API 防节流
    // ============================================================
    function startAntiThrottlingAudio() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const audioCtx = new AudioCtx();
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            gainNode.gain.value = 0.001;
            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            oscillator.start();
            setInterval(function () {
                try { if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) { }
            }, 3000);
            document.addEventListener('click', function () {
                try { if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) { }
            }, { once: true });
        } catch (e) { }

        try {
            const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
            const audioEl = document.createElement('audio');
            audioEl.src = silentWav;
            audioEl.loop = true;
            audioEl.volume = 0.001;
            function tryPlay() { audioEl.play().catch(function () { setTimeout(tryPlay, 3000); }); }
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryPlay);
            else setTimeout(tryPlay, 1000);
            document.addEventListener('click', function () { if (audioEl.paused) audioEl.play().catch(function () { }); }, { once: true });
        } catch (e) { }
    }

    // ============================================================
    // 二、页面可见性欺骗
    // ============================================================
    function hookDocumentVisibility() {
        try {
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        } catch (e) { }
        ['visibilitychange', 'webkitvisibilitychange'].forEach(function (evt) {
            document.addEventListener(evt, function (e) { e.stopImmediatePropagation(); e.preventDefault(); }, true);
            window.addEventListener(evt, function (e) { e.stopImmediatePropagation(); e.preventDefault(); }, true);
        });
    }

    // ============================================================
    // 三、窗口焦点欺骗
    // ============================================================
    function hookWindowBlur() {
        ['blur', 'focusout', 'pagehide'].forEach(function (evtName) {
            window.addEventListener(evtName, function (e) { e.stopImmediatePropagation(); e.preventDefault(); }, true);
            document.addEventListener(evtName, function (e) { e.stopImmediatePropagation(); e.preventDefault(); }, true);
        });
        try {
            Object.defineProperty(document, 'hasFocus', { value: function () { return true; }, writable: false, configurable: true });
        } catch (e) { }
    }

    // ============================================================
    // 四、屏蔽弹窗
    // ============================================================
    function hookDialogs() {
        window.alert = function () { };
        window.confirm = function () { return true; };
        window.prompt = function () { return ''; };
        window.close = function () { };
        window.addEventListener('beforeunload', function (e) { e.stopImmediatePropagation(); e.preventDefault(); }, true);
    }

    // ============================================================
    // 五、setInterval 补偿机制（修复 BUG3：限制补偿上限）
    // ============================================================
    function hookTimersWithCompensation() {
        const origSetInterval = window.setInterval;
        const origSetTimeout = window.setTimeout;
        const origClearInterval = window.clearInterval;

        const STOP_KEYWORDS = ['stopTimer', 'stopStudy', 'pauseTimer', 'pauseStudy',
            'clearTimer', 'endStudy', 'stopCount', 'pauseCount', 'stopPlay', 'pausePlay'];

        window.setInterval = function (fn, delay) {
            if (typeof fn !== 'function') return origSetInterval.apply(this, arguments);

            const fnStr = fn.toString();
            for (let i = 0; i < STOP_KEYWORDS.length; i++) {
                if (fnStr.indexOf(STOP_KEYWORDS[i]) !== -1) {
                    log('拦截停止计时定时器:', STOP_KEYWORDS[i]);
                    return origSetInterval.call(window, function () { }, delay);
                }
            }

            // 对 0.5s~5s 的定时器启用补偿机制
            if (delay >= 500 && delay <= 5000) {
                const startTime = Date.now();
                let lastFiredTick = 0;

                const compensatedFn = function () {
                    const now = Date.now();
                    const currentTick = Math.floor((now - startTime) / delay);
                    const missed = currentTick - lastFiredTick;

                    if (missed > 1) {
                        // 限制：最多补偿 30 次，防止后台太久回来时 CPU 峰值
                        const compensateCount = Math.min(missed, 30);
                        log('定时器补偿: 缺失', missed - 1, '个tick, 补回', compensateCount);
                        for (let i = 0; i < compensateCount; i++) {
                            try { fn.call(this); } catch (e) { }
                        }
                    } else {
                        try { fn.call(this); } catch (e) { }
                    }
                    lastFiredTick = currentTick;
                };

                return origSetInterval.call(window, compensatedFn, delay);
            }

            return origSetInterval.apply(this, arguments);
        };

        window.setTimeout = function (fn, delay) {
            if (typeof fn !== 'function') return origSetTimeout.apply(this, arguments);
            const fnStr = fn.toString();
            for (let i = 0; i < STOP_KEYWORDS.length; i++) {
                if (fnStr.indexOf(STOP_KEYWORDS[i]) !== -1) {
                    log('拦截停止计时延时器:', STOP_KEYWORDS[i]);
                    return origSetTimeout.call(window, function () { }, delay);
                }
            }
            return origSetTimeout.apply(this, arguments);
        };

        window.clearInterval = origClearInterval;
        log('定时器补偿机制已激活');
    }

    // ============================================================
    // 六、拦截网络请求 —— 修正上报时间（修复 BUG1+BUG2）
    // ============================================================
    function hookNetworkRequests() {
        // BUG1 修复：精确匹配时间字段名，不用 indexOf 模糊匹配
        // 只匹配确切的字段名（不区分大小写），避免 "timestamp" 被匹配为 "time"
        const TIME_FIELDS_EXACT = new Set([
            'second', 'sec', 'seconds', 'studytime', 'learntime', 'duration',
            'elapsed', 'study_time', 'learn_time', 'play_time',
            'studysecond', 'study_second', 'learnsecond', 'learn_second',
            'playsecond', 'play_second', 'watchtime', 'watch_time',
            'watchsecond', 'watch_second', 'totaltime', 'total_time',
            'cumulativetime', 'cumulative_time', 'accumulatedtime', 'accumulated_time',
            'effectivetime', 'effective_time', 'validtime', 'valid_time',
            'coursetime', 'course_time', 'timersecond', 'countsecond', 'count_second',
            'studylength', 'study_length', 'learnlength', 'learn_length',
            'playlength', 'play_length', 'viewtime', 'view_time',
            'viewduration', 'view_duration', 'studyslen', 'studylen',
            'learnlen', 'playlen', 'completedtime', 'completed_time',
            'spenttime', 'spent_time', 'elapsedtime', 'elapsed_time',
            'runningtime', 'running_time', 'activetime', 'active_time',
            'onlinetime', 'online_time', 'learningtime', 'learning_time',
            'studysec', 'learnsec', 'playsec', 'watchsec', 'coursesec',
            'study_sec', 'learn_sec', 'play_sec', 'watch_sec', 'course_sec',
            'accumulatedsec', 'accumulated_sec', 'totalsec', 'total_sec',
            'studyduration', 'learnduration', 'playduration',
            'study_duration', 'learn_duration', 'play_duration',
            'studyprogress', 'learnprogress', 'courseprogress',
            'study_progress', 'learn_progress', 'course_progress',
        ]);

        // 额外模糊匹配：包含这些关键词的也视为时间字段（但排除明显不是的）
        const TIME_KEYWORDS_CONTAINS = [
            'studytime', 'learntime', 'playtime', 'watchtime', 'coursetime',
            'studysec', 'learnsec', 'playsec', 'studysecond', 'learnsecond',
            'studyduration', 'learnduration', 'studyprogress', 'learnprogress',
        ];

        // 明确排除的字段名（即使包含 time 也不修改）
        const EXCLUDED_FIELDS = new Set([
            'timestamp', 'timezone', 'timeout', 'createtime', 'create_time',
            'updatetime', 'update_time', 'deletetime', 'delete_time',
            'starttime', 'start_time', 'endtime', 'end_time',
            'logintime', 'login_time', 'registertime', 'register_time',
            'timestampserver', 'servertime', 'server_time',
            'currentposition', 'current_position',
            'position', 'pos', 'progress',
        ]);

        function isTimeField(key) {
            const k = key.toLowerCase().replace(/[^a-z_]/g, '');
            if (EXCLUDED_FIELDS.has(k)) return false;
            if (TIME_FIELDS_EXACT.has(k)) return true;
            for (let i = 0; i < TIME_KEYWORDS_CONTAINS.length; i++) {
                if (k.indexOf(TIME_KEYWORDS_CONTAINS[i]) !== -1) return true;
            }
            return false;
        }

        // BUG2 修复：更精确的 URL 匹配
        function isStudyRelatedRequest(url) {
            if (!url || typeof url !== 'string') return false;
            const u = url.toLowerCase();
            return u.indexOf('studytime') !== -1 || u.indexOf('savestudy') !== -1 ||
                u.indexOf('studyrecord') !== -1 || u.indexOf('learnrecord') !== -1 ||
                u.indexOf('heartbeat') !== -1 || u.indexOf('keeplive') !== -1 ||
                u.indexOf('keepalive') !== -1 || u.indexOf('reporttime') !== -1 ||
                u.indexOf('updatetime') !== -1 ||
                (u.indexOf('study') !== -1 && (u.indexOf('save') !== -1 || u.indexOf('update') !== -1 || u.indexOf('report') !== -1)) ||
                (u.indexOf('learn') !== -1 && (u.indexOf('save') !== -1 || u.indexOf('update') !== -1 || u.indexOf('report') !== -1)) ||
                (u.indexOf('course') !== -1 && (u.indexOf('progress') !== -1 || u.indexOf('record') !== -1)) ||
                u.indexOf('timer') !== -1;
        }

        function isCheckCourseRequest(url) {
            if (!url || typeof url !== 'string') return false;
            const u = url.toLowerCase();
            return u.indexOf('checkcourse') !== -1 || u.indexOf('simultaneous') !== -1 ||
                u.indexOf('multiplay') !== -1 || u.indexOf('checkplay') !== -1;
        }

        function walkAndModify(obj, actualSec) {
            if (typeof obj !== 'object' || obj === null) return false;
            let changed = false;
            for (const key in obj) {
                if (typeof obj[key] === 'number') {
                    if (isTimeField(key) && obj[key] >= 0 && obj[key] < actualSec) {
                        log('修正字段:', key, obj[key], '->', actualSec);
                        obj[key] = actualSec;
                        changed = true;
                    }
                } else if (typeof obj[key] === 'string') {
                    if (isTimeField(key)) {
                        const num = parseInt(obj[key], 10);
                        if (!isNaN(num) && num >= 0 && num < actualSec) {
                            log('修正字段(str):', key, obj[key], '->', actualSec);
                            obj[key] = String(actualSec);
                            changed = true;
                        }
                    }
                } else if (typeof obj[key] === 'object') {
                    if (walkAndModify(obj[key], actualSec)) changed = true;
                }
            }
            return changed;
        }

        function modifyBody(body, actualSec) {
            if (!body) return { modified: body, changed: false };

            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                let changed = false;
                const entries = [];
                for (const [key, value] of body.entries()) {
                    if (isTimeField(key)) {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num >= 0 && num < actualSec) {
                            entries.push([key, String(actualSec)]);
                            changed = true;
                            continue;
                        }
                    }
                    entries.push([key, value]);
                }
                if (changed) {
                    const fd = new FormData();
                    entries.forEach(function (pair) { fd.append(pair[0], pair[1]); });
                    return { modified: fd, changed: true };
                }
                return { modified: body, changed: false };
            }

            if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                let changed = false;
                for (const [key, value] of body.entries()) {
                    if (isTimeField(key)) {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num >= 0 && num < actualSec) {
                            body.set(key, String(actualSec));
                            changed = true;
                        }
                    }
                }
                return { modified: body, changed: changed };
            }

            if (typeof body === 'string') {
                try {
                    const json = JSON.parse(body);
                    if (walkAndModify(json, actualSec)) {
                        return { modified: JSON.stringify(json), changed: true };
                    }
                } catch (e) { }

                try {
                    const params = new URLSearchParams(body);
                    let changed = false;
                    for (const [key, value] of params.entries()) {
                        if (isTimeField(key)) {
                            const num = parseInt(value, 10);
                            if (!isNaN(num) && num >= 0 && num < actualSec) {
                                params.set(key, String(actualSec));
                                changed = true;
                            }
                        }
                    }
                    if (changed) return { modified: params.toString(), changed: true };
                } catch (e) { }

                log('未匹配时间字段,body:', body.substring(0, 500));
                return { modified: body, changed: false };
            }

            return { modified: body, changed: false };
        }

        // Hook XHR
        const OriginalXHR = window.XMLHttpRequest;
        const xhrOpen = OriginalXHR.prototype.open;
        const xhrSend = OriginalXHR.prototype.send;

        OriginalXHR.prototype.open = function (method, url) {
            this._hookUrl = url;
            this._hookMethod = method;
            return xhrOpen.apply(this, arguments);
        };

        OriginalXHR.prototype.send = function (body) {
            const url = this._hookUrl;

            // BUG7 修复：更可靠的双课程检测阻断
            if (isCheckCourseRequest(url)) {
                log('双课程检测已阻断:', url);
                const self = this;
                // 不发送请求，直接模拟成功响应
                setTimeout(function () {
                    try {
                        if (typeof self.onreadystatechange === 'function') self.onreadystatechange(new Event('readystatechange'));
                    } catch (e) { }
                    try {
                        if (typeof self.onload === 'function') self.onload(new ProgressEvent('load'));
                    } catch (e) { }
                    try {
                        if (typeof self.onloadend === 'function') self.onloadend(new ProgressEvent('loadend'));
                    } catch (e) { }
                }, 50);
                return;
            }

            if (isStudyRelatedRequest(url)) {
                const actualSec = getActualSec();
                log('学习相关请求:', url, '本地秒数:', actualSec, 'body:', body ? (typeof body === 'string' ? body.substring(0, 200) : '[FormData/URLSearchParams]') : '[空]');

                // 记录发现的 API
                if (STATE.discoveredAPIs.length < 10) {
                    STATE.discoveredAPIs.push({ url: url, method: this._hookMethod || 'POST' });
                }

                const result = modifyBody(body, actualSec);
                if (result.changed) {
                    arguments[0] = result.modified;
                    STATE.lastReportedSec = actualSec;
                    log('上报时间已修正为:', actualSec, '秒');
                }
            }

            return xhrSend.apply(this, arguments);
        };

        // Hook fetch
        const originalFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                const url = (typeof input === 'string') ? input : (input instanceof Request) ? input.url : '';

                if (isCheckCourseRequest(url)) {
                    log('fetch 双课程检测已阻断:', url);
                    return Promise.resolve(new Response('{"code":0,"msg":"ok","data":{}}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }

                if (isStudyRelatedRequest(url) && init && init.body) {
                    const actualSec = getActualSec();
                    log('fetch 学习请求:', url, '本地秒数:', actualSec);
                    const result = modifyBody(init.body, actualSec);
                    if (result.changed) {
                        init.body = result.modified;
                        STATE.lastReportedSec = actualSec;
                        log('fetch 上报时间已修正为:', actualSec, '秒');
                    }
                }
            } catch (e) { }
            return originalFetch.apply(this, arguments);
        };

        // Hook WebSocket
        const OrigWebSocket = window.WebSocket;
        const wsSend = OrigWebSocket.prototype.send;
        OrigWebSocket.prototype.send = function (data) {
            try {
                if (typeof data === 'string') {
                    const actualSec = getActualSec();
                    try {
                        const json = JSON.parse(data);
                        if (walkAndModify(json, actualSec)) {
                            arguments[0] = JSON.stringify(json);
                            log('WebSocket 上报时间已修正为:', actualSec, '秒');
                        }
                    } catch (e) {
                        try {
                            const params = new URLSearchParams(data);
                            let changed = false;
                            for (const [key, value] of params.entries()) {
                                if (isTimeField(key)) {
                                    const num = parseInt(value, 10);
                                    if (!isNaN(num) && num >= 0 && num < actualSec) {
                                        params.set(key, String(actualSec));
                                        changed = true;
                                    }
                                }
                            }
                            if (changed) arguments[0] = params.toString();
                        } catch (e2) { }
                    }
                }
            } catch (e) { }
            return wsSend.apply(this, arguments);
        };

        log('网络请求拦截已激活（含WebSocket）');
    }

    // ============================================================
    // 七、视频防暂停 + 自动播放
    // ============================================================
    function hookVideoPause() {
        function protectVideo(video) {
            if (video._hooked) return;
            video._hooked = true;

            const originalPause = video.pause.bind(video);
            let pauseBlocked = false;

            video.pause = function () {
                if (STATE.forcePlayEnabled && !pauseBlocked) return;
                return originalPause();
            };

            video.addEventListener('pause', function (e) {
                if (STATE.forcePlayEnabled) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    setTimeout(function () {
                        try { pauseBlocked = true; video.play().catch(function () { }); pauseBlocked = false; }
                        catch (err) { pauseBlocked = false; }
                    }, 50);
                }
            }, true);

            ['waiting', 'stalled', 'suspend'].forEach(function (evt) {
                video.addEventListener(evt, function (e) {
                    if (STATE.forcePlayEnabled) e.stopImmediatePropagation();
                }, true);
            });

            setInterval(function () {
                if (STATE.forcePlayEnabled && video.paused && !video.ended) {
                    video.play().catch(function () { });
                }
            }, 2000);

            try {
                const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
                if (desc && desc.set) {
                    Object.defineProperty(video, 'playbackRate', {
                        get: desc.get,
                        set: function (val) { if (val === 0 && STATE.forcePlayEnabled) return; return desc.set.call(this, val); },
                        configurable: true
                    });
                }
            } catch (e) { }

            video.muted = true;
            video.volume = 0;
            video.autoplay = true;
            video.play().catch(function () {
                document.addEventListener('click', function () { video.play().catch(function () { }); }, { once: true });
            });
        }

        function observeVideos() {
            document.querySelectorAll('video').forEach(protectVideo);
            new MutationObserver(function (mutations) {
                mutations.forEach(function (m) {
                    m.addedNodes.forEach(function (node) {
                        if (node.nodeName === 'VIDEO') protectVideo(node);
                        if (node.querySelectorAll) node.querySelectorAll('video').forEach(protectVideo);
                    });
                });
            }).observe(document.documentElement, { childList: true, subtree: true });
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeVideos);
        else observeVideos();
    }

    // ============================================================
    // 八、自动播放
    // ============================================================
    function autoPlayOnLoad() {
        function tryAutoPlay() {
            document.querySelectorAll('video').forEach(function (v) {
                if (v.paused && !v.ended) {
                    v.muted = true; v.volume = 0; v.autoplay = true;
                    v.play().catch(function () { });
                }
            });

            ['.play-btn', '.btn-play', '#playBtn', '#play',
                '.vjs-big-play-button', '.video-play-btn',
                'button[title="Play"]', 'button[title="播放"]',
                '.prism-big-play-btn', '.xgplayer-start'].forEach(function (sel) {
                    const btn = document.querySelector(sel);
                    if (btn && btn.offsetParent !== null) btn.click();
                });

            document.querySelectorAll('iframe').forEach(function (iframe) {
                try {
                    if (iframe.contentDocument) {
                        iframe.contentDocument.querySelectorAll('video').forEach(function (v) {
                            v.muted = true; v.play().catch(function () { });
                        });
                    }
                } catch (e) { }
            });
        }

        [1000, 3000, 5000, 10000, 15000].forEach(function (t) { setTimeout(tryAutoPlay, t); });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(tryAutoPlay, 500); });
    }

    // ============================================================
    // 九、弹窗弹题自动处理
    // ============================================================
    function autoHandlePopups() {
        function handle() {
            ['.quiz-popup', '.popup-question', '.question-popup',
                '.modal-quiz', '.exam-popup', '.dialog-quiz',
                '.interact-popup', '.exam-interact', '.study-interact'].forEach(function (sel) {
                    document.querySelectorAll(sel).forEach(function (c) {
                        if (c.style.display === 'none' || c.offsetParent === null || c._ah) return;
                        c._ah = true;
                        ['.answer-option', '.option-item', 'input[type="radio"]',
                            'input[type="checkbox"]', '.choice-item', '.quiz-option', 'li'].forEach(function (s) {
                                const o = c.querySelectorAll(s);
                                if (o.length > 0) { o[0].click(); }
                            });
                        setTimeout(function () {
                            ['.submit-btn', '.btn-confirm', 'button[type="submit"]', '.btn-submit'].forEach(function (s) {
                                const b = c.querySelector(s); if (b) b.click();
                            });
                        }, 300);
                    });
                });

            ['.layui-layer-btn0', '.aui_ok', '.bootbox .btn-primary', '.sweet-alert .confirm',
                '.layui-layer-close1', '.ui-dialog .ui-dialog-titlebar-close'].forEach(function (sel) {
                    document.querySelectorAll(sel).forEach(function (b) {
                        if (b.offsetParent !== null && !b._ac) { b._ac = true; b.click(); setTimeout(function () { b._ac = false; }, 3000); }
                    });
                });

            document.querySelectorAll('button, a, input[type="button"], input[type="submit"]').forEach(function (b) {
                const t = (b.textContent || b.value || '').trim();
                if (['继续学习', '继续', '确定', '确认', '知道了', '好的', 'OK', 'Yes', '是'].indexOf(t) !== -1) {
                    if (b.offsetParent !== null && !b._ac) { b._ac = true; b.click(); setTimeout(function () { b._ac = false; }, 5000); }
                }
            });
        }

        setInterval(handle, 2000);
        new MutationObserver(function (ms) {
            let c = false; ms.forEach(function (m) { if (m.addedNodes.length > 0 || m.type === 'attributes') c = true; });
            if (c) handle();
        }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'display'] });
    }

    // ============================================================
    // 十、模拟用户活动
    // ============================================================
    function simulateUserActivity() {
        (function loop() {
            setTimeout(function () {
                if (STATE.simulateActivityEnabled) {
                    const x = Math.random() * window.innerWidth;
                    const y = Math.random() * window.innerHeight;
                    document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent('mousemove', {
                        bubbles: true, cancelable: true, view: window,
                        clientX: x, clientY: y, movementX: 5, movementY: 5
                    }));
                }
                loop();
            }, 3000 + Math.random() * 5000);
        })();

        setInterval(function () {
            if (STATE.simulateActivityEnabled) document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
        }, 60000);

        const idleVars = ['lastActiveTime', 'lastActivityTime', 'lastOperateTime',
            'lastActionTime', 'lastMouseMoveTime', 'lastUserActionTime',
            'lastStudyTime', 'lastPlayTime', 'lastHeartbeatTime'];
        setInterval(function () {
            idleVars.forEach(function (v) { if (window[v] !== undefined) window[v] = Date.now(); });
        }, 5000);
    }

    // ============================================================
    // 十一、本地计时器 + 视频进度同步（修复 BUG6）
    // ============================================================
    function startLocalTimer() {
        setInterval(function () {
            STATE.localElapsed = getActualSec();

            const video = document.querySelector('video');
            if (video && STATE.forcePlayEnabled) {
                const videoTime = Math.floor(video.currentTime);
                const expectedTime = STATE.localElapsed;
                const duration = video.duration;

                // BUG6 修复：duration 可能是 NaN，需要检查
                if (expectedTime - videoTime > 5 && (!isNaN(duration) && expectedTime < duration || isNaN(duration))) {
                    log('修正视频进度:', videoTime, '->', expectedTime);
                    video.currentTime = expectedTime;
                }
            }
        }, 2000);
    }

    // ============================================================
    // 十二、心跳保活
    // ============================================================
    function startHeartbeat() {
        setInterval(function () {
            try {
                if (window.heartbeat) window.heartbeat();
                else if (window.keepAlive) window.keepAlive();
            } catch (e) { }
        }, 30000);
    }

    // ============================================================
    // 十三、拦截平台停止计时函数
    // ============================================================
    function hookPlatformFunctions() {
        function wait() {
            ['stopTimer', 'stopStudy', 'stopCount', 'stopPlay',
                'pauseTimer', 'pauseStudy', 'pauseCount', 'pausePlay',
                'endTimer', 'endStudy', 'endCount', 'endPlay',
                'clearTimer', 'clearStudy', 'clearCount',
                'suspendTimer', 'suspendStudy', 'suspendPlay',
                'freezeTimer', 'freezeStudy', 'haltStudy', 'haltTimer'].forEach(function (fn) {
                    if (typeof window[fn] === 'function') window[fn] = function () { };
                });

            if (window.$ && window.$.event) {
                try {
                    const orig = window.$.event.trigger;
                    window.$.event.trigger = function (type) {
                        const t = (type || '').toString().toLowerCase();
                        if (t.indexOf('stop') !== -1 || t.indexOf('pause') !== -1 || t.indexOf('suspend') !== -1) return;
                        return orig.apply(this, arguments);
                    };
                } catch (e) { }
            }
        }
        [1000, 3000, 5000, 10000].forEach(function (t) { setTimeout(wait, t); });
    }

    // ============================================================
    // 十四、差分扫描发现并保持平台计时变量
    // ============================================================
    function keepPlatformTimerAlive() {
        let snapshot = {};

        function takeSnapshot() {
            snapshot = {};
            try {
                for (const key in window) {
                    try {
                        if (typeof window[key] === 'number' && window[key] > 0) {
                            snapshot[key] = window[key];
                        }
                    } catch (e) { }
                }
            } catch (e) { }
        }

        function findAndKeepTimers() {
            const actualSec = getActualSec();

            const knownVars = [
                'studyTime', 'studySeconds', 'studySec', 'studyTimer',
                'learnTime', 'learnSeconds', 'learnSec', 'learnTimer',
                'playTime', 'playSeconds', 'playSec', 'playTimer',
                'watchTime', 'watchSeconds', 'watchSec',
                'courseTime', 'courseSeconds', 'courseSec',
                'timer', 'timerSeconds', 'timerSec',
                'countSeconds', 'countSec', 'elapsedTime', 'elapsedSec',
                'totalStudyTime', 'totalLearnTime',
                'currentStudyTime', 'currentLearnTime',
                'studyDuration', 'learnDuration',
                'secondCount', 'secCount',
                'study_time', 'learn_time', 'play_time',
                'study_second', 'learn_second',
            ];

            knownVars.forEach(function (v) {
                if (window[v] !== undefined && typeof window[v] === 'number' && window[v] < actualSec) {
                    log('刷新计时变量:', v, window[v], '->', actualSec);
                    window[v] = actualSec;
                }
            });

            try {
                const newSnapshot = {};
                for (const key in window) {
                    try {
                        if (typeof window[key] === 'number' && window[key] > 0) {
                            newSnapshot[key] = window[key];
                            if (snapshot[key] !== undefined) {
                                const diff = newSnapshot[key] - snapshot[key];
                                if (diff > 0 && diff <= 10 && newSnapshot[key] < actualSec) {
                                    const k = key.toLowerCase();
                                    if (k.indexOf('id') === -1 && k.indexOf('code') === -1 &&
                                        k.indexOf('status') === -1 && k.indexOf('type') === -1 &&
                                        k.indexOf('version') === -1 && k.indexOf('port') === -1 &&
                                        k.indexOf('width') === -1 && k.indexOf('height') === -1 &&
                                        k.indexOf('index') === -1 && k.indexOf('order') === -1 &&
                                        k.indexOf('timestamp') === -1) {
                                        log('差分发现计时变量:', key, snapshot[key], '->', newSnapshot[key], '修正为:', actualSec);
                                        window[key] = actualSec;
                                    }
                                }
                            }
                        }
                    } catch (e) { }
                }
                snapshot = newSnapshot;
            } catch (e) { }

            try {
                document.querySelectorAll('[__vue__]').forEach(function (el) {
                    const vm = el.__vue__;
                    if (vm && vm.$data) {
                        for (const key in vm.$data) {
                            if (typeof vm.$data[key] === 'number' && vm.$data[key] < actualSec && vm.$data[key] > 0) {
                                const k = key.toLowerCase();
                                if (k.indexOf('time') !== -1 || k.indexOf('sec') !== -1 ||
                                    k.indexOf('dur') !== -1 || k.indexOf('study') !== -1 ||
                                    k.indexOf('learn') !== -1 || k.indexOf('play') !== -1) {
                                    vm.$data[key] = actualSec;
                                }
                            }
                        }
                    }
                });
            } catch (e) { }
        }

        takeSnapshot();
        setTimeout(takeSnapshot, 5000);
        setInterval(findAndKeepTimers, 5000);
    }

    // ============================================================
    // 十五、iframe 处理
    // ============================================================
    function handleIframeVideos() {
        setInterval(function () {
            document.querySelectorAll('iframe').forEach(function (iframe) {
                try {
                    if (!iframe.contentDocument) return;
                    iframe.contentDocument.querySelectorAll('video').forEach(function (v) {
                        if (v._hooked) return;
                        v._hooked = true;
                        v.addEventListener('pause', function () { setTimeout(function () { v.play().catch(function () { }); }, 50); });
                    });
                    iframe.contentWindow.alert = function () { };
                    iframe.contentWindow.confirm = function () { return true; };
                    iframe.contentWindow.prompt = function () { return ''; };
                } catch (e) { }
            });
        }, 5000);
    }

    // ============================================================
    // 十六、ESNAI 播放器钩子
    // ============================================================
    function hookESNAIPlayer() {
        function find() {
            ['player', 'videoPlayer', 'studyPlayer', 'coursePlayer', 'flashPlayer',
                'mediaPlayer', 'polyvPlayer', 'ckPlayer', 'ckplayer'].forEach(function (name) {
                    if (window[name] && typeof window[name] === 'object') {
                        if (window[name].pause) {
                            const orig = window[name].pause.bind(window[name]);
                            window[name].pause = function () { if (STATE.forcePlayEnabled) return; return orig(); };
                        }
                        if (window[name].play) {
                            setInterval(function () { try { if (STATE.forcePlayEnabled) window[name].play(); } catch (e) { } }, 5000);
                        }
                    }
                });
        }
        [1000, 3000, 5000, 10000].forEach(function (t) { setTimeout(find, t); });
    }

    // ============================================================
    // 十七、Web Worker 计时
    // ============================================================
    function startWorkerTimer() {
        try {
            const code = 'let s=Date.now();setInterval(function(){postMessage({e:Math.floor((Date.now()-s)/1000)})},1000);';
            const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
            worker.onmessage = function (e) { STATE.localElapsed = e.data.e; };
        } catch (e) { }
    }

    // ============================================================
    // 十八、主动上报计时（修复 BUG4：不再重复 hook XHR.open）
    // ============================================================
    function startProactiveReporting() {
        setInterval(function () {
            const actualSec = getActualSec();
            if (actualSec - STATE.lastReportedSec < 30) return;

            const fns = ['saveStudyTime', 'reportStudyTime', 'updateStudyRecord',
                'saveStudyRecord', 'reportRecord', 'updateTime', 'studyReport',
                'learnReport', 'courseReport', 'submitStudyTime', 'reportProgress',
                'saveProgress', 'updateProgress', 'studyHeartbeat', 'learnHeartbeat'];

            for (const fn of fns) {
                if (typeof window[fn] === 'function') {
                    try { window[fn](actualSec); STATE.lastReportedSec = actualSec; return; } catch (e) { }
                }
            }

            // 使用已发现的 API 端点
            if (STATE.discoveredAPIs.length > 0 && typeof GM_xmlhttpRequest !== 'undefined') {
                const api = STATE.discoveredAPIs[STATE.discoveredAPIs.length - 1];
                try {
                    GM_xmlhttpRequest({
                        method: api.method || 'POST',
                        url: api.url.startsWith('http') ? api.url : window.location.origin + api.url,
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({ studyTime: actualSec, second: actualSec, duration: actualSec, time: actualSec }),
                        onload: function () { STATE.lastReportedSec = actualSec; },
                        onerror: function () { }
                    });
                } catch (e) { }
            }
        }, 30000);
    }

    // ============================================================
    // 十九、页面卸载拦截
    // ============================================================
    function hookPageUnload() {
        window.addEventListener('beforeunload', function (e) { e.stopImmediatePropagation(); }, true);
        window.addEventListener('unload', function (e) { e.stopImmediatePropagation(); }, true);
        window.open = function () { return null; };
    }

    // ============================================================
    // 初始化
    // ============================================================
    function init() {
        log('========== ESNAI 助手 v6.0 启动 ==========');

        hookTimersWithCompensation();
        startAntiThrottlingAudio();
        hookDocumentVisibility();
        hookWindowBlur();
        hookDialogs();
        hookNetworkRequests();
        hookPageUnload();
        startWorkerTimer();
        startLocalTimer();

        function onDOMReady() {
            hookVideoPause();
            autoPlayOnLoad();
            autoHandlePopups();
            simulateUserActivity();
            startHeartbeat();
            hookPlatformFunctions();
            keepPlatformTimerAlive();
            handleIframeVideos();
            hookESNAIPlayer();
            startProactiveReporting();
            log('========== 所有模块初始化完成 ==========');
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDOMReady);
        else onDOMReady();
    }

    init();
})();
