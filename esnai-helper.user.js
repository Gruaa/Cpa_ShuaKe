// ==UserScript==
// @name         ESNAI继续教育视频学习助手
// @namespace    https://ce.esnai.net/
// @version      9.0.0
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

    var LOG_ENABLED = true;
    function log() { if (LOG_ENABLED) console.log.apply(console, ['[ESNAI助手]'].concat(Array.prototype.slice.call(arguments))); }

    // ============================================================
    // 持久化状态：刷新后不丢失
    // ============================================================
    var STORAGE_KEY = 'esnai_helper_state';

    function loadState() {
        try {
            var saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                var s = JSON.parse(saved);
                // 如果上次保存时间在2小时内，恢复startTime
                if (s.startTime && (Date.now() - s.startTime) < 2 * 60 * 60 * 1000) {
                    return s;
                }
            }
        } catch (e) { }
        return null;
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                startTime: STATE.startTime,
                lastKnownVideoTime: STATE.lastKnownVideoTime,
                savedAt: Date.now(),
            }));
        } catch (e) { }
    }

    var savedState = loadState();
    var STATE = {
        startTime: savedState ? savedState.startTime : Date.now(),
        localElapsed: 0,
        forcePlayEnabled: true,
        simulateActivityEnabled: true,
        lastKnownVideoTime: savedState ? (savedState.lastKnownVideoTime || 0) : 0,
        engineReady: false,
    };

    function getActualSec() {
        return Math.floor((Date.now() - STATE.startTime) / 1000);
    }

    // 定期保存状态
    setInterval(saveState, 10000);

    // ============================================================
    // 一、Web Audio API 防节流
    // ============================================================
    function startAntiThrottlingAudio() {
        try {
            var AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            var audioCtx = new AudioCtx();
            try {
                var dest = audioCtx.createMediaStreamDestination();
                var oscillator = audioCtx.createOscillator();
                var gainNode = audioCtx.createGain();
                gainNode.gain.value = 0.001;
                oscillator.connect(gainNode);
                gainNode.connect(dest);
                gainNode.connect(audioCtx.destination);
                oscillator.start();
                var audioEl = document.createElement('audio');
                audioEl.srcObject = dest.stream;
                audioEl.volume = 0.001;
                audioEl.id = 'esnai-anti-throttle';
                audioEl.play().catch(function () {
                    document.addEventListener('click', function () { audioEl.play().catch(function () { }); }, { once: true });
                });
            } catch (e) {
                var osc = audioCtx.createOscillator();
                var gn = audioCtx.createGain();
                gn.gain.value = 0.001;
                osc.connect(gn);
                gn.connect(audioCtx.destination);
                osc.start();
            }
            setInterval(function () {
                try { if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) { }
            }, 2000);
            document.addEventListener('click', function () {
                try { if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) { }
                var el = document.getElementById('esnai-anti-throttle');
                if (el && el.paused) el.play().catch(function () { });
            }, { once: true });
        } catch (e) { }

        try {
            var sampleRate = 8000;
            var numSamples = sampleRate;
            var dataSize = numSamples * 2;
            var buffer = new ArrayBuffer(44 + dataSize);
            var view = new DataView(buffer);
            function writeString(offset, str) { for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
            writeString(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeString(8, 'WAVE');
            writeString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
            view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
            view.setUint16(34, 16, true); writeString(36, 'data'); view.setUint32(40, dataSize, true);
            for (var i = 0; i < numSamples; i++) {
                var sample = Math.sin(i * 440 * 2 * Math.PI / sampleRate) * 3;
                view.setInt16(44 + i * 2, sample, true);
            }
            var blob = new Blob([buffer], { type: 'audio/wav' });
            var url = URL.createObjectURL(blob);
            var audioEl2 = document.createElement('audio');
            audioEl2.src = url; audioEl2.loop = true; audioEl2.volume = 0.001; audioEl2.id = 'esnai-anti-throttle2';
            function tryPlay2() { audioEl2.play().catch(function () { setTimeout(tryPlay2, 3000); }); }
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryPlay2);
            else setTimeout(tryPlay2, 1000);
            document.addEventListener('click', function () { if (audioEl2.paused) audioEl2.play().catch(function () { }); }, { once: true });
        } catch (e) { }
    }

    // ============================================================
    // 二、页面可见性欺骗
    // ============================================================
    function hookDocumentVisibility() {
        try {
            Object.defineProperty(document, 'hidden', { get: function () { return false; }, configurable: true });
            Object.defineProperty(document, 'visibilityState', { get: function () { return 'visible'; }, configurable: true });
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
    // 五、setInterval 平滑补偿（降低上限，避免平台检测异常）
    // ============================================================
    function hookTimersWithCompensation() {
        var origSetInterval = window.setInterval;
        var origSetTimeout = window.setTimeout;
        var STOP_KEYWORDS = ['stopTimer', 'stopStudy', 'pauseTimer', 'pauseStudy',
            'clearTimer', 'endStudy', 'stopCount', 'pauseCount', 'stopPlay', 'pausePlay'];

        window.setInterval = function (fn, delay) {
            if (typeof fn !== 'function') return origSetInterval.apply(this, arguments);
            var fnStr = fn.toString();
            for (var i = 0; i < STOP_KEYWORDS.length; i++) {
                if (fnStr.indexOf(STOP_KEYWORDS[i]) !== -1) {
                    log('拦截停止计时定时器:', STOP_KEYWORDS[i]);
                    return origSetInterval.call(window, function () { }, delay);
                }
            }
            // 只对 0.5s~3s 的定时器启用补偿（平台计时器通常是1秒）
            if (delay >= 500 && delay <= 3000) {
                var startTime = Date.now();
                var lastFiredTick = 0;
                var compensatedFn = function () {
                    var now = Date.now();
                    var currentTick = Math.floor((now - startTime) / delay);
                    var missed = currentTick - lastFiredTick;
                    if (missed > 1) {
                        // 平滑补偿：最多补5次，避免平台检测到跳变
                        var compensateCount = Math.min(missed, 5);
                        for (var j = 0; j < compensateCount; j++) {
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
            var fnStr = fn.toString();
            for (var i = 0; i < STOP_KEYWORDS.length; i++) {
                if (fnStr.indexOf(STOP_KEYWORDS[i]) !== -1) {
                    log('拦截停止计时延时器:', STOP_KEYWORDS[i]);
                    return origSetTimeout.call(window, function () { }, delay);
                }
            }
            return origSetTimeout.apply(this, arguments);
        };
    }

    // ============================================================
    // 六、核心：video.currentTime 持续推进引擎（v9.0 重写）
    // ============================================================
    function startVideoTimeEngine() {
        var lastKnownTime = -1;  // -1 表示未初始化
        var lastUpdateTime = 0;
        var initialized = false;

        function waitForVideo() {
            var video = document.querySelector('video');
            if (!video) {
                setTimeout(waitForVideo, 1000);
                return;
            }

            // 等待视频加载到可以获取 currentTime
            if (video.readyState < 1) {
                video.addEventListener('loadedmetadata', function () {
                    initEngine(video);
                }, { once: true });
                // 超时保护：5秒后强制初始化
                setTimeout(function () { if (!initialized) initEngine(video); }, 5000);
            } else {
                initEngine(video);
            }
        }

        function initEngine(video) {
            if (initialized) return;
            initialized = true;
            STATE.engineReady = true;

            // 从视频当前位置初始化，不从0
            lastKnownTime = video.currentTime;
            lastUpdateTime = Date.now();

            log('视频时间引擎初始化: currentTime=' + Math.floor(lastKnownTime) + '秒, 累计学习=' + getActualSec() + '秒');

            // 每2秒检查一次
            setInterval(function () { tick(video); }, 2000);
        }

        function tick(video) {
            var now = Date.now();

            // 视频正在正常播放 → 更新跟踪值
            if (!video.paused && !video.ended && video.readyState >= 2) {
                lastKnownTime = video.currentTime;
                lastUpdateTime = now;
                STATE.lastKnownVideoTime = video.currentTime;
                return;
            }

            // 视频暂停或后台节流导致停滞
            var timeSinceLastUpdate = (now - lastUpdateTime) / 1000;
            if (timeSinceLastUpdate > 3 && lastKnownTime >= 0) {
                var targetTime = lastKnownTime + timeSinceLastUpdate;
                var duration = video.duration;

                // 不超过视频总时长
                if (!isNaN(duration) && targetTime > duration) {
                    targetTime = duration;
                }

                // 推进视频进度
                if (!isNaN(duration) && targetTime <= duration || isNaN(duration)) {
                    video.currentTime = targetTime;
                    lastKnownTime = targetTime;
                    lastUpdateTime = now;
                    STATE.lastKnownVideoTime = targetTime;
                    log('视频进度推进:', Math.floor(targetTime), '秒 (停滞了', Math.floor(timeSinceLastUpdate), '秒)');
                }
            }

            // 确保视频在播放
            if (STATE.forcePlayEnabled && video.paused && !video.ended) {
                video.play().catch(function () { });
            }
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', waitForVideo);
        } else {
            waitForVideo();
        }

        log('视频时间引擎已启动');
    }

    // ============================================================
    // 七、视频防暂停 + 自动播放
    // ============================================================
    function hookVideoPause() {
        function protectVideo(video) {
            if (video._hooked) return;
            video._hooked = true;

            var originalPause = video.pause.bind(video);
            var pauseBlocked = false;

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
                var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
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
    // 八、自动播放（更可靠）
    // ============================================================
    function autoPlayOnLoad() {
        function tryAutoPlay() {
            // 查找所有视频并播放
            document.querySelectorAll('video').forEach(function (v) {
                if (v.paused && !v.ended) {
                    v.muted = true; v.volume = 0; v.autoplay = true;
                    v.play().catch(function () { });
                }
            });

            // 点击播放按钮
            ['.play-btn', '.btn-play', '#playBtn', '#play',
                '.vjs-big-play-button', '.video-play-btn',
                'button[title="Play"]', 'button[title="播放"]',
                '.prism-big-play-btn', '.xgplayer-start',
                '.ckplayer-playswitch', '.ckplayer-play',
                '.video-play', '.player-play'].forEach(function (sel) {
                    var btn = document.querySelector(sel);
                    if (btn && btn.offsetParent !== null) btn.click();
                });

            // iframe 内的视频
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

        // 多次尝试，覆盖各种加载时序
        [500, 1000, 2000, 3000, 5000, 8000, 10000, 15000, 20000].forEach(function (t) {
            setTimeout(tryAutoPlay, t);
        });
    }

    // ============================================================
    // 九、弹窗弹题自动处理
    // ============================================================
    function autoHandlePopups() {
        function handle() {
            ['.quiz-popup', '.popup-question', '.question-popup',
                '.modal-quiz', '.exam-popup', '.dialog-quiz',
                '.interact-popup', '.exam-interact', '.study-interact',
                '.layui-layer', '.layui-layer-dialog'].forEach(function (sel) {
                    document.querySelectorAll(sel).forEach(function (c) {
                        if (c.style.display === 'none' || c.offsetParent === null || c._ah) return;
                        c._ah = true;
                        ['.answer-option', '.option-item', 'input[type="radio"]',
                            'input[type="checkbox"]', '.choice-item', '.quiz-option', 'li'].forEach(function (s) {
                                var o = c.querySelectorAll(s);
                                if (o.length > 0) { o[0].click(); }
                            });
                        setTimeout(function () {
                            ['.submit-btn', '.btn-confirm', 'button[type="submit"]', '.btn-submit'].forEach(function (s) {
                                var b = c.querySelector(s); if (b) b.click();
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
                var t = (b.textContent || b.value || '').trim();
                if (['继续学习', '继续', '确定', '确认', '知道了', '好的', 'OK', 'Yes', '是'].indexOf(t) !== -1) {
                    if (b.offsetParent !== null && !b._ac) { b._ac = true; b.click(); setTimeout(function () { b._ac = false; }, 5000); }
                }
            });
        }
        setInterval(handle, 2000);
        new MutationObserver(function (ms) {
            var c = false; ms.forEach(function (m) { if (m.addedNodes.length > 0 || m.type === 'attributes') c = true; });
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
                    var x = Math.random() * window.innerWidth;
                    var y = Math.random() * window.innerHeight;
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
        var idleVars = ['lastActiveTime', 'lastActivityTime', 'lastOperateTime',
            'lastActionTime', 'lastMouseMoveTime', 'lastUserActionTime',
            'lastStudyTime', 'lastPlayTime', 'lastHeartbeatTime'];
        setInterval(function () {
            idleVars.forEach(function (v) { if (window[v] !== undefined) window[v] = Date.now(); });
        }, 5000);
    }

    // ============================================================
    // 十一、拦截平台停止计时函数
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
                    var orig = window.$.event.trigger;
                    window.$.event.trigger = function (type) {
                        var t = (type || '').toString().toLowerCase();
                        if (t.indexOf('stop') !== -1 || t.indexOf('pause') !== -1 || t.indexOf('suspend') !== -1) return;
                        return orig.apply(this, arguments);
                    };
                } catch (e) { }
            }
        }
        [1000, 3000, 5000, 10000].forEach(function (t) { setTimeout(wait, t); });
    }

    // ============================================================
    // 十二、差分扫描发现并保持平台计时变量
    // ============================================================
    function keepPlatformTimerAlive() {
        var snapshot = {};
        function takeSnapshot() {
            snapshot = {};
            try { for (var key in window) { try { if (typeof window[key] === 'number' && window[key] > 0) snapshot[key] = window[key]; } catch (e) { } } } catch (e) { }
        }
        function findAndKeepTimers() {
            var actualSec = getActualSec();
            var knownVars = ['studyTime', 'studySeconds', 'studySec', 'studyTimer',
                'learnTime', 'learnSeconds', 'learnSec', 'learnTimer',
                'playTime', 'playSeconds', 'playSec', 'playTimer',
                'watchTime', 'watchSeconds', 'watchSec', 'courseTime',
                'timer', 'timerSeconds', 'timerSec', 'countSeconds',
                'elapsedTime', 'elapsedSec', 'secondCount', 'secCount'];
            knownVars.forEach(function (v) {
                if (window[v] !== undefined && typeof window[v] === 'number' && window[v] >= 0 && window[v] < actualSec) {
                    log('刷新计时变量:', v, window[v], '->', actualSec);
                    window[v] = actualSec;
                }
            });
            try {
                var newSnapshot = {};
                for (var key in window) {
                    try {
                        if (typeof window[key] === 'number' && window[key] > 0) {
                            newSnapshot[key] = window[key];
                            if (snapshot[key] !== undefined) {
                                var diff = newSnapshot[key] - snapshot[key];
                                if (diff > 0 && diff <= 10 && newSnapshot[key] < actualSec) {
                                    var k = key.toLowerCase();
                                    if (k.indexOf('id') === -1 && k.indexOf('code') === -1 &&
                                        k.indexOf('status') === -1 && k.indexOf('type') === -1 &&
                                        k.indexOf('version') === -1 && k.indexOf('timestamp') === -1) {
                                        log('差分发现计时变量:', key, '修正为:', actualSec);
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
                    var vm = el.__vue__;
                    if (vm && vm.$data) {
                        for (var key in vm.$data) {
                            if (typeof vm.$data[key] === 'number' && vm.$data[key] < actualSec && vm.$data[key] >= 0) {
                                var k = key.toLowerCase();
                                if (k.indexOf('time') !== -1 || k.indexOf('sec') !== -1 || k.indexOf('study') !== -1) {
                                    vm.$data[key] = actualSec;
                                }
                            }
                        }
                    }
                });
            } catch (e) { }
        }
        takeSnapshot();
        setTimeout(takeSnapshot, 3000);
        setInterval(findAndKeepTimers, 3000);
    }

    // ============================================================
    // 十三、iframe 处理
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
    // 十四、ESNAI 播放器钩子（ckplayer）
    // ============================================================
    function hookESNAIPlayer() {
        function find() {
            ['player', 'videoPlayer', 'studyPlayer', 'coursePlayer', 'flashPlayer',
                'mediaPlayer', 'polyvPlayer', 'ckPlayer', 'ckplayer'].forEach(function (name) {
                    if (window[name] && typeof window[name] === 'object') {
                        log('检测到播放器:', name);
                        if (window[name].pause) {
                            var orig = window[name].pause.bind(window[name]);
                            window[name].pause = function () { if (STATE.forcePlayEnabled) return; return orig(); };
                        }
                        if (window[name].play) {
                            setInterval(function () { try { if (STATE.forcePlayEnabled) window[name].play(); } catch (e) { } }, 5000);
                        }
                        if (window[name].video) {
                            try { window[name].video.muted = true; window[name].video.play().catch(function () { }); } catch (e) { }
                        }
                    }
                });
        }
        [1000, 3000, 5000, 10000].forEach(function (t) { setTimeout(find, t); });
    }

    // ============================================================
    // 十五、Web Worker 计时
    // ============================================================
    function startWorkerTimer() {
        try {
            var code = 'let s=Date.now();setInterval(function(){postMessage({e:Math.floor((Date.now()-s)/1000)})},1000);';
            var worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
            worker.onmessage = function (e) { STATE.localElapsed = e.data.e; };
        } catch (e) { }
    }

    // ============================================================
    // 十六、页面卸载拦截
    // ============================================================
    function hookPageUnload() {
        window.addEventListener('beforeunload', function (e) { e.stopImmediatePropagation(); }, true);
        window.addEventListener('unload', function (e) {
            saveState();
            e.stopImmediatePropagation();
        }, true);
        window.open = function () { return null; };
    }

    // ============================================================
    // 初始化
    // ============================================================
    function init() {
        log('========== ESNAI 助手 v9.0 启动 ==========');
        log('累计学习时间:', getActualSec(), '秒 (', Math.floor(getActualSec() / 60), '分钟)');
        if (savedState) {
            log('已恢复上次状态, startTime:', new Date(savedState.startTime).toLocaleString());
        }

        hookTimersWithCompensation();
        startAntiThrottlingAudio();
        hookDocumentVisibility();
        hookWindowBlur();
        hookDialogs();
        hookPageUnload();
        startWorkerTimer();

        function onDOMReady() {
            hookVideoPause();
            startVideoTimeEngine();
            autoPlayOnLoad();
            autoHandlePopups();
            simulateUserActivity();
            hookPlatformFunctions();
            keepPlatformTimerAlive();
            handleIframeVideos();
            hookESNAIPlayer();
            log('========== 所有模块初始化完成 ==========');
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDOMReady);
        else onDOMReady();
    }

    init();
})();
