// ==UserScript==
// @name         ESNAI继续教育视频学习助手
// @namespace    https://ce.esnai.net/
// @version      3.0.0
// @description  确保视频学习时间正常累计，防止计时中断、弹题打断、暂停检测等
// @author       GLM
// @match        *://ce.esnai.net/*
// @match        *://*.esnai.net/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_log
// @run-at       document-start
// @noframes     false
// @connect      ce.esnai.net
// @connect      *.esnai.net
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_PREFIX = '[ESNAI助手]';
    const LOG_ENABLED = true;

    function log(...args) {
        if (LOG_ENABLED) console.log(SCRIPT_PREFIX, ...args);
    }

    function warn(...args) {
        if (LOG_ENABLED) console.warn(SCRIPT_PREFIX, ...args);
    }

    // ============================================================
    // 一、全局状态
    // ============================================================
    const STATE = {
        startTime: Date.now(),
        localElapsed: 0,
        lastReportedSec: 0,
        lastReportedTime: 0,
        videoPlaying: false,
        videoElement: null,
        lastMouseMoveTime: Date.now(),
        heartbeatInterval: 30000,
        reportInterval: 30000,
        quizAutoAnswerEnabled: true,
        forcePlayEnabled: true,
        simulateActivityEnabled: true,
        antiDetectionEnabled: true,
        discoveredAPI: null,
        discoveredHeaders: null,
        discoveredMethod: null,
        networkLog: [],
        quizCount: 0,
        reportCount: 0,
        lastNetActivity: 0,
    };

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
    ];

    function getActualSec() {
        return Math.floor((Date.now() - STATE.startTime) / 1000);
    }

    function addNetworkLog(type, url, detail) {
        const entry = {
            time: new Date().toLocaleTimeString(),
            type: type,
            url: typeof url === 'string' ? url.substring(0, 120) : String(url).substring(0, 120),
            detail: detail || ''
        };
        STATE.networkLog.push(entry);
        if (STATE.networkLog.length > 50) STATE.networkLog.shift();
        STATE.lastNetActivity = Date.now();
    }

    // ============================================================
    // 二、页面可见性欺骗
    // ============================================================
    function hookDocumentVisibility() {
        try {
            Object.defineProperty(document, 'hidden', {
                get: () => false,
                configurable: true
            });
            Object.defineProperty(document, 'visibilityState', {
                get: () => 'visible',
                configurable: true
            });
        } catch (e) {
            warn('hookDocumentVisibility failed:', e);
        }

        document.addEventListener('visibilitychange', function (e) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }, true);

        window.addEventListener('visibilitychange', function (e) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }, true);

        document.addEventListener('webkitvisibilitychange', function (e) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }, true);

        log('页面可见性欺骗已激活');
    }

    // ============================================================
    // 三、屏蔽 window.blur / focusout 事件
    // ============================================================
    function hookWindowBlur() {
        const blurEvents = ['blur', 'focusout', 'pagehide'];
        blurEvents.forEach(function (evtName) {
            window.addEventListener(evtName, function (e) {
                e.stopImmediatePropagation();
                e.preventDefault();
            }, true);
            document.addEventListener(evtName, function (e) {
                e.stopImmediatePropagation();
                e.preventDefault();
            }, true);
        });

        try {
            Object.defineProperty(document, 'hasFocus', {
                value: function () { return true; },
                writable: false,
                configurable: true
            });
        } catch (e) {
            warn('hook hasFocus failed:', e);
        }

        log('窗口焦点欺骗已激活');
    }

    // ============================================================
    // 四、屏蔽 alert / confirm / prompt
    // ============================================================
    function hookDialogs() {
        window.alert = function () { log('alert 被拦截'); };
        window.confirm = function () {
            log('confirm 被拦截，返回 true');
            return true;
        };
        window.prompt = function () {
            log('prompt 被拦截，返回空');
            return '';
        };

        window.close = function () {
            log('window.close 被拦截');
        };

        window.addEventListener('beforeunload', function (e) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }, true);

        log('弹窗拦截已激活');
    }

    // ============================================================
    // 五、拦截 XMLHttpRequest / fetch —— 修正上报时间（增强版）
    // ============================================================
    function hookNetworkRequests() {
        const OriginalXHR = window.XMLHttpRequest;
        const xhrOpen = OriginalXHR.prototype.open;
        const xhrSend = OriginalXHR.prototype.send;
        const xhrSetHeader = OriginalXHR.prototype.setRequestHeader;

        OriginalXHR.prototype.open = function (method, url) {
            this._hookUrl = url;
            this._hookMethod = method;
            this._hookHeaders = {};
            return xhrOpen.apply(this, arguments);
        };

        OriginalXHR.prototype.setRequestHeader = function (name, value) {
            if (this._hookHeaders) {
                this._hookHeaders[name] = value;
            }
            return xhrSetHeader.apply(this, arguments);
        };

        function isStudyRelatedRequest(url) {
            if (!url || typeof url !== 'string') return false;
            const u = url.toLowerCase();
            return u.indexOf('studytime') !== -1 ||
                u.indexOf('reporttime') !== -1 ||
                u.indexOf('savestudy') !== -1 ||
                u.indexOf('updatetime') !== -1 ||
                u.indexOf('studyrecord') !== -1 ||
                u.indexOf('learnrecord') !== -1 ||
                u.indexOf('heartbeat') !== -1 ||
                u.indexOf('keeplive') !== -1 ||
                u.indexOf('keepalive') !== -1 ||
                u.indexOf('report') !== -1 ||
                u.indexOf('study') !== -1 ||
                u.indexOf('learn') !== -1 ||
                u.indexOf('course') !== -1 ||
                u.indexOf('timer') !== -1 ||
                u.indexOf('play') !== -1 ||
                u.indexOf('watch') !== -1 ||
                u.indexOf('progress') !== -1 ||
                u.indexOf('submit') !== -1 ||
                u.indexOf('save') !== -1 ||
                u.indexOf('update') !== -1 ||
                u.indexOf('record') !== -1;
        }

        function isCheckCourseRequest(url) {
            if (!url || typeof url !== 'string') return false;
            return url.toLowerCase().indexOf('checkcourse') !== -1 ||
                url.toLowerCase().indexOf('checkcourse') !== -1 ||
                url.toLowerCase().indexOf('simultaneous') !== -1 ||
                url.toLowerCase().indexOf('multiplay') !== -1;
        }

        function modifyTimeInString(str) {
            const actualSec = getActualSec();
            let modified = str;
            let changed = false;

            try {
                const json = JSON.parse(str);
                let jsonChanged = false;

                function walkAndModify(obj) {
                    if (typeof obj === 'object' && obj !== null) {
                        for (const key in obj) {
                            if (typeof obj[key] === 'number' && isTimeField(key)) {
                                if (obj[key] < actualSec || obj[key] === 0) {
                                    log('JSON 修正字段:', key, obj[key], '->', actualSec);
                                    obj[key] = actualSec;
                                    jsonChanged = true;
                                }
                            } else if (typeof obj[key] === 'string') {
                                const num = parseInt(obj[key], 10);
                                if (!isNaN(num) && isTimeField(key) && (num < actualSec || num === 0)) {
                                    log('JSON 修正字段(字符串):', key, obj[key], '->', String(actualSec));
                                    obj[key] = String(actualSec);
                                    jsonChanged = true;
                                }
                            } else if (typeof obj[key] === 'object') {
                                walkAndModify(obj[key]);
                            }
                        }
                    }
                }

                walkAndModify(json);
                if (jsonChanged) {
                    modified = JSON.stringify(json);
                    changed = true;
                }
            } catch (e) {
                // Not JSON, try URL-encoded
                try {
                    const params = new URLSearchParams(str);
                    let paramChanged = false;
                    for (const [key, value] of params) {
                        if (isTimeField(key)) {
                            const num = parseInt(value, 10);
                            if (!isNaN(num) && (num < actualSec || num === 0)) {
                                log('URL-encoded 修正字段:', key, value, '->', actualSec);
                                params.set(key, String(actualSec));
                                paramChanged = true;
                            }
                        }
                    }
                    if (paramChanged) {
                        modified = params.toString();
                        changed = true;
                    }
                } catch (e2) {
                    // Not URL-encoded, try regex
                    const secPatterns = [
                        /([\"']?(?:second|sec|seconds|studytime|learnTime|duration|elapsed)[\"']?\s*[=:]\s*)\d+/gi,
                        /([\"']?(?:study_time|learn_time|play_time|studyTime|studySecond)[\"']?\s*[=:]\s*)\d+/gi,
                        /([\"']?(?:watchTime|watch_time|courseTime|course_time|totalTime|total_time)[\"']?\s*[=:]\s*)\d+/gi,
                        /([\"']?(?:timer|timerSecond|countSecond|count_second)[\"']?\s*[=:]\s*)\d+/gi,
                    ];
                    secPatterns.forEach(function (pat) {
                        modified = modified.replace(pat, function (match, prefix) {
                            log('正则修正:', match, '->', prefix + actualSec);
                            changed = true;
                            return prefix + actualSec;
                        });
                    });
                }
            }

            return { modified: modified, changed: changed, actualSec: actualSec };
        }

        function isTimeField(key) {
            const k = key.toLowerCase();
            return TIME_FIELDS.some(function (f) {
                return k === f.toLowerCase() || k.indexOf(f.toLowerCase()) !== -1;
            });
        }

        OriginalXHR.prototype.send = function (body) {
            const url = this._hookUrl;

            if (isCheckCourseRequest(url)) {
                log('双课程检测请求被阻断:', url);
                addNetworkLog('BLOCK', url, '双课程检测');
                Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
                Object.defineProperty(this, 'status', { value: 200, configurable: true });
                Object.defineProperty(this, 'responseText', { value: '{"code":0,"msg":"ok","data":{}}', configurable: true });
                this.onreadystatechange && this.onreadystatechange();
                this.onload && this.onload();
                return;
            }

            if (isStudyRelatedRequest(url)) {
                log('拦截到学习相关请求:', url);
                addNetworkLog('HOOK', url, '学习相关');

                if (this._hookHeaders) {
                    STATE.discoveredHeaders = Object.assign({}, this._hookHeaders);
                }
                STATE.discoveredMethod = this._hookMethod || 'POST';

                let discovered = false;
                if (body) {
                    if (typeof body === 'string') {
                        const result = modifyTimeInString(body);
                        if (result.changed) {
                            arguments[0] = result.modified;
                            STATE.lastReportedSec = result.actualSec;
                            STATE.lastReportedTime = Date.now();
                            STATE.reportCount++;
                            discovered = true;
                            addNetworkLog('MODIFY', url, '秒数修正为 ' + result.actualSec);
                        }
                    } else if (body instanceof FormData) {
                        const actualSec = getActualSec();
                        let fdChanged = false;
                        for (const [key, value] of body.entries()) {
                            if (isTimeField(key)) {
                                const num = parseInt(value, 10);
                                if (!isNaN(num) && (num < actualSec || num === 0)) {
                                    log('FormData 修正字段:', key, value, '->', actualSec);
                                    body.set(key, String(actualSec));
                                    fdChanged = true;
                                }
                            }
                        }
                        if (fdChanged) {
                            arguments[0] = body;
                            STATE.lastReportedSec = actualSec;
                            STATE.lastReportedTime = Date.now();
                            STATE.reportCount++;
                            discovered = true;
                            addNetworkLog('MODIFY', url, 'FormData 秒数修正为 ' + actualSec);
                        }
                    } else if (body instanceof URLSearchParams) {
                        const actualSec = getActualSec();
                        let spChanged = false;
                        for (const [key, value] of body.entries()) {
                            if (isTimeField(key)) {
                                const num = parseInt(value, 10);
                                if (!isNaN(num) && (num < actualSec || num === 0)) {
                                    log('URLSearchParams 修正字段:', key, value, '->', actualSec);
                                    body.set(key, String(actualSec));
                                    spChanged = true;
                                }
                            }
                        }
                        if (spChanged) {
                            arguments[0] = body;
                            STATE.lastReportedSec = actualSec;
                            STATE.lastReportedTime = Date.now();
                            STATE.reportCount++;
                            discovered = true;
                            addNetworkLog('MODIFY', url, 'URLSearchParams 秒数修正为 ' + actualSec);
                        }
                    }
                }

                if (!discovered && body) {
                    const bodyPreview = typeof body === 'string' ? body.substring(0, 500) : (body.toString ? body.toString().substring(0, 500) : '');
                    log('请求体未匹配到时间字段，原始内容:', bodyPreview);
                    addNetworkLog('MISS', url, '未匹配时间字段: ' + bodyPreview.substring(0, 80));
                    STATE.discoveredAPI = url;
                } else if (!body) {
                    STATE.discoveredAPI = url;
                    addNetworkLog('NOBODY', url, '无请求体');
                }

                if (!discovered) {
                    STATE.discoveredAPI = url;
                }
            } else if (url && typeof url === 'string') {
                addNetworkLog('PASS', url, '');
            }

            return xhrSend.apply(this, arguments);
        };

        // 拦截 fetch
        const originalFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                const url = (typeof input === 'string') ? input :
                    (input instanceof Request) ? input.url : '';

                if (isCheckCourseRequest(url)) {
                    log('fetch 双课程检测请求被阻断:', url);
                    addNetworkLog('BLOCK', url, '双课程检测(fetch)');
                    return Promise.resolve(new Response('{"code":0,"msg":"ok","data":{}}', {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    }));
                }

                if (isStudyRelatedRequest(url)) {
                    log('拦截到 fetch 学习相关请求:', url);
                    addNetworkLog('HOOK', url, '学习相关(fetch)');

                    STATE.discoveredAPI = url;
                    if (init && init.headers) {
                        STATE.discoveredHeaders = init.headers;
                    }
                    STATE.discoveredMethod = (init && init.method) || 'GET';

                    if (init && init.body) {
                        if (typeof init.body === 'string') {
                            const result = modifyTimeInString(init.body);
                            if (result.changed) {
                                init.body = result.modified;
                                STATE.lastReportedSec = result.actualSec;
                                STATE.lastReportedTime = Date.now();
                                STATE.reportCount++;
                                addNetworkLog('MODIFY', url, 'fetch 秒数修正为 ' + result.actualSec);
                            } else {
                                log('fetch 请求体未匹配到时间字段:', init.body.substring(0, 500));
                                addNetworkLog('MISS', url, 'fetch 未匹配: ' + init.body.substring(0, 80));
                            }
                        } else if (init.body instanceof FormData) {
                            const actualSec = getActualSec();
                            let fdChanged = false;
                            for (const [key, value] of init.body.entries()) {
                                if (isTimeField(key)) {
                                    const num = parseInt(value, 10);
                                    if (!isNaN(num) && (num < actualSec || num === 0)) {
                                        log('fetch FormData 修正字段:', key, value, '->', actualSec);
                                        init.body.set(key, String(actualSec));
                                        fdChanged = true;
                                    }
                                }
                            }
                            if (fdChanged) {
                                STATE.lastReportedSec = actualSec;
                                STATE.lastReportedTime = Date.now();
                                STATE.reportCount++;
                                addNetworkLog('MODIFY', url, 'fetch FormData 秒数修正为 ' + actualSec);
                            }
                        }
                    }
                } else if (url) {
                    addNetworkLog('PASS', url, '');
                }
            } catch (e) {
                warn('fetch hook error:', e);
            }
            return originalFetch.apply(this, arguments);
        };

        log('网络请求拦截已激活（增强版）');
    }

    // ============================================================
    // 六、主动上报计时 —— 自动发现 API 并直接上报
    // ============================================================
    function startProactiveReporting() {
        function tryProactiveReport() {
            const actualSec = getActualSec();

            if (actualSec - STATE.lastReportedSec < 30) return;

            log('尝试主动上报，实际秒数:', actualSec, '上次上报:', STATE.lastReportedSec);

            // 方式1：调用平台全局函数
            const globalFunctions = [
                'saveStudyTime', 'reportStudyTime', 'updateStudyRecord',
                'saveStudyRecord', 'reportRecord', 'updateTime',
                'studyReport', 'learnReport', 'courseReport',
                'submitStudyTime', 'commitStudyTime', 'sendStudyTime',
                'reportProgress', 'saveProgress', 'updateProgress',
                'studyHeartbeat', 'learnHeartbeat',
            ];

            let called = false;
            for (const fnName of globalFunctions) {
                if (typeof window[fnName] === 'function') {
                    try {
                        log('调用全局函数:', fnName, '参数:', actualSec);
                        window[fnName](actualSec);
                        STATE.lastReportedSec = actualSec;
                        STATE.lastReportedTime = Date.now();
                        STATE.reportCount++;
                        called = true;
                        addNetworkLog('PROACTIVE', fnName, '调用全局函数 秒数=' + actualSec);
                        break;
                    } catch (e) {
                        warn('调用全局函数失败:', fnName, e);
                    }
                }
            }

            // 方式2：通过发现的 API 端点直接上报
            if (!called && STATE.discoveredAPI) {
                try {
                    const apiUrl = STATE.discoveredAPI;
                    log('通过发现的 API 主动上报:', apiUrl);

                    if (typeof GM_xmlhttpRequest !== 'undefined') {
                        const method = STATE.discoveredMethod || 'POST';
                        const body = JSON.stringify({ studyTime: actualSec, second: actualSec, duration: actualSec, time: actualSec });

                        GM_xmlhttpRequest({
                            method: method,
                            url: apiUrl.startsWith('http') ? apiUrl : window.location.origin + apiUrl,
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            data: method === 'POST' ? body : undefined,
                            onload: function (response) {
                                log('主动上报响应:', response.status, response.responseText.substring(0, 200));
                                STATE.lastReportedSec = actualSec;
                                STATE.lastReportedTime = Date.now();
                                STATE.reportCount++;
                                addNetworkLog('PROACTIVE', apiUrl, 'GM上报成功 秒数=' + actualSec);
                            },
                            onerror: function (error) {
                                warn('GM_xmlhttpRequest 上报失败:', error);
                                addNetworkLog('ERROR', apiUrl, 'GM上报失败');
                            }
                        });
                        called = true;
                    }
                } catch (e) {
                    warn('API 主动上报失败:', e);
                }
            }

            // 方式3：触发平台自身的上报逻辑
            if (!called) {
                try {
                    const video = document.querySelector('video');
                    if (video && !video.paused) {
                        const origTime = video.currentTime;
                        video.currentTime = Math.max(0, origTime - 1);
                        setTimeout(function () {
                            video.currentTime = origTime;
                        }, 100);
                        log('通过视频 seek 触发平台上报');
                        addNetworkLog('PROACTIVE', 'video-seek', '触发平台上报');
                    }
                } catch (e) { }
            }
        }

        setInterval(tryProactiveReport, STATE.reportInterval);

        log('主动上报计时已启动（增强版）');
    }

    // ============================================================
    // 七、视频防暂停
    // ============================================================
    function hookVideoPause() {
        function protectVideo(video) {
            if (video._hooked) return;
            video._hooked = true;

            const originalPause = video.pause.bind(video);
            let pauseBlocked = false;

            video.pause = function () {
                if (STATE.forcePlayEnabled && !pauseBlocked) {
                    log('video.pause() 被拦截');
                    return;
                }
                return originalPause();
            };

            video.addEventListener('pause', function (e) {
                if (STATE.forcePlayEnabled) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    log('视频被暂停，立即恢复播放');
                    setTimeout(function () {
                        try {
                            pauseBlocked = true;
                            video.play().catch(function () { });
                            pauseBlocked = false;
                        } catch (err) {
                            pauseBlocked = false;
                        }
                    }, 50);
                }
            }, true);

            ['waiting', 'stalled', 'suspend'].forEach(function (evt) {
                video.addEventListener(evt, function (e) {
                    if (STATE.forcePlayEnabled) {
                        e.stopImmediatePropagation();
                        log('视频 ' + evt + ' 事件被拦截');
                    }
                }, true);
            });

            setInterval(function () {
                if (STATE.forcePlayEnabled && video.paused && !video.ended) {
                    log('检测到视频暂停，强制恢复');
                    try {
                        video.play().catch(function () { });
                    } catch (e) { }
                }
            }, 2000);

            try {
                const originalPlaybackRate = Object.getOwnPropertyDescriptor(
                    HTMLMediaElement.prototype, 'playbackRate'
                );
                if (originalPlaybackRate && originalPlaybackRate.set) {
                    Object.defineProperty(video, 'playbackRate', {
                        get: originalPlaybackRate.get,
                        set: function (val) {
                            if (val === 0 && STATE.forcePlayEnabled) {
                                log('playbackRate=0 被拦截');
                                return;
                            }
                            return originalPlaybackRate.set.call(this, val);
                        },
                        configurable: true
                    });
                }
            } catch (e) {
                warn('hook playbackRate failed:', e);
            }

            log('视频防暂停保护已激活');
        }

        function observeVideos() {
            document.querySelectorAll('video').forEach(protectVideo);

            const observer = new MutationObserver(function (mutations) {
                mutations.forEach(function (mutation) {
                    mutation.addedNodes.forEach(function (node) {
                        if (node.nodeName === 'VIDEO') {
                            protectVideo(node);
                        }
                        if (node.querySelectorAll) {
                            node.querySelectorAll('video').forEach(protectVideo);
                        }
                    });
                });
            });

            observer.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', observeVideos);
        } else {
            observeVideos();
        }
    }

    // ============================================================
    // 八、弹窗弹题自动处理
    // ============================================================
    function autoHandlePopups() {
        function handleQuizAndPopups() {
            const clickSelectors = [
                '.quiz-popup .submit-btn',
                '.quiz-popup .btn-confirm',
                '.quiz-popup .btn-submit',
                '.quiz-popup button[type="submit"]',
                '.quiz-popup .answer-option',
                '.quiz-popup .option-item',
                '.popup-question .submit-btn',
                '.popup-question .btn-confirm',
                '.question-popup .submit-btn',
                '.question-popup .btn-confirm',
                '.modal-quiz .submit-btn',
                '.modal-quiz .btn-confirm',
                '.exam-popup .submit-btn',
                '.exam-popup .btn-confirm',
                '.dialog-quiz .submit-btn',
                '.dialog-quiz .btn-confirm',
                '.interact-popup .submit-btn',
                '.interact-popup .btn-confirm',
                '.layui-layer-btn0',
                '.layui-layer-btn a',
                '.layui-layer-close',
                '.dialog-confirm .btn-confirm',
                '.dialog-confirm .btn-ok',
                '.ui-dialog .ui-dialog-buttonset button',
                '.ui-dialog .ui-dialog-buttonpane button:first-child',
                '.bootbox .btn-primary',
                '.sweet-alert .confirm',
                '.noty_type__confirm .btn-primary',
            ];

            const closeSelectors = [
                '.quiz-popup .close-btn',
                '.quiz-popup .btn-close',
                '.popup-question .close-btn',
                '.question-popup .close-btn',
                '.modal-quiz .close-btn',
                '.exam-popup .close-btn',
                '.dialog-quiz .close-btn',
                '.interact-popup .close-btn',
                '.layui-layer-close1',
                '.ui-dialog .ui-dialog-titlebar-close',
                '.bootbox .close',
                '.sweet-alert .sa-close',
                '.alert-popup .close',
                '.notification .close',
                '.tip-popup .close',
                '.tip-box .close',
                '.msg-box .close',
            ];

            const quizContainers = [
                '.quiz-popup',
                '.popup-question',
                '.question-popup',
                '.modal-quiz',
                '.exam-popup',
                '.dialog-quiz',
                '.interact-popup',
                '.exam-interact',
                '.study-interact',
            ];

            quizContainers.forEach(function (containerSelector) {
                const containers = document.querySelectorAll(containerSelector);
                containers.forEach(function (container) {
                    if (container.style.display === 'none' ||
                        container.offsetParent === null) return;

                    if (container._autoHandled) return;
                    container._autoHandled = true;

                    log('检测到弹题容器:', containerSelector);
                    STATE.quizCount++;

                    const optionSelectors = [
                        '.answer-option', '.option-item', 'input[type="radio"]',
                        'input[type="checkbox"]', '.choice-item', '.quiz-option',
                        'li', '.radio-item', '.checkbox-item'
                    ];

                    let optionClicked = false;
                    for (let i = 0; i < optionSelectors.length && !optionClicked; i++) {
                        const options = container.querySelectorAll(optionSelectors[i]);
                        if (options.length > 0) {
                            options[0].click();
                            optionClicked = true;
                            log('自动选择了第一个选项');
                        }
                    }

                    setTimeout(function () {
                        clickSelectors.forEach(function (sel) {
                            const btn = container.querySelector(sel);
                            if (btn) {
                                btn.click();
                                log('自动点击了提交按钮:', sel);
                            }
                        });

                        const globalConfirmBtns = document.querySelectorAll(
                            '.layui-layer-btn0, .dialog-confirm .btn-confirm'
                        );
                        globalConfirmBtns.forEach(function (btn) {
                            if (btn.offsetParent !== null) {
                                btn.click();
                                log('自动点击了全局确认按钮');
                            }
                        });
                    }, 500);
                });
            });

            closeSelectors.forEach(function (sel) {
                const btns = document.querySelectorAll(sel);
                btns.forEach(function (btn) {
                    if (btn.offsetParent !== null && !btn._autoClicked) {
                        btn._autoClicked = true;
                        btn.click();
                        log('自动关闭弹窗:', sel);
                        setTimeout(function () { btn._autoClicked = false; }, 3000);
                    }
                });
            });

            try {
                const iframes = document.querySelectorAll('iframe');
                iframes.forEach(function (iframe) {
                    try {
                        if (iframe.contentDocument) {
                            const iframeQuiz = iframe.contentDocument.querySelectorAll(
                                '.quiz-popup, .popup-question, .question-popup, .exam-popup'
                            );
                            iframeQuiz.forEach(function (q) {
                                if (q.style.display !== 'none' && q.offsetParent !== null) {
                                    const btn = q.querySelector('.submit-btn, .btn-confirm, button[type="submit"]');
                                    if (btn) btn.click();
                                }
                            });
                        }
                    } catch (e) { }
                });
            } catch (e) { }
        }

        setInterval(handleQuizAndPopups, 2000);

        const popupObserver = new MutationObserver(function (mutations) {
            let shouldCheck = false;
            mutations.forEach(function (m) {
                if (m.addedNodes.length > 0) shouldCheck = true;
                if (m.type === 'attributes') shouldCheck = true;
            });
            if (shouldCheck) handleQuizAndPopups();
        });

        function startPopupObserver() {
            popupObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class', 'display']
            });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startPopupObserver);
        } else {
            startPopupObserver();
        }

        log('弹窗弹题自动处理已激活');
    }

    // ============================================================
    // 九、模拟用户活动
    // ============================================================
    function simulateUserActivity() {
        function dispatchMouseEvent(type) {
            const x = Math.random() * window.innerWidth;
            const y = Math.random() * window.innerHeight;
            const evt = new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y,
                screenX: x,
                screenY: y,
                movementX: Math.random() * 10 - 5,
                movementY: Math.random() * 10 - 5
            });
            document.elementFromPoint(x, y)?.dispatchEvent(evt);
            STATE.lastMouseMoveTime = Date.now();
        }

        function scheduleMouseMove() {
            const delay = 3000 + Math.random() * 5000;
            setTimeout(function () {
                if (STATE.simulateActivityEnabled) {
                    dispatchMouseEvent('mousemove');
                    dispatchMouseEvent('mouseover');
                }
                scheduleMouseMove();
            }, delay);
        }
        scheduleMouseMove();

        setInterval(function () {
            if (!STATE.simulateActivityEnabled) return;
            const video = document.querySelector('video');
            if (video) {
                const rect = video.getBoundingClientRect();
                const x = rect.left + Math.random() * rect.width;
                const y = rect.top + Math.random() * rect.height;
                const clickEvt = new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: x,
                    clientY: y
                });
                document.elementFromPoint(x, y)?.dispatchEvent(clickEvt);
                log('模拟点击视频区域');
            }
        }, 30000);

        setInterval(function () {
            if (!STATE.simulateActivityEnabled) return;
            const keyEvt = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: ' ',
                code: 'Space'
            });
            document.dispatchEvent(keyEvt);
            log('模拟键盘事件');
        }, 60000);

        function hookIdleDetection() {
            const idleVars = ['lastActiveTime', 'lastActivityTime', 'lastOperateTime',
                'lastActionTime', 'lastMouseMoveTime', 'lastUserActionTime',
                'lastStudyTime', 'lastPlayTime', 'lastHeartbeatTime',
                'studyActiveTime', 'playActiveTime'];

            setInterval(function () {
                idleVars.forEach(function (varName) {
                    if (window[varName] !== undefined) {
                        window[varName] = Date.now();
                    }
                });

                if (window.$ && window.$.fn) {
                    try {
                        const $doc = $(document);
                        idleVars.forEach(function (varName) {
                            if ($doc.data(varName) !== undefined) {
                                $doc.data(varName, Date.now());
                            }
                        });
                    } catch (e) { }
                }
            }, 5000);
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', hookIdleDetection);
        } else {
            hookIdleDetection();
        }

        log('模拟用户活动已激活');
    }

    // ============================================================
    // 十、本地计时器
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

        log('本地计时器已启动');
    }

    // ============================================================
    // 十一、拦截 setInterval / setTimeout
    // ============================================================
    function hookTimers() {
        const originalSetInterval = window.setInterval;
        const originalSetTimeout = window.setTimeout;

        window.setInterval = function (fn, delay) {
            const fnStr = fn ? fn.toString() : '';

            if (fnStr.indexOf('stopTimer') !== -1 ||
                fnStr.indexOf('stopStudy') !== -1 ||
                fnStr.indexOf('pauseTimer') !== -1 ||
                fnStr.indexOf('pauseStudy') !== -1 ||
                fnStr.indexOf('clearTimer') !== -1 ||
                fnStr.indexOf('endStudy') !== -1 ||
                fnStr.indexOf('stopCount') !== -1 ||
                fnStr.indexOf('pauseCount') !== -1 ||
                fnStr.indexOf('stopPlay') !== -1 ||
                fnStr.indexOf('pausePlay') !== -1) {

                log('检测到停止计时的定时器，已替换为空函数');
                return originalSetInterval.call(window, function () {
                    log('被拦截的停止计时定时器触发，已忽略');
                }, delay);
            }

            return originalSetInterval.apply(this, arguments);
        };

        window.setTimeout = function (fn, delay) {
            const fnStr = fn ? fn.toString() : '';

            if (fnStr.indexOf('stopTimer') !== -1 ||
                fnStr.indexOf('stopStudy') !== -1 ||
                fnStr.indexOf('pauseTimer') !== -1 ||
                fnStr.indexOf('pauseStudy') !== -1 ||
                fnStr.indexOf('clearTimer') !== -1 ||
                fnStr.indexOf('endStudy') !== -1 ||
                fnStr.indexOf('stopCount') !== -1 ||
                fnStr.indexOf('pauseCount') !== -1 ||
                fnStr.indexOf('stopPlay') !== -1 ||
                fnStr.indexOf('pausePlay') !== -1) {

                log('检测到停止计时的延时器，已替换为空函数');
                return originalSetTimeout.call(window, function () {
                    log('被拦截的停止计时延时器触发，已忽略');
                }, delay);
            }

            return originalSetTimeout.apply(this, arguments);
        };

        log('定时器拦截已激活');
    }

    // ============================================================
    // 十二、心跳保活
    // ============================================================
    function startHeartbeat() {
        setInterval(function () {
            try {
                if (window.heartbeat) {
                    window.heartbeat();
                } else if (window.keepAlive) {
                    window.keepAlive();
                } else if (window.keepalive) {
                    window.keepalive();
                }

                const xhr = new XMLHttpRequest();
                xhr.open('GET', window.location.href, true);
                xhr.timeout = 10000;
                xhr.send();
            } catch (e) { }
        }, STATE.heartbeatInterval);

        log('心跳保活已启动');
    }

    // ============================================================
    // 十三、拦截平台特定的停止计时函数
    // ============================================================
    function hookPlatformFunctions() {
        function waitForWindow() {
            const stopFunctions = [
                'stopTimer', 'stopStudy', 'stopCount', 'stopPlay',
                'pauseTimer', 'pauseStudy', 'pauseCount', 'pausePlay',
                'endTimer', 'endStudy', 'endCount', 'endPlay',
                'clearTimer', 'clearStudy', 'clearCount',
                'suspendTimer', 'suspendStudy', 'suspendPlay',
                'freezeTimer', 'freezeStudy',
                'haltStudy', 'haltTimer',
            ];

            stopFunctions.forEach(function (fnName) {
                if (typeof window[fnName] === 'function') {
                    const original = window[fnName];
                    window[fnName] = function () {
                        log('平台函数 ' + fnName + ' 被拦截');
                        return;
                    };
                    window[fnName]._original = original;
                }
            });

            if (window.$ && window.$.event) {
                try {
                    const originalTrigger = window.$.event.trigger;
                    window.$.event.trigger = function (type) {
                        const typeStr = (type || '').toString().toLowerCase();
                        if (typeStr.indexOf('stop') !== -1 ||
                            typeStr.indexOf('pause') !== -1 ||
                            typeStr.indexOf('suspend') !== -1) {
                            log('jQuery 事件 ' + type + ' 被拦截');
                            return;
                        }
                        return originalTrigger.apply(this, arguments);
                    };
                } catch (e) { }
            }
        }

        setTimeout(waitForWindow, 1000);
        setTimeout(waitForWindow, 3000);
        setTimeout(waitForWindow, 5000);
        setTimeout(waitForWindow, 10000);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () {
                setTimeout(waitForWindow, 500);
            });
        }

        log('平台函数拦截已激活');
    }

    // ============================================================
    // 十四、发现并保持平台内部计时变量
    // ============================================================
    function keepPlatformTimerAlive() {
        function findAndKeepTimers() {
            const timerVarPatterns = [
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

            const actualSec = getActualSec();

            timerVarPatterns.forEach(function (varName) {
                if (window[varName] !== undefined && typeof window[varName] === 'number') {
                    if (window[varName] < actualSec) {
                        log('刷新平台计时变量:', varName, window[varName], '->', actualSec);
                        window[varName] = actualSec;
                    }
                }
            });

            // 搜索 window 上的数字属性，寻找可能是计时器的变量
            try {
                for (const key in window) {
                    if (typeof window[key] === 'number' && window[key] > 0 && window[key] < actualSec + 100) {
                        const k = key.toLowerCase();
                        if ((k.indexOf('time') !== -1 || k.indexOf('sec') !== -1 ||
                            k.indexOf('dur') !== -1 || k.indexOf('count') !== -1 ||
                            k.indexOf('timer') !== -1 || k.indexOf('elapsed') !== -1) &&
                            window[key] < actualSec) {
                            log('发现疑似计时变量:', key, '=', window[key], '->', actualSec);
                            window[key] = actualSec;
                        }
                    }
                }
            } catch (e) { }

            // 搜索 Vue 实例中的数据
            try {
                const vueEls = document.querySelectorAll('[data-v-],[__vue__]');
                vueEls.forEach(function (el) {
                    const vm = el.__vue__ || el._vm;
                    if (vm && vm.$data) {
                        for (const key in vm.$data) {
                            if (typeof vm.$data[key] === 'number' && vm.$data[key] < actualSec && vm.$data[key] > 0) {
                                const k = key.toLowerCase();
                                if (k.indexOf('time') !== -1 || k.indexOf('sec') !== -1 ||
                                    k.indexOf('dur') !== -1 || k.indexOf('study') !== -1) {
                                    log('发现 Vue 计时变量:', key, '=', vm.$data[key], '->', actualSec);
                                    vm.$data[key] = actualSec;
                                }
                            }
                        }
                    }
                });
            } catch (e) { }
        }

        setInterval(findAndKeepTimers, 5000);

        log('平台计时变量保持已激活');
    }

    // ============================================================
    // 十五、状态面板（增强版）
    // ============================================================
    function createStatusPanel() {
        GM_addStyle(`
            #esnai-helper-panel {
                position: fixed;
                top: 10px;
                right: 10px;
                background: rgba(0, 0, 0, 0.9);
                color: #0f0;
                padding: 12px 16px;
                border-radius: 8px;
                z-index: 2147483647;
                font-family: 'Consolas', 'Monaco', monospace;
                font-size: 13px;
                line-height: 1.6;
                min-width: 280px;
                max-width: 360px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                border: 1px solid #0f0;
                user-select: none;
            }
            #esnai-helper-panel .panel-title {
                font-size: 15px;
                font-weight: bold;
                color: #0ff;
                margin-bottom: 8px;
                border-bottom: 1px solid #0f0;
                padding-bottom: 6px;
            }
            #esnai-helper-panel .panel-row {
                display: flex;
                justify-content: space-between;
                margin: 3px 0;
            }
            #esnai-helper-panel .panel-label {
                color: #aaa;
            }
            #esnai-helper-panel .panel-value {
                color: #0f0;
                font-weight: bold;
            }
            #esnai-helper-panel .panel-status {
                color: #0f0;
                font-weight: bold;
            }
            #esnai-helper-panel .panel-status.warning {
                color: #ff0;
            }
            #esnai-helper-panel .panel-status.error {
                color: #f00;
            }
            #esnai-helper-panel .panel-btn {
                background: #0f0;
                color: #000;
                border: none;
                padding: 4px 10px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                margin: 2px;
                font-weight: bold;
            }
            #esnai-helper-panel .panel-btn:hover {
                background: #0ff;
            }
            #esnai-helper-panel .panel-btn.active {
                background: #f00;
                color: #fff;
            }
            #esnai-helper-panel .panel-buttons {
                margin-top: 8px;
                border-top: 1px solid #0f0;
                padding-top: 8px;
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
            }
            #esnai-helper-panel .panel-netlog {
                margin-top: 8px;
                border-top: 1px solid #333;
                padding-top: 6px;
                max-height: 120px;
                overflow-y: auto;
                font-size: 11px;
            }
            #esnai-helper-panel .panel-netlog .log-entry {
                margin: 1px 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #esnai-helper-panel .panel-netlog .log-MODIFY { color: #0f0; }
            #esnai-helper-panel .panel-netlog .log-BLOCK { color: #f00; }
            #esnai-helper-panel .panel-netlog .log-MISS { color: #ff0; }
            #esnai-helper-panel .panel-netlog .log-PROACTIVE { color: #0ff; }
            #esnai-helper-panel .panel-netlog .log-HOOK { color: #aaa; }
            #esnai-helper-panel .panel-netlog .log-PASS { color: #555; }
            #esnai-helper-panel .panel-netlog .log-ERROR { color: #f00; }
            #esnai-helper-panel .panel-netlog .log-NOBODY { color: #ff0; }
            #esnai-helper-panel .panel-toggle {
                position: absolute;
                top: 4px;
                right: 8px;
                cursor: pointer;
                color: #0f0;
                font-size: 16px;
            }
        `);

        const panel = document.createElement('div');
        panel.id = 'esnai-helper-panel';
        panel.innerHTML = `
            <span class="panel-toggle" id="eh-toggle" title="折叠/展开">▼</span>
            <div class="panel-title">ESNAI 继续教育助手 v3.0</div>
            <div id="eh-body">
                <div class="panel-row">
                    <span class="panel-label">运行状态:</span>
                    <span class="panel-status" id="eh-status">运行中</span>
                </div>
                <div class="panel-row">
                    <span class="panel-label">本地计时:</span>
                    <span class="panel-value" id="eh-local-time">00:00:00</span>
                </div>
                <div class="panel-row">
                    <span class="panel-label">视频进度:</span>
                    <span class="panel-value" id="eh-video-time">00:00:00</span>
                </div>
                <div class="panel-row">
                    <span class="panel-label">视频状态:</span>
                    <span class="panel-value" id="eh-video-status">检测中...</span>
                </div>
                <div class="panel-row">
                    <span class="panel-label">弹题处理:</span>
                    <span class="panel-value" id="eh-quiz-count">0 次</span>
                </div>
                <div class="panel-row">
                    <span class="panel-label">上报次数:</span>
                    <span class="panel-value" id="eh-report-count">0 次</span>
                </div>
                <div class="panel-row">
                    <span class="panel-label">上次上报:</span>
                    <span class="panel-value" id="eh-last-report">未上报</span>
                </div>
                <div class="panel-row">
                    <span class="panel-label">上报秒数:</span>
                    <span class="panel-value" id="eh-reported-sec">0</span>
                </div>
                <div class="panel-row">
                    <span class="panel-label">页面可见:</span>
                    <span class="panel-value" id="eh-visibility">是(伪造)</span>
                </div>
                <div class="panel-buttons">
                    <button class="panel-btn active" id="eh-btn-play" title="防暂停">防暂停:开</button>
                    <button class="panel-btn active" id="eh-btn-quiz" title="自动答题">自动答题:开</button>
                    <button class="panel-btn active" id="eh-btn-activity" title="模拟活动">模拟活动:开</button>
                    <button class="panel-btn active" id="eh-btn-anti" title="反检测">反检测:开</button>
                </div>
                <div class="panel-netlog" id="eh-netlog"></div>
            </div>
        `;
        document.body.appendChild(panel);

        let collapsed = false;
        document.getElementById('eh-toggle').addEventListener('click', function () {
            collapsed = !collapsed;
            document.getElementById('eh-body').style.display = collapsed ? 'none' : '';
            this.textContent = collapsed ? '▶' : '▼';
        });

        setInterval(function () {
            const localSec = getActualSec();
            const h = Math.floor(localSec / 3600);
            const m = Math.floor((localSec % 3600) / 60);
            const s = localSec % 60;
            const timeStr = [h, m, s].map(function (v) {
                return v < 10 ? '0' + v : v;
            }).join(':');

            document.getElementById('eh-local-time').textContent = timeStr;

            const video = document.querySelector('video');
            if (video) {
                const vSec = Math.floor(video.currentTime);
                const vh = Math.floor(vSec / 3600);
                const vm = Math.floor((vSec % 3600) / 60);
                const vs = vSec % 60;
                document.getElementById('eh-video-time').textContent =
                    [vh, vm, vs].map(function (v) {
                        return v < 10 ? '0' + v : v;
                    }).join(':');

                const statusEl = document.getElementById('eh-video-status');
                if (video.paused) {
                    statusEl.textContent = '已暂停(恢复中)';
                    statusEl.className = 'panel-status warning';
                } else if (video.ended) {
                    statusEl.textContent = '已结束';
                    statusEl.className = 'panel-status warning';
                } else {
                    statusEl.textContent = '播放中';
                    statusEl.className = 'panel-status';
                }
            } else {
                document.getElementById('eh-video-time').textContent = '未检测到';
                document.getElementById('eh-video-status').textContent = '无视频';
            }

            document.getElementById('eh-quiz-count').textContent = STATE.quizCount + ' 次';
            document.getElementById('eh-report-count').textContent = STATE.reportCount + ' 次';
            document.getElementById('eh-reported-sec').textContent = STATE.lastReportedSec + 's';

            if (STATE.lastReportedTime > 0) {
                const ago = Math.floor((Date.now() - STATE.lastReportedTime) / 1000);
                document.getElementById('eh-last-report').textContent = ago + '秒前';
            }

            // 更新网络日志
            const netlogEl = document.getElementById('eh-netlog');
            if (netlogEl && STATE.networkLog.length > 0) {
                const recentLogs = STATE.networkLog.slice(-8);
                netlogEl.innerHTML = recentLogs.map(function (entry) {
                    const cls = 'log-' + (entry.type || 'PASS');
                    const shortUrl = entry.url.replace(/^https?:\/\/[^/]+/, '');
                    return '<div class="log-entry ' + cls + '">' +
                        entry.time + ' [' + entry.type + '] ' + shortUrl +
                        (entry.detail ? ' ' + entry.detail.substring(0, 40) : '') +
                        '</div>';
                }).join('');
            }
        }, 1000);

        document.getElementById('eh-btn-play').addEventListener('click', function () {
            STATE.forcePlayEnabled = !STATE.forcePlayEnabled;
            this.textContent = '防暂停:' + (STATE.forcePlayEnabled ? '开' : '关');
            this.classList.toggle('active', STATE.forcePlayEnabled);
        });

        document.getElementById('eh-btn-quiz').addEventListener('click', function () {
            STATE.quizAutoAnswerEnabled = !STATE.quizAutoAnswerEnabled;
            this.textContent = '自动答题:' + (STATE.quizAutoAnswerEnabled ? '开' : '关');
            this.classList.toggle('active', STATE.quizAutoAnswerEnabled);
        });

        document.getElementById('eh-btn-activity').addEventListener('click', function () {
            STATE.simulateActivityEnabled = !STATE.simulateActivityEnabled;
            this.textContent = '模拟活动:' + (STATE.simulateActivityEnabled ? '开' : '关');
            this.classList.toggle('active', STATE.simulateActivityEnabled);
        });

        document.getElementById('eh-btn-anti').addEventListener('click', function () {
            STATE.antiDetectionEnabled = !STATE.antiDetectionEnabled;
            this.textContent = '反检测:' + (STATE.antiDetectionEnabled ? '开' : '关');
            this.classList.toggle('active', STATE.antiDetectionEnabled);
        });

        log('状态面板已创建（增强版）');
    }

    // ============================================================
    // 十六、拦截 beforeunload 和 unload
    // ============================================================
    function hookPageUnload() {
        window.addEventListener('beforeunload', function (e) {
            e.stopImmediatePropagation();
        }, true);

        window.addEventListener('unload', function (e) {
            e.stopImmediatePropagation();
        }, true);

        const originalWindowOpen = window.open;
        window.open = function (url) {
            log('window.open 被拦截:', url);
            return null;
        };

        log('页面卸载拦截已激活');
    }

    // ============================================================
    // 十七、处理 iframe 内的视频
    // ============================================================
    function handleIframeVideos() {
        function processIframes() {
            const iframes = document.querySelectorAll('iframe');
            iframes.forEach(function (iframe) {
                try {
                    if (!iframe.contentDocument) return;

                    const videos = iframe.contentDocument.querySelectorAll('video');
                    videos.forEach(function (video) {
                        if (video._hooked) return;
                        video._hooked = true;

                        video.addEventListener('pause', function () {
                            if (STATE.forcePlayEnabled) {
                                setTimeout(function () {
                                    video.play().catch(function () { });
                                }, 50);
                            }
                        });

                        setInterval(function () {
                            if (STATE.forcePlayEnabled && video.paused && !video.ended) {
                                video.play().catch(function () { });
                            }
                        }, 3000);
                    });

                    iframe.contentWindow.alert = function () { };
                    iframe.contentWindow.confirm = function () { return true; };
                    iframe.contentWindow.prompt = function () { return ''; };
                } catch (e) { }
            });
        }

        setInterval(processIframes, 5000);
        if (document.readyState !== 'loading') {
            setTimeout(processIframes, 2000);
        }

        log('iframe 处理已激活');
    }

    // ============================================================
    // 十八、处理 esnai 特有的 Flash/HTML5 播放器
    // ============================================================
    function hookESNAIPlayer() {
        function findAndHookPlayer() {
            const playerObjects = ['player', 'videoPlayer', 'studyPlayer',
                'coursePlayer', 'flashPlayer', 'mediaPlayer',
                'polyvPlayer', 'ckPlayer', 'ckplayer'];

            playerObjects.forEach(function (name) {
                if (window[name] && typeof window[name] === 'object') {
                    log('检测到播放器对象:', name);

                    if (window[name].pause) {
                        const origPause = window[name].pause.bind(window[name]);
                        window[name].pause = function () {
                            if (STATE.forcePlayEnabled) {
                                log(name + '.pause() 被拦截');
                                return;
                            }
                            return origPause();
                        };
                    }

                    if (window[name].play) {
                        setInterval(function () {
                            try {
                                if (STATE.forcePlayEnabled) {
                                    window[name].play();
                                }
                            } catch (e) { }
                        }, 5000);
                    }
                }
            });

            const embeds = document.querySelectorAll('embed, object');
            embeds.forEach(function (embed) {
                log('检测到 Flash/embed 播放器');
                try {
                    if (embed.play) {
                        setInterval(function () {
                            try { embed.play(); } catch (e) { }
                        }, 5000);
                    }
                } catch (e) { }
            });
        }

        setTimeout(findAndHookPlayer, 1000);
        setTimeout(findAndHookPlayer, 3000);
        setTimeout(findAndHookPlayer, 5000);
        setTimeout(findAndHookPlayer, 10000);
        setTimeout(findAndHookPlayer, 20000);

        log('ESNAI 播放器钩子已设置');
    }

    // ============================================================
    // 十九、自动点击"继续学习"等确认按钮
    // ============================================================
    function autoClickContinueButtons() {
        function clickContinue() {
            const allButtons = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
            allButtons.forEach(function (btn) {
                const text = (btn.textContent || btn.value || '').trim();
                if (text === '继续学习' || text === '继续' || text === '确定' ||
                    text === '确认' || text === '知道了' || text === '好的' ||
                    text === 'OK' || text === 'Yes' || text === '是') {
                    if (btn.offsetParent !== null && !btn._autoClicked) {
                        btn._autoClicked = true;
                        btn.click();
                        log('自动点击了按钮:', text);
                        setTimeout(function () { btn._autoClicked = false; }, 5000);
                    }
                }
            });

            const layuiBtns = document.querySelectorAll('.layui-layer-btn0');
            layuiBtns.forEach(function (btn) {
                if (btn.offsetParent !== null && !btn._autoClicked) {
                    btn._autoClicked = true;
                    btn.click();
                    log('自动点击了 layui 确认按钮');
                    setTimeout(function () { btn._autoClicked = false; }, 5000);
                }
            });

            const artBtns = document.querySelectorAll('.aui_state_highlight, .aui_ok');
            artBtns.forEach(function (btn) {
                if (btn.offsetParent !== null && !btn._autoClicked) {
                    btn._autoClicked = true;
                    btn.click();
                    log('自动点击了 artDialog 确认按钮');
                    setTimeout(function () { btn._autoClicked = false; }, 5000);
                }
            });
        }

        setInterval(clickContinue, 3000);
        log('自动点击确认按钮已激活');
    }

    // ============================================================
    // 二十、Web Worker 计时
    // ============================================================
    function startWorkerTimer() {
        try {
            const workerCode = `
                let startTime = Date.now();
                setInterval(function() {
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    postMessage({ type: 'tick', elapsed: elapsed });
                }, 1000);
            `;
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const worker = new Worker(URL.createObjectURL(blob));

            worker.onmessage = function (e) {
                if (e.data.type === 'tick') {
                    STATE.localElapsed = e.data.elapsed;
                }
            };

            log('Web Worker 计时器已启动');
        } catch (e) {
            warn('Web Worker 启动失败，使用备用计时:', e);
        }
    }

    // ============================================================
    // 二十一、防止双课程检测（真正阻断版）
    // ============================================================
    function hookDualCourseDetection() {
        log('双课程检测拦截已由网络请求拦截模块统一处理');
    }

    // ============================================================
    // 初始化
    // ============================================================
    function init() {
        log('========== ESNAI 继续教育助手 v3.0 启动 ==========');

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
            autoHandlePopups();
            simulateUserActivity();
            startHeartbeat();
            hookPlatformFunctions();
            keepPlatformTimerAlive();
            handleIframeVideos();
            hookESNAIPlayer();
            autoClickContinueButtons();
            hookDualCourseDetection();
            startProactiveReporting();
            createStatusPanel();

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
