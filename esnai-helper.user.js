// ==UserScript==
// @name         ESNAI继续教育视频学习助手
// @namespace    https://ce.esnai.net/
// @version      4.0.0
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
    };

    function getActualSec() {
        return Math.floor((Date.now() - STATE.startTime) / 1000);
    }

    // ============================================================
    // 一、Web Audio API 防节流 —— 最关键的一步
    // Chrome 对后台标签页的 setInterval 会节流到每分钟1次
    // 播放静音音频可以让 Chrome 认为标签页在"播放媒体"，不节流定时器
    // ============================================================
    function startAntiThrottlingAudio() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) { warn('AudioContext 不可用'); return; }

            let audioCtx = null;
            let oscillator = null;
            let gainNode = null;

            function createSilentAudio() {
                audioCtx = new AudioCtx();
                oscillator = audioCtx.createOscillator();
                gainNode = audioCtx.createGain();

                gainNode.gain.value = 0.001;
                oscillator.connect(gainNode);
                gainNode.connect(audioCtx.destination);
                oscillator.start();

                log('静音音频已启动，Chrome 后台节流已绕过');
            }

            createSilentAudio();

            // Chrome 可能会暂停 AudioContext，定期恢复
            setInterval(function () {
                try {
                    if (audioCtx && audioCtx.state === 'suspended') {
                        audioCtx.resume();
                        log('AudioContext 已恢复');
                    }
                } catch (e) { }
            }, 5000);

            // 页面交互后重新创建（某些浏览器需要用户手势）
            document.addEventListener('click', function () {
                try {
                    if (audioCtx && audioCtx.state === 'suspended') {
                        audioCtx.resume();
                    }
                } catch (e) { }
            }, { once: true });

            // 备用方案：用 <audio> 标签播放静音 wav
            try {
                const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
                const audioEl = document.createElement('audio');
                audioEl.src = silentWav;
                audioEl.loop = true;
                audioEl.volume = 0.001;
                audioEl.id = 'esnai-silent-audio';

                function tryPlaySilent() {
                    audioEl.play().then(function () {
                        log('备用静音音频已启动');
                    }).catch(function () {
                        setTimeout(tryPlaySilent, 3000);
                    });
                }

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', tryPlaySilent);
                } else {
                    setTimeout(tryPlaySilent, 1000);
                }

                document.addEventListener('click', function () {
                    if (audioEl.paused) {
                        audioEl.play().catch(function () { });
                    }
                }, { once: true });
            } catch (e) { }

        } catch (e) {
            warn('Web Audio API 防节流启动失败:', e);
        }
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
    // 五、拦截网络请求 —— 修正上报时间
    // ============================================================
    function hookNetworkRequests() {
        const TIME_FIELDS = [
            'second', 'sec', 'seconds', 'studytime', 'learnTime', 'duration',
            'elapsed', 'time', 'study_time', 'learn_time', 'play_time',
            'studyTime', 'studySecond', 'study_second', 'learnSecond',
            'learn_second', 'playSecond', 'play_second', 'watchTime',
            'watch_time', 'watchSecond', 'watch_second', 'totalTime',
            'total_time', 'cumulativeTime', 'cumulative_time', 'accumulated',
            'accumulatedTime', 'accumulated_time', 'effectiveTime',
            'effective_time', 'validTime', 'valid_time', 'realTime',
            'real_time', 'courseTime', 'course_time', 'timer',
            'timerSecond', 'countSecond', 'count_second', 'studyLength',
            'study_length', 'learnLength', 'learn_length', 'playLength',
            'play_length', 'currentPosition', 'current_position',
            'currentTime', 'current_time', 'position', 'pos',
            'viewTime', 'view_time', 'viewDuration', 'view_duration',
            'studylength', 'studylen', 'learnlength', 'learnlen',
            'playlength', 'playlen', 'studyprogress', 'learnprogress',
            'courseprogress', 'progress', 'completedtime', 'completed_time',
            'spenttime', 'spent_time', 'elapsedtime', 'elapsed_time',
            'runningtime', 'running_time', 'activetime', 'active_time',
            'onlinetime', 'online_time', 'learningtime', 'learning_time',
        ];

        function isTimeField(key) {
            const k = key.toLowerCase();
            return TIME_FIELDS.some(function (f) { return k === f.toLowerCase() || k.indexOf(f.toLowerCase()) !== -1; });
        }

        function isStudyRelatedRequest(url) {
            if (!url || typeof url !== 'string') return false;
            const u = url.toLowerCase();
            return u.indexOf('studytime') !== -1 || u.indexOf('reporttime') !== -1 ||
                u.indexOf('savestudy') !== -1 || u.indexOf('updatetime') !== -1 ||
                u.indexOf('studyrecord') !== -1 || u.indexOf('learnrecord') !== -1 ||
                u.indexOf('heartbeat') !== -1 || u.indexOf('keeplive') !== -1 ||
                u.indexOf('keepalive') !== -1 || u.indexOf('report') !== -1 ||
                u.indexOf('study') !== -1 || u.indexOf('learn') !== -1 ||
                u.indexOf('course') !== -1 || u.indexOf('timer') !== -1 ||
                u.indexOf('play') !== -1 || u.indexOf('watch') !== -1 ||
                u.indexOf('progress') !== -1 || u.indexOf('submit') !== -1 ||
                u.indexOf('save') !== -1 || u.indexOf('update') !== -1 ||
                u.indexOf('record') !== -1;
        }

        function isCheckCourseRequest(url) {
            if (!url || typeof url !== 'string') return false;
            const u = url.toLowerCase();
            return u.indexOf('checkcourse') !== -1 || u.indexOf('simultaneous') !== -1 ||
                u.indexOf('multiplay') !== -1 || u.indexOf('checkplay') !== -1;
        }

        function modifyTimeValue(obj, actualSec) {
            if (typeof obj === 'number' && obj < actualSec) return actualSec;
            if (typeof obj === 'string') {
                const num = parseInt(obj, 10);
                if (!isNaN(num) && num < actualSec && num >= 0) return String(actualSec);
            }
            return undefined;
        }

        function walkAndModify(obj, actualSec) {
            if (typeof obj !== 'object' || obj === null) return false;
            let changed = false;
            for (const key in obj) {
                if (typeof obj[key] === 'number' || typeof obj[key] === 'string') {
                    if (isTimeField(key)) {
                        const newVal = modifyTimeValue(obj[key], actualSec);
                        if (newVal !== undefined) {
                            log('修正字段:', key, obj[key], '->', newVal);
                            obj[key] = newVal;
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

            // FormData
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                let changed = false;
                const entries = [];
                for (const [key, value] of body.entries()) {
                    if (isTimeField(key)) {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num < actualSec) {
                            entries.push([key, String(actualSec)]);
                            log('FormData 修正:', key, value, '->', actualSec);
                            changed = true;
                            continue;
                        }
                    }
                    entries.push([key, value]);
                }
                if (changed) {
                    const fd = new FormData();
                    entries.forEach(function ([k, v]) { fd.append(k, v); });
                    return { modified: fd, changed: true };
                }
                return { modified: body, changed: false };
            }

            // URLSearchParams
            if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                let changed = false;
                for (const [key, value] of body.entries()) {
                    if (isTimeField(key)) {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num < actualSec) {
                            body.set(key, String(actualSec));
                            log('URLSearchParams 修正:', key, value, '->', actualSec);
                            changed = true;
                        }
                    }
                }
                return { modified: body, changed: changed };
            }

            // String body
            if (typeof body === 'string') {
                // Try JSON
                try {
                    const json = JSON.parse(body);
                    if (walkAndModify(json, actualSec)) {
                        return { modified: JSON.stringify(json), changed: true };
                    }
                } catch (e) { }

                // Try URL-encoded
                try {
                    const params = new URLSearchParams(body);
                    let changed = false;
                    for (const [key, value] of params.entries()) {
                        if (isTimeField(key)) {
                            const num = parseInt(value, 10);
                            if (!isNaN(num) && num < actualSec) {
                                params.set(key, String(actualSec));
                                log('URL-encoded 修正:', key, value, '->', actualSec);
                                changed = true;
                            }
                        }
                    }
                    if (changed) return { modified: params.toString(), changed: true };
                } catch (e) { }

                // Regex fallback
                let modified = body;
                let changed = false;
                const patterns = [
                    /([\"']?(?:second|sec|seconds|studytime|learnTime|duration|elapsed|time|studyTime|studySecond|watchTime|courseTime|totalTime|timer|timerSecond|countSecond)[\"']?\s*[=:]\s*)\d+/gi,
                    /([\"']?(?:study_time|learn_time|play_time|study_second|learn_second|play_second|watch_time|course_time|total_time|count_second)[\"']?\s*[=:]\s*)\d+/gi,
                ];
                patterns.forEach(function (pat) {
                    modified = modified.replace(pat, function (match, prefix) {
                        changed = true;
                        return prefix + actualSec;
                    });
                });
                if (changed) return { modified: modified, changed: true };

                // 如果都没匹配到，记录原始内容以便排查
                log('未匹配到时间字段，原始body:', body.substring(0, 500));
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

            if (isCheckCourseRequest(url)) {
                log('双课程检测已阻断:', url);
                try {
                    Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
                    Object.defineProperty(this, 'status', { value: 200, configurable: true });
                    Object.defineProperty(this, 'responseText', { value: '{"code":0,"msg":"ok","data":{}}', configurable: true });
                    this.onreadystatechange && this.onreadystatechange();
                    this.onload && this.onload();
                } catch (e) { }
                return;
            }

            if (isStudyRelatedRequest(url)) {
                const actualSec = getActualSec();
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
    }

    // ============================================================
    // 六、视频防暂停 + 自动播放
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
                        try {
                            pauseBlocked = true;
                            video.play().catch(function () { });
                            pauseBlocked = false;
                        } catch (err) { pauseBlocked = false; }
                    }, 50);
                }
            }, true);

            ['waiting', 'stalled', 'suspend'].forEach(function (evt) {
                video.addEventListener(evt, function (e) {
                    if (STATE.forcePlayEnabled) e.stopImmediatePropagation();
                }, true);
            });

            // 确保视频持续播放
            setInterval(function () {
                if (STATE.forcePlayEnabled && video.paused && !video.ended) {
                    video.play().catch(function () { });
                }
            }, 2000);

            // 防止 playbackRate=0
            try {
                const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
                if (desc && desc.set) {
                    Object.defineProperty(video, 'playbackRate', {
                        get: desc.get,
                        set: function (val) {
                            if (val === 0 && STATE.forcePlayEnabled) return;
                            return desc.set.call(this, val);
                        },
                        configurable: true
                    });
                }
            } catch (e) { }

            // 静音播放（避免后台播放被阻止）
            video.muted = true;
            video.volume = 0;

            // 自动播放
            video.autoplay = true;
            video.play().catch(function () {
                // 自动播放被阻止，等待用户交互
                document.addEventListener('click', function () {
                    video.play().catch(function () { });
                }, { once: true });
            });

            log('视频防暂停保护已激活');
        }

        function observeVideos() {
            document.querySelectorAll('video').forEach(protectVideo);
            const observer = new MutationObserver(function (mutations) {
                mutations.forEach(function (mutation) {
                    mutation.addedNodes.forEach(function (node) {
                        if (node.nodeName === 'VIDEO') protectVideo(node);
                        if (node.querySelectorAll) node.querySelectorAll('video').forEach(protectVideo);
                    });
                });
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', observeVideos);
        } else {
            observeVideos();
        }
    }

    // ============================================================
    // 七、页面加载后自动播放
    // ============================================================
    function autoPlayOnLoad() {
        function tryAutoPlay() {
            log('尝试自动播放...');

            // 查找视频并播放
            const videos = document.querySelectorAll('video');
            videos.forEach(function (video) {
                if (video.paused && !video.ended) {
                    video.muted = true;
                    video.volume = 0;
                    video.autoplay = true;
                    video.play().catch(function () { });
                    log('视频自动播放已触发');
                }
            });

            // 查找并点击播放按钮
            const playBtnSelectors = [
                '.play-btn', '.btn-play', '#playBtn', '#play',
                '.vjs-big-play-button', '.video-play-btn',
                'button[title="Play"]', 'button[title="播放"]',
                '.prism-big-play-btn', '.xgplayer-start',
                '[class*="play"]', '[class*="Play"]',
            ];

            playBtnSelectors.forEach(function (sel) {
                const btn = document.querySelector(sel);
                if (btn && btn.offsetParent !== null) {
                    btn.click();
                    log('点击了播放按钮:', sel);
                }
            });

            // 查找 iframe 中的视频
            document.querySelectorAll('iframe').forEach(function (iframe) {
                try {
                    if (iframe.contentDocument) {
                        const iframeVideos = iframe.contentDocument.querySelectorAll('video');
                        iframeVideos.forEach(function (v) {
                            v.muted = true;
                            v.play().catch(function () { });
                        });
                    }
                } catch (e) { }
            });
        }

        // 多次尝试，等待视频加载
        setTimeout(tryAutoPlay, 1000);
        setTimeout(tryAutoPlay, 3000);
        setTimeout(tryAutoPlay, 5000);
        setTimeout(tryAutoPlay, 10000);
        setTimeout(tryAutoPlay, 15000);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () {
                setTimeout(tryAutoPlay, 500);
            });
        }

        log('自动播放模块已激活');
    }

    // ============================================================
    // 八、弹窗弹题自动处理
    // ============================================================
    function autoHandlePopups() {
        function handleQuizAndPopups() {
            const quizContainers = [
                '.quiz-popup', '.popup-question', '.question-popup',
                '.modal-quiz', '.exam-popup', '.dialog-quiz',
                '.interact-popup', '.exam-interact', '.study-interact',
            ];

            quizContainers.forEach(function (sel) {
                document.querySelectorAll(sel).forEach(function (container) {
                    if (container.style.display === 'none' || container.offsetParent === null) return;
                    if (container._autoHandled) return;
                    container._autoHandled = true;

                    log('检测到弹题:', sel);

                    const optSels = ['.answer-option', '.option-item', 'input[type="radio"]',
                        'input[type="checkbox"]', '.choice-item', '.quiz-option', 'li'];
                    for (let i = 0; i < optSels.length; i++) {
                        const opts = container.querySelectorAll(optSels[i]);
                        if (opts.length > 0) { opts[0].click(); break; }
                    }

                    setTimeout(function () {
                        ['.submit-btn', '.btn-confirm', 'button[type="submit"]', '.btn-submit'].forEach(function (s) {
                            const btn = container.querySelector(s);
                            if (btn) btn.click();
                        });
                    }, 300);
                });
            });

            // 全局确认按钮
            ['.layui-layer-btn0', '.aui_ok', '.bootbox .btn-primary', '.sweet-alert .confirm',
                '.layui-layer-close1', '.ui-dialog .ui-dialog-titlebar-close'].forEach(function (sel) {
                    document.querySelectorAll(sel).forEach(function (btn) {
                        if (btn.offsetParent !== null && !btn._ac) {
                            btn._ac = true;
                            btn.click();
                            setTimeout(function () { btn._ac = false; }, 3000);
                        }
                    });
                });

            // 文字匹配的确认按钮
            document.querySelectorAll('button, a, input[type="button"], input[type="submit"]').forEach(function (btn) {
                const text = (btn.textContent || btn.value || '').trim();
                if (['继续学习', '继续', '确定', '确认', '知道了', '好的', 'OK', 'Yes', '是'].indexOf(text) !== -1) {
                    if (btn.offsetParent !== null && !btn._ac) {
                        btn._ac = true;
                        btn.click();
                        setTimeout(function () { btn._ac = false; }, 5000);
                    }
                }
            });
        }

        setInterval(handleQuizAndPopups, 2000);

        const observer = new MutationObserver(function (mutations) {
            let check = false;
            mutations.forEach(function (m) { if (m.addedNodes.length > 0 || m.type === 'attributes') check = true; });
            if (check) handleQuizAndPopups();
        });

        function startObs() {
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'display'] });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startObs);
        } else {
            startObs();
        }
    }

    // ============================================================
    // 九、模拟用户活动
    // ============================================================
    function simulateUserActivity() {
        function scheduleMouseMove() {
            const delay = 3000 + Math.random() * 5000;
            setTimeout(function () {
                if (STATE.simulateActivityEnabled) {
                    const x = Math.random() * window.innerWidth;
                    const y = Math.random() * window.innerHeight;
                    const evt = new MouseEvent('mousemove', {
                        bubbles: true, cancelable: true, view: window,
                        clientX: x, clientY: y, screenX: x, screenY: y,
                        movementX: Math.random() * 10 - 5, movementY: Math.random() * 10 - 5
                    });
                    document.elementFromPoint(x, y)?.dispatchEvent(evt);
                }
                scheduleMouseMove();
            }, delay);
        }
        scheduleMouseMove();

        setInterval(function () {
            if (!STATE.simulateActivityEnabled) return;
            document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ', code: 'Space' }));
        }, 60000);

        // 刷新平台的无操作检测变量
        const idleVars = ['lastActiveTime', 'lastActivityTime', 'lastOperateTime',
            'lastActionTime', 'lastMouseMoveTime', 'lastUserActionTime',
            'lastStudyTime', 'lastPlayTime', 'lastHeartbeatTime',
            'studyActiveTime', 'playActiveTime'];

        setInterval(function () {
            idleVars.forEach(function (v) { if (window[v] !== undefined) window[v] = Date.now(); });
            if (window.$ && window.$.fn) {
                try {
                    const $doc = $(document);
                    idleVars.forEach(function (v) { if ($doc.data(v) !== undefined) $doc.data(v, Date.now()); });
                } catch (e) { }
            }
        }, 5000);
    }

    // ============================================================
    // 十、本地计时器 + 同步视频进度
    // ============================================================
    function startLocalTimer() {
        setInterval(function () {
            STATE.localElapsed = Math.floor((Date.now() - STATE.startTime) / 1000);

            const video = document.querySelector('video');
            if (video && STATE.forcePlayEnabled) {
                const videoTime = Math.floor(video.currentTime);
                const expectedTime = STATE.localElapsed;
                if (expectedTime - videoTime > 10 && expectedTime < video.duration) {
                    log('修正视频进度:', videoTime, '->', expectedTime);
                    video.currentTime = expectedTime;
                }
            }
        }, 5000);
    }

    // ============================================================
    // 十一、拦截定时器 —— 阻止平台停止计时
    // ============================================================
    function hookTimers() {
        const STOP_KEYWORDS = ['stopTimer', 'stopStudy', 'pauseTimer', 'pauseStudy',
            'clearTimer', 'endStudy', 'stopCount', 'pauseCount', 'stopPlay', 'pausePlay'];

        const origSetInterval = window.setInterval;
        const origSetTimeout = window.setTimeout;

        window.setInterval = function (fn, delay) {
            const fnStr = fn ? fn.toString() : '';
            for (let i = 0; i < STOP_KEYWORDS.length; i++) {
                if (fnStr.indexOf(STOP_KEYWORDS[i]) !== -1) {
                    log('拦截停止计时定时器:', STOP_KEYWORDS[i]);
                    return origSetInterval.call(window, function () { }, delay);
                }
            }
            return origSetInterval.apply(this, arguments);
        };

        window.setTimeout = function (fn, delay) {
            const fnStr = fn ? fn.toString() : '';
            for (let i = 0; i < STOP_KEYWORDS.length; i++) {
                if (fnStr.indexOf(STOP_KEYWORDS[i]) !== -1) {
                    log('拦截停止计时延时器:', STOP_KEYWORDS[i]);
                    return origSetTimeout.call(window, function () { }, delay);
                }
            }
            return origSetTimeout.apply(this, arguments);
        };
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
        function waitForWindow() {
            ['stopTimer', 'stopStudy', 'stopCount', 'stopPlay',
                'pauseTimer', 'pauseStudy', 'pauseCount', 'pausePlay',
                'endTimer', 'endStudy', 'endCount', 'endPlay',
                'clearTimer', 'clearStudy', 'clearCount',
                'suspendTimer', 'suspendStudy', 'suspendPlay',
                'freezeTimer', 'freezeStudy', 'haltStudy', 'haltTimer'].forEach(function (fn) {
                    if (typeof window[fn] === 'function') {
                        window[fn] = function () { log('平台函数已拦截:', fn); };
                    }
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

        setTimeout(waitForWindow, 1000);
        setTimeout(waitForWindow, 3000);
        setTimeout(waitForWindow, 5000);
        setTimeout(waitForWindow, 10000);
    }

    // ============================================================
    // 十四、保持平台内部计时变量
    // ============================================================
    function keepPlatformTimerAlive() {
        function findAndKeepTimers() {
            const actualSec = getActualSec();

            // 已知变量名
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

            // 搜索 window 上的疑似计时变量
            try {
                for (const key in window) {
                    try {
                        if (typeof window[key] === 'number' && window[key] > 0 && window[key] < actualSec) {
                            const k = key.toLowerCase();
                            if ((k.indexOf('time') !== -1 || k.indexOf('sec') !== -1 ||
                                k.indexOf('dur') !== -1 || k.indexOf('count') !== -1 ||
                                k.indexOf('timer') !== -1 || k.indexOf('elapsed') !== -1 ||
                                k.indexOf('study') !== -1 || k.indexOf('learn') !== -1 ||
                                k.indexOf('play') !== -1 || k.indexOf('watch') !== -1)) {
                                log('发现计时变量:', key, '=', window[key], '->', actualSec);
                                window[key] = actualSec;
                            }
                        }
                    } catch (e) { }
                }
            } catch (e) { }

            // Vue 实例
            try {
                document.querySelectorAll('[__vue__]').forEach(function (el) {
                    const vm = el.__vue__;
                    if (vm && vm.$data) {
                        for (const key in vm.$data) {
                            if (typeof vm.$data[key] === 'number' && vm.$data[key] < actualSec && vm.$data[key] > 0) {
                                const k = key.toLowerCase();
                                if (k.indexOf('time') !== -1 || k.indexOf('sec') !== -1 ||
                                    k.indexOf('dur') !== -1 || k.indexOf('study') !== -1) {
                                    log('Vue计时变量:', key, '=', vm.$data[key], '->', actualSec);
                                    vm.$data[key] = actualSec;
                                }
                            }
                        }
                    }
                });
            } catch (e) { }
        }

        setInterval(findAndKeepTimers, 5000);
    }

    // ============================================================
    // 十五、iframe 处理
    // ============================================================
    function handleIframeVideos() {
        function processIframes() {
            document.querySelectorAll('iframe').forEach(function (iframe) {
                try {
                    if (!iframe.contentDocument) return;
                    iframe.contentDocument.querySelectorAll('video').forEach(function (video) {
                        if (video._hooked) return;
                        video._hooked = true;
                        video.addEventListener('pause', function () {
                            setTimeout(function () { video.play().catch(function () { }); }, 50);
                        });
                        setInterval(function () {
                            if (video.paused && !video.ended) video.play().catch(function () { });
                        }, 3000);
                    });
                    iframe.contentWindow.alert = function () { };
                    iframe.contentWindow.confirm = function () { return true; };
                    iframe.contentWindow.prompt = function () { return ''; };
                } catch (e) { }
            });
        }
        setInterval(processIframes, 5000);
    }

    // ============================================================
    // 十六、ESNAI 播放器钩子
    // ============================================================
    function hookESNAIPlayer() {
        function findAndHookPlayer() {
            ['player', 'videoPlayer', 'studyPlayer', 'coursePlayer', 'flashPlayer',
                'mediaPlayer', 'polyvPlayer', 'ckPlayer', 'ckplayer'].forEach(function (name) {
                    if (window[name] && typeof window[name] === 'object') {
                        log('检测到播放器:', name);
                        if (window[name].pause) {
                            const orig = window[name].pause.bind(window[name]);
                            window[name].pause = function () {
                                if (STATE.forcePlayEnabled) return;
                                return orig();
                            };
                        }
                        if (window[name].play) {
                            setInterval(function () {
                                try { if (STATE.forcePlayEnabled) window[name].play(); } catch (e) { }
                            }, 5000);
                        }
                    }
                });

            document.querySelectorAll('embed, object').forEach(function (embed) {
                try {
                    if (embed.play) setInterval(function () { try { embed.play(); } catch (e) { } }, 5000);
                } catch (e) { }
            });
        }

        setTimeout(findAndHookPlayer, 1000);
        setTimeout(findAndHookPlayer, 3000);
        setTimeout(findAndHookPlayer, 5000);
        setTimeout(findAndHookPlayer, 10000);
    }

    // ============================================================
    // 十七、Web Worker 计时
    // ============================================================
    function startWorkerTimer() {
        try {
            const code = 'let s=Date.now();setInterval(function(){postMessage({e:Math.floor((Date.now()-s)/1000)})},1000);';
            const blob = new Blob([code], { type: 'application/javascript' });
            const worker = new Worker(URL.createObjectURL(blob));
            worker.onmessage = function (e) { STATE.localElapsed = e.data.e; };
        } catch (e) { warn('Web Worker 启动失败:', e); }
    }

    // ============================================================
    // 十八、主动上报计时
    // ============================================================
    function startProactiveReporting() {
        let discoveredAPI = null;

        // 监听 XHR 来发现上报 API
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            if (url && typeof url === 'string') {
                const u = url.toLowerCase();
                if (u.indexOf('study') !== -1 || u.indexOf('learn') !== -1 ||
                    u.indexOf('report') !== -1 || u.indexOf('record') !== -1 ||
                    u.indexOf('save') !== -1 || u.indexOf('update') !== -1 ||
                    u.indexOf('heartbeat') !== -1 || u.indexOf('timer') !== -1) {
                    discoveredAPI = url;
                }
            }
            return origOpen.apply(this, arguments);
        };

        setInterval(function () {
            const actualSec = getActualSec();
            if (actualSec - STATE.lastReportedSec < 30) return;

            // 方式1：全局函数
            const fns = ['saveStudyTime', 'reportStudyTime', 'updateStudyRecord',
                'saveStudyRecord', 'reportRecord', 'updateTime', 'studyReport',
                'learnReport', 'courseReport', 'submitStudyTime', 'reportProgress',
                'saveProgress', 'updateProgress', 'studyHeartbeat', 'learnHeartbeat'];

            for (const fn of fns) {
                if (typeof window[fn] === 'function') {
                    try {
                        window[fn](actualSec);
                        STATE.lastReportedSec = actualSec;
                        log('主动上报成功(全局函数):', fn, actualSec);
                        return;
                    } catch (e) { }
                }
            }

            // 方式2：GM_xmlhttpRequest
            if (discoveredAPI && typeof GM_xmlhttpRequest !== 'undefined') {
                try {
                    const url = discoveredAPI.startsWith('http') ? discoveredAPI : window.location.origin + discoveredAPI;
                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: url,
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({ studyTime: actualSec, second: actualSec, duration: actualSec, time: actualSec }),
                        onload: function () {
                            STATE.lastReportedSec = actualSec;
                            log('主动上报成功(GM):', actualSec);
                        },
                        onerror: function () { }
                    });
                    return;
                } catch (e) { }
            }

            // 方式3：视频 seek 触发
            try {
                const video = document.querySelector('video');
                if (video && !video.paused) {
                    const t = video.currentTime;
                    video.currentTime = Math.max(0, t - 1);
                    setTimeout(function () { video.currentTime = t; }, 100);
                }
            } catch (e) { }
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
        log('========== ESNAI 助手 v4.0 启动 ==========');

        // 最早执行：防节流 + 可见性欺骗
        startAntiThrottlingAudio();
        hookDocumentVisibility();
        hookWindowBlur();
        hookDialogs();
        hookNetworkRequests();
        hookTimers();
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

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onDOMReady);
        } else {
            onDOMReady();
        }
    }

    init();
})();
