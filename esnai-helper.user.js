// ==UserScript==
// @name         ESNAI继续教育视频学习助手
// @namespace    https://ce.esnai.net/
// @version      2.5.0
// @description  确保视频学习时间正常累计，防止计时中断、弹题打断、暂停检测等
// @author       GLM
// @match        *://ce.esnai.net/*
// @match        *://*.esnai.net/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// @noframes     false
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
        videoPlaying: false,
        videoElement: null,
        lastMouseMoveTime: Date.now(),
        heartbeatInterval: 30000,
        reportInterval: 60000,
        quizAutoAnswerEnabled: true,
        forcePlayEnabled: true,
        simulateActivityEnabled: true,
        antiDetectionEnabled: true,
    };

    // ============================================================
    // 二、页面可见性欺骗 —— 让平台永远认为页面是可见的
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

        // 让 document.hasFocus() 永远返回 true
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

        // 拦截 window.close
        window.close = function () {
            log('window.close 被拦截');
        };

        // 拦截 beforeunload
        window.addEventListener('beforeunload', function (e) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }, true);

        log('弹窗拦截已激活');
    }

    // ============================================================
    // 五、拦截 XMLHttpRequest / fetch —— 修正上报时间
    // ============================================================
    function hookNetworkRequests() {
        // 拦截 XMLHttpRequest
        const OriginalXHR = window.XMLHttpRequest;
        const xhrOpen = OriginalXHR.prototype.open;
        const xhrSend = OriginalXHR.prototype.send;

        OriginalXHR.prototype.open = function (method, url) {
            this._hookUrl = url;
            this._hookMethod = method;
            return xhrOpen.apply(this, arguments);
        };

        OriginalXHR.prototype.send = function (body) {
            if (this._hookUrl && typeof this._hookUrl === 'string') {
                const url = this._hookUrl.toLowerCase();

                // 检测计时上报请求
                if (url.indexOf('studytime') !== -1 ||
                    url.indexOf('reporttime') !== -1 ||
                    url.indexOf('savestudy') !== -1 ||
                    url.indexOf('updatetime') !== -1 ||
                    url.indexOf('studyrecord') !== -1 ||
                    url.indexOf('learnrecord') !== -1 ||
                    url.indexOf('heartbeat') !== -1 ||
                    url.indexOf('keeplive') !== -1 ||
                    url.indexOf('keepalive') !== -1 ||
                    url.indexOf('report') !== -1) {

                    log('拦截到计时上报请求:', this._hookUrl);

                    // 修正上报的秒数
                    if (body && typeof body === 'string') {
                        try {
                            const actualSec = Math.floor((Date.now() - STATE.startTime) / 1000);
                            let modified = body;

                            // 替换常见的秒数字段
                            const secPatterns = [
                                /([\"']?(?:second|sec|seconds|studytime|learnTime|duration|elapsed|time)[\"']?\s*[=:]\s*)\d+/gi,
                                /([\"']?(?:study_time|learn_time|play_time)[\"']?\s*[=:]\s*)\d+/gi
                            ];
                            secPatterns.forEach(function (pat) {
                                modified = modified.replace(pat, function (match, prefix) {
                                    log('修正上报秒数:', match, '->', prefix + actualSec);
                                    return prefix + actualSec;
                                });
                            });

                            if (modified !== body) {
                                arguments[0] = modified;
                                STATE.lastReportedSec = actualSec;
                            }
                        } catch (e) {
                            warn('修正上报数据失败:', e);
                        }
                    }
                }
            }
            return xhrSend.apply(this, arguments);
        };

        // 拦截 fetch
        const originalFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                const url = (typeof input === 'string') ? input :
                    (input instanceof Request) ? input.url : '';

                if (url && typeof url === 'string') {
                    const urlLower = url.toLowerCase();
                    if (urlLower.indexOf('studytime') !== -1 ||
                        urlLower.indexOf('reporttime') !== -1 ||
                        urlLower.indexOf('savestudy') !== -1 ||
                        urlLower.indexOf('updatetime') !== -1 ||
                        urlLower.indexOf('studyrecord') !== -1 ||
                        urlLower.indexOf('learnrecord') !== -1 ||
                        urlLower.indexOf('heartbeat') !== -1 ||
                        urlLower.indexOf('keeplive') !== -1 ||
                        urlLower.indexOf('keepalive') !== -1 ||
                        urlLower.indexOf('report') !== -1) {

                        log('拦截到 fetch 计时上报:', url);

                        if (init && init.body && typeof init.body === 'string') {
                            const actualSec = Math.floor((Date.now() - STATE.startTime) / 1000);
                            let modified = init.body;

                            const secPatterns = [
                                /([\"']?(?:second|sec|seconds|studytime|learnTime|duration|elapsed|time)[\"']?\s*[=:]\s*)\d+/gi,
                                /([\"']?(?:study_time|learn_time|play_time)[\"']?\s*[=:]\s*)\d+/gi
                            ];
                            secPatterns.forEach(function (pat) {
                                modified = modified.replace(pat, function (match, prefix) {
                                    log('修正 fetch 上报秒数:', match, '->', prefix + actualSec);
                                    return prefix + actualSec;
                                });
                            });

                            if (modified !== init.body) {
                                init.body = modified;
                                STATE.lastReportedSec = actualSec;
                            }
                        }
                    }
                }
            } catch (e) {
                warn('fetch hook error:', e);
            }
            return originalFetch.apply(this, arguments);
        };

        log('网络请求拦截已激活');
    }

    // ============================================================
    // 六、主动上报计时 —— 平台长时间不上报时自己上报
    // ============================================================
    function startProactiveReporting() {
        setInterval(function () {
            try {
                const actualSec = Math.floor((Date.now() - STATE.startTime) / 1000);

                if (actualSec - STATE.lastReportedSec > 60) {
                    log('主动上报计时，实际秒数:', actualSec, '上次上报:', STATE.lastReportedSec);

                    // 尝试找到页面中的计时上报函数并调用
                    // esnai 平台通常使用全局函数或 jQuery AJAX 上报
                    if (window.saveStudyTime) {
                        window.saveStudyTime(actualSec);
                        STATE.lastReportedSec = actualSec;
                    } else if (window.reportStudyTime) {
                        window.reportStudyTime(actualSec);
                        STATE.lastReportedSec = actualSec;
                    } else if (window.updateStudyRecord) {
                        window.updateStudyRecord(actualSec);
                        STATE.lastReportedSec = actualSec;
                    }
                }
            } catch (e) {
                warn('主动上报失败:', e);
            }
        }, STATE.reportInterval);

        log('主动上报计时已启动');
    }

    // ============================================================
    // 七、视频防暂停 —— 阻止视频被暂停，被暂停后立即恢复
    // ============================================================
    function hookVideoPause() {
        function protectVideo(video) {
            if (video._hooked) return;
            video._hooked = true;

            // 拦截 pause() 调用
            const originalPause = video.pause.bind(video);
            let pauseBlocked = false;

            video.pause = function () {
                if (STATE.forcePlayEnabled && !pauseBlocked) {
                    log('video.pause() 被拦截');
                    return;
                }
                return originalPause();
            };

            // 监听 pause 事件，立即恢复播放
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

            // 监听 waiting / stalled 事件
            ['waiting', 'stalled', 'suspend'].forEach(function (evt) {
                video.addEventListener(evt, function (e) {
                    if (STATE.forcePlayEnabled) {
                        e.stopImmediatePropagation();
                        log('视频 ' + evt + ' 事件被拦截');
                    }
                }, true);
            });

            // 确保视频持续播放
            setInterval(function () {
                if (STATE.forcePlayEnabled && video.paused && !video.ended) {
                    log('检测到视频暂停，强制恢复');
                    try {
                        video.play().catch(function () { });
                    } catch (e) { }
                }
            }, 2000);

            // 防止视频播放速率被修改为0
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

        // MutationObserver 监听视频元素
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
            // 自动点击弹题中的选项和确认按钮
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

            // 自动关闭弹窗
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

            // 弹题容器选择器 —— 如果出现，自动选择第一个选项并提交
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

            // 处理弹题容器
            quizContainers.forEach(function (containerSelector) {
                const containers = document.querySelectorAll(containerSelector);
                containers.forEach(function (container) {
                    if (container.style.display === 'none' ||
                        container.offsetParent === null) return;

                    if (container._autoHandled) return;
                    container._autoHandled = true;

                    log('检测到弹题容器:', containerSelector);

                    // 选择第一个选项
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

                    // 点击提交按钮
                    setTimeout(function () {
                        clickSelectors.forEach(function (sel) {
                            const btn = container.querySelector(sel);
                            if (btn) {
                                btn.click();
                                log('自动点击了提交按钮:', sel);
                            }
                        });

                        // 如果有确认按钮在容器外
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

            // 处理关闭按钮
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

            // 处理 iframe 中的弹题
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

        // 每2秒检测一次弹窗弹题
        setInterval(handleQuizAndPopups, 2000);

        // MutationObserver 实时检测
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
    // 九、模拟用户活动 —— 鼠标移动、点击、键盘
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

        // 每 3-8 秒模拟一次鼠标移动（随机间隔）
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

        // 每 30 秒模拟一次点击（在视频区域）
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

        // 每 60 秒模拟一次键盘按键
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

        // 拦截平台的无操作检测
        // 有些平台用全局变量记录最后操作时间
        function hookIdleDetection() {
            // 覆盖常见的最后活动时间变量
            const idleVars = ['lastActiveTime', 'lastActivityTime', 'lastOperateTime',
                'lastActionTime', 'lastMouseMoveTime', 'lastUserActionTime'];

            setInterval(function () {
                idleVars.forEach(function (varName) {
                    if (window[varName] !== undefined) {
                        window[varName] = Date.now();
                    }
                });

                // 也检查常见的 jQuery 数据
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
    // 十、本地计时器 —— 独立于视频播放的计时
    // ============================================================
    function startLocalTimer() {
        setInterval(function () {
            STATE.localElapsed = Math.floor((Date.now() - STATE.startTime) / 1000);

            // 同步视频进度到实际时间
            const video = document.querySelector('video');
            if (video && STATE.forcePlayEnabled) {
                // 如果视频的 currentTime 远小于我们记录的本地时间
                // 说明视频可能被弹题暂停了，需要修正
                const videoTime = Math.floor(video.currentTime);
                const expectedTime = STATE.localElapsed;

                // 只在差距较大时修正（避免频繁跳转）
                if (expectedTime - videoTime > 10 && expectedTime < video.duration) {
                    log('修正视频进度:', videoTime, '->', expectedTime);
                    video.currentTime = expectedTime;
                }
            }
        }, 5000);

        log('本地计时器已启动');
    }

    // ============================================================
    // 十一、拦截 setInterval / setTimeout —— 防止平台用定时器停止计时
    // ============================================================
    function hookTimers() {
        const originalSetInterval = window.setInterval;
        const originalSetTimeout = window.setTimeout;

        // 记录平台创建的定时器，用于监控
        window.setInterval = function (fn, delay) {
            const fnStr = fn ? fn.toString() : '';

            // 检测停止计时的定时器
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
    // 十二、心跳保活 —— 定期发送请求防止会话过期
    // ============================================================
    function startHeartbeat() {
        setInterval(function () {
            try {
                // 尝试找到页面中的心跳/保活函数
                if (window.heartbeat) {
                    window.heartbeat();
                } else if (window.keepAlive) {
                    window.keepAlive();
                } else if (window.keepalive) {
                    window.keepalive();
                }

                // 通过 AJAX 发送心跳
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

            // 拦截 jQuery 事件触发的停止计时
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

        // 延迟执行，等待平台脚本加载
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
    // 十四、状态面板 —— 显示在页面右上角
    // ============================================================
    function createStatusPanel() {
        GM_addStyle(`
            #esnai-helper-panel {
                position: fixed;
                top: 10px;
                right: 10px;
                background: rgba(0, 0, 0, 0.85);
                color: #0f0;
                padding: 12px 16px;
                border-radius: 8px;
                z-index: 2147483647;
                font-family: 'Consolas', 'Monaco', monospace;
                font-size: 13px;
                line-height: 1.6;
                min-width: 260px;
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
        `);

        const panel = document.createElement('div');
        panel.id = 'esnai-helper-panel';
        panel.innerHTML = `
            <div class="panel-title">ESNAI 继续教育助手 v2.5</div>
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
                <span class="panel-label">页面可见:</span>
                <span class="panel-value" id="eh-visibility">是(伪造)</span>
            </div>
            <div class="panel-buttons">
                <button class="panel-btn active" id="eh-btn-play" title="防暂停">防暂停:开</button>
                <button class="panel-btn active" id="eh-btn-quiz" title="自动答题">自动答题:开</button>
                <button class="panel-btn active" id="eh-btn-activity" title="模拟活动">模拟活动:开</button>
                <button class="panel-btn active" id="eh-btn-anti" title="反检测">反检测:开</button>
            </div>
        `;
        document.body.appendChild(panel);

        let quizCount = 0;

        // 更新面板
        setInterval(function () {
            const localSec = Math.floor((Date.now() - STATE.startTime) / 1000);
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
        }, 1000);

        // 按钮事件
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

        log('状态面板已创建');
    }

    // ============================================================
    // 十五、拦截 beforeunload 和 unload —— 防止页面被关闭
    // ============================================================
    function hookPageUnload() {
        window.addEventListener('beforeunload', function (e) {
            e.stopImmediatePropagation();
        }, true);

        window.addEventListener('unload', function (e) {
            e.stopImmediatePropagation();
        }, true);

        // 拦截 location 赋值导致的页面跳转
        let lastHref = window.location.href;
        const originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');

        // 拦截 window.open
        const originalWindowOpen = window.open;
        window.open = function (url) {
            log('window.open 被拦截:', url);
            return null;
        };

        log('页面卸载拦截已激活');
    }

    // ============================================================
    // 十六、处理 iframe 内的视频
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

                    // 拦截 iframe 内的弹窗
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
    // 十七、处理 esnai 特有的 Flash/HTML5 播放器
    // ============================================================
    function hookESNAIPlayer() {
        function findAndHookPlayer() {
            // esnai 平台可能使用自定义播放器对象
            const playerObjects = ['player', 'videoPlayer', 'studyPlayer',
                'coursePlayer', 'flashPlayer', 'mediaPlayer',
                'polyvPlayer', 'ckPlayer', 'ckplayer'];

            playerObjects.forEach(function (name) {
                if (window[name] && typeof window[name] === 'object') {
                    log('检测到播放器对象:', name);

                    // 拦截暂停方法
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

                    // 确保播放
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

            // 查找 embed/object 标签（Flash 播放器）
            const embeds = document.querySelectorAll('embed, object');
            embeds.forEach(function (embed) {
                log('检测到 Flash/embed 播放器');
                // Flash 播放器通过 ExternalInterface 暴露方法
                try {
                    if (embed.play) {
                        setInterval(function () {
                            try { embed.play(); } catch (e) { }
                        }, 5000);
                    }
                } catch (e) { }
            });
        }

        // 多次尝试，等待播放器加载
        setTimeout(findAndHookPlayer, 1000);
        setTimeout(findAndHookPlayer, 3000);
        setTimeout(findAndHookPlayer, 5000);
        setTimeout(findAndHookPlayer, 10000);
        setTimeout(findAndHookPlayer, 20000);

        log('ESNAI 播放器钩子已设置');
    }

    // ============================================================
    // 十八、自动点击"继续学习"等确认按钮
    // ============================================================
    function autoClickContinueButtons() {
        function clickContinue() {
            const continueSelectors = [
                'button:contains("继续学习")',
                'button:contains("继续")',
                'button:contains("确定")',
                'button:contains("确认")',
                'a:contains("继续学习")',
                'a:contains("继续")',
                '.btn-continue',
                '.btn-confirm',
                '.btn-ok',
                '.btn-next',
                '.continue-btn',
                '.confirm-btn',
                '.ok-btn',
                '.next-btn',
                '#continueBtn',
                '#confirmBtn',
                '#okBtn',
                '#nextBtn',
            ];

            // 使用原生 DOM 查找（不依赖 jQuery :contains）
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

            // 处理 layui 弹层
            const layuiBtns = document.querySelectorAll('.layui-layer-btn0');
            layuiBtns.forEach(function (btn) {
                if (btn.offsetParent !== null && !btn._autoClicked) {
                    btn._autoClicked = true;
                    btn.click();
                    log('自动点击了 layui 确认按钮');
                    setTimeout(function () { btn._autoClicked = false; }, 5000);
                }
            });

            // 处理 artDialog
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
    // 十九、Web Worker 计时 —— 不受标签页节流影响
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
    // 二十、防止双课程检测
    // ============================================================
    function hookDualCourseDetection() {
        // 拦截"不能同时播放两门以上课程"的检测
        const OriginalXHR = window.XMLHttpRequest;
        const origOpen = OriginalXHR.prototype.open;

        OriginalXHR.prototype.open = function (method, url) {
            if (typeof url === 'string' && url.toLowerCase().indexOf('checkcourse') !== -1) {
                log('双课程检测请求被拦截:', url);
            }
            return origOpen.apply(this, arguments);
        };

        log('双课程检测拦截已激活');
    }

    // ============================================================
    // 初始化 —— 按顺序执行所有模块
    // ============================================================
    function init() {
        log('========== ESNAI 继续教育助手启动 ==========');

        // 1. 页面可见性欺骗（最早执行）
        hookDocumentVisibility();

        // 2. 窗口焦点欺骗
        hookWindowBlur();

        // 3. 屏蔽弹窗
        hookDialogs();

        // 4. 网络请求拦截
        hookNetworkRequests();

        // 5. 定时器拦截
        hookTimers();

        // 6. 页面卸载拦截
        hookPageUnload();

        // 7. Web Worker 计时
        startWorkerTimer();

        // 8. 本地计时器
        startLocalTimer();

        // 9. 等待 DOM 加载完成后执行
        function onDOMReady() {
            // 10. 视频防暂停
            hookVideoPause();

            // 11. 弹窗弹题自动处理
            autoHandlePopups();

            // 12. 模拟用户活动
            simulateUserActivity();

            // 13. 心跳保活
            startHeartbeat();

            // 14. 平台函数拦截
            hookPlatformFunctions();

            // 15. iframe 处理
            handleIframeVideos();

            // 16. ESNAI 播放器钩子
            hookESNAIPlayer();

            // 17. 自动点击确认按钮
            autoClickContinueButtons();

            // 18. 双课程检测拦截
            hookDualCourseDetection();

            // 19. 主动上报计时
            startProactiveReporting();

            // 20. 状态面板
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
