import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function flush() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

async function waitFor(predicate) {
    for (let i = 0; i < 50; i += 1) {
        if (predicate()) return;
        await flush();
    }
    throw new Error("Timed out waiting for condition");
}

function jsonResponse(status, payload, headerValues = {}) {
    const headers = new Map(
        Object.entries(headerValues).map(([key, value]) => [key.toLowerCase(), value])
    );
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: name => headers.get(String(name || "").toLowerCase()) || null,
        },
        json: async () => payload,
    };
}

function setupDirectApplicationHarness(options = {}) {
    unloadSharedNamespaces([
        "AMZ_CONSTANTS",
        "AMZ_DIRECT_API",
        "AMZ_DIRECT_APPLICATION",
        "AMZ_DIRECT_GUARD",
        "AMZ_DIRECT_APPLICATION_MODE",
        "AMZ_DIRECT_WAF",
        "AMZ_APPLICATION_OBSERVABILITY",
        "AMZ_ALERTS",
        "AMZ_URL",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/url.js",
    ]);
    const constants = globalThis.AMZ_CONSTANTS;
    globalThis.AMZ_CONSTANTS = Object.freeze({
        ...constants,
        DIRECT_APPLICATION: Object.freeze({
            ...constants.DIRECT_APPLICATION,
            REDIRECT_AFTER_SUCCESS: options.redirectAfterSuccess === true,
            UNAVAILABLE_JOB_SEARCH_REDIRECT_DELAY_MS:
                typeof options.unavailableRedirectDelayMs === "number"
                    ? options.unavailableRedirectDelayMs
                    : constants.DIRECT_APPLICATION.UNAVAILABLE_JOB_SEARCH_REDIRECT_DELAY_MS,
            WAF_PREFLIGHT_ENABLED:
                typeof options.wafPreflightEnabled === "boolean"
                    ? options.wafPreflightEnabled
                    : constants.DIRECT_APPLICATION.WAF_PREFLIGHT_ENABLED,
            RESERVATION_VERIFY_BEFORE_SUCCESS:
                typeof options.reservationVerifyBeforeSuccess === "boolean"
                    ? options.reservationVerifyBeforeSuccess
                    : constants.DIRECT_APPLICATION.RESERVATION_VERIFY_BEFORE_SUCCESS,
            SCHEDULE_VERIFY_BEFORE_CREATE:
                typeof options.scheduleVerifyBeforeCreate === "boolean"
                    ? options.scheduleVerifyBeforeCreate
                    : constants.DIRECT_APPLICATION.SCHEDULE_VERIFY_BEFORE_CREATE,
            SCHEDULE_DETAIL_WORKFLOW_WAIT_MS:
                typeof options.scheduleDetailWorkflowWaitMs === "number"
                    ? options.scheduleDetailWorkflowWaitMs
                    : constants.DIRECT_APPLICATION.SCHEDULE_DETAIL_WORKFLOW_WAIT_MS,
            WORKFLOW_WEBSOCKET_ENABLED: options.workflowWebSocketEnabled === true,
            WORKFLOW_WEBSOCKET_CLOSE_DELAY_MS: 0,
            WORKFLOW_WEBSOCKET_OPEN_TIMEOUT_MS: 50,
            useDirectApplication:
                typeof options.useDirectApplication === "boolean"
                    ? options.useDirectApplication
                    : constants.DIRECT_APPLICATION.useDirectApplication,
        }),
    });

    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        url: options.url || "https://hiring.amazon.ca/application/ca/?country=ca&locale=en-CA&jobId=JOB-1&scheduleId=SCH-1",
        pretendToBeVisual: true,
    });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;

    const { DIRECT_APPLICATION, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
    const runtimeState = {
        useDirectApplication: options.storedUseDirectApplication ?? options.useDirectApplication,
    };
    dom.window.localStorage.setItem(
        DIRECT_APPLICATION.CANDIDATE_ID_LOCAL_STORAGE_KEY,
        "candidate-1"
    );

    globalThis.chrome.runtime.getURL = path => path;
    const audioPlays = [];
    class FakeAudio {
        constructor(src) {
            this.src = src;
            this.volume = 1;
            this.preload = "";
        }
        addEventListener() {}
        play() {
            audioPlays.push(this.src);
            return Promise.resolve();
        }
    }
    globalThis.Audio = FakeAudio;
    dom.window.Audio = FakeAudio;

    const storageWrites = [];
    globalThis.AMZ_STORAGE = {
        getLocal: vi.fn(async keys => {
            const values = {
                [STORAGE_KEYS.ACTIVE]: true,
                [STORAGE_KEYS.USE_DIRECT_APPLICATION]: runtimeState.useDirectApplication,
                [STORAGE_KEYS.AMAZON_LOGIN_USERNAME]: options.clientEmail || "",
                [STORAGE_KEYS.USER_EMAIL]: "",
                [STORAGE_KEYS.LEGACY_USER_EMAIL]: "",
                [STORAGE_KEYS.DETECTED_EMAILS]: options.detectedEmails || [],
            };
            if (Array.isArray(keys)) {
                return keys.reduce((result, key) => {
                    if (Object.prototype.hasOwnProperty.call(values, key)) result[key] = values[key];
                    return result;
                }, {});
            }
            return Object.prototype.hasOwnProperty.call(values, keys) ? { [keys]: values[keys] } : {};
        }),
        setLocal: vi.fn(async values => {
            storageWrites.push(values);
        }),
        removeLocal: vi.fn(async () => {}),
    };

    const log = vi.fn();
    log.event = log;
    log.log = log;
    log.info = vi.fn();
    log.warn = vi.fn();
    log.error = vi.fn();
    log.debug = vi.fn();
    log.trace = vi.fn();
    globalThis.AMZ_LOGGER = { create: () => log };
    globalThis.AMZ_NOTIFICATIONS = {
        emit: vi.fn(() => Promise.resolve({ ok: true, queued: true })),
    };

    let createApplicationCount = 0;
    let updateApplicationCount = 0;
    globalThis.fetch = vi.fn(async (url, requestOptions = {}) => {
        if (String(url).includes("/get-schedule-details/")) {
            if (options.scheduleUnavailable === true) {
                return jsonResponse(200, {
                    data: {
                        scheduleId: "SCH-1",
                        scheduleStatus: "SELECTED_SCHEDULE_NOT_AVAILABLE",
                    },
                });
            }
            return jsonResponse(200, {
                data: {
                    scheduleId: "SCH-1",
                    scheduleStatus: "AVAILABLE",
                    state: "ON",
                    employmentType: "Seasonal",
                },
            });
        }
        if (String(url).includes("/get-all-schedules/JOB-1")) {
            if (options.otherSchedulesAvailable === true) {
                return jsonResponse(200, {
                    data: {
                        availableSchedules: {
                            total: 1,
                            schedules: [
                                {
                                    scheduleId: "SCH-2",
                                    scheduleStatus: "AVAILABLE",
                                },
                            ],
                        },
                    },
                });
            }
            return jsonResponse(200, {
                data: {
                    availableSchedules: {
                        total: 0,
                        schedules: [],
                    },
                },
            });
        }
        if (String(url).includes("/application/api/job/JOB-1")) {
            return jsonResponse(200, {
                data: {
                    jobId: "JOB-1",
                    dspEnabled: options.jobDspEnabled ?? true,
                    partitionAttributes: {
                        countryCodes: ["CA"],
                        ownerOrgs: ["AMZL"],
                    },
                },
            });
        }
        if (String(url).includes("/ds/create-application/")) {
            createApplicationCount += 1;
            const body = requestOptions.body ? JSON.parse(requestOptions.body) : {};
            const withoutSchedule = !Object.prototype.hasOwnProperty.call(body, "scheduleId");
            if (withoutSchedule && options.fallbackCreateAlreadyExists === true) {
                return jsonResponse(200, {
                    data: {
                        errorCode: "APPLICATION_ALREADY_EXIST",
                        errorMessage: "Application already exists.",
                    },
                });
            }
            return jsonResponse(200, {
                    data: {
                        applicationId: withoutSchedule
                            ? "application-without-schedule-1"
                            : `application-${createApplicationCount}`,
                        candidateId: "candidate-1",
                        currentState: "APPLICATION_CREATED",
                        dspEnabled: body.dspEnabled,
                    },
                });
            }
        if (String(url).includes("/update-workflow-step-name")) {
            return jsonResponse(200, {
                data: {
                    currentState: "JOB_SELECTED",
                    jobScheduleSelected: {
                        scheduleId: "SCH-1",
                    },
                    workflowStepName: "\"general-questions\"",
                },
            });
        }
        if (String(url).includes("/update-application")) {
            updateApplicationCount += 1;
            if (options.confirmUnavailableAfterSuccess === true && updateApplicationCount > 1) {
                return jsonResponse(200, {
                    data: {
                        errorCode: "SELECTED_SCHEDULE_NOT_AVAILABLE",
                        errorMessage: "The schedule you have selected is no longer available.",
                    },
                });
            }
            if (options.confirmApplicationCreatedNoSchedule === true) {
                return jsonResponse(200, {
                    data: {
                        applicationId: "application-1",
                        currentState: "APPLICATION_CREATED",
                    },
                });
            }
            if (options.confirmThinSuccess === true) {
                return jsonResponse(200, {
                    data: {
                        applicationId: "application-1",
                    },
                });
            }
            if (options.confirmJobSelected === true) {
                return jsonResponse(200, {
                    data: {
                        currentState: "JOB_SELECTED",
                        jobScheduleSelected: {
                            scheduleId: "SCH-1",
                        },
                        workflowStepName: "\"job-opportunities\"",
                    },
                });
            }
            if (options.confirmUnavailable === true) {
                return jsonResponse(200, {
                    data: {
                        errorCode: "SELECTED_SCHEDULE_NOT_AVAILABLE",
                        errorMessage: "The schedule you have selected is no longer available.",
                    },
                });
            }
            return jsonResponse(
                DIRECT_APPLICATION.WAF.CAPTCHA_HTTP_STATUS,
                { message: "captcha required" },
                { [DIRECT_APPLICATION.WAF.CAPTCHA_HEADER_NAME]: DIRECT_APPLICATION.WAF.CAPTCHA_HEADER_VALUE }
            );
        }
        if (String(url).includes("/applications/application-1")) {
            if (options.applicationDetailsUnavailable === true) {
                return jsonResponse(404, {
                    data: {
                        errorCode: "APPLICATION_NOT_FOUND",
                        errorMessage: "Application details unavailable.",
                    },
                });
            }
            return jsonResponse(200, {
                data: {
                    currentState: "JOB_SELECTED",
                    jobScheduleSelected: {
                        scheduleId: "SCH-1",
                    },
                    workflowStepName: "\"general-questions\"",
                },
            });
        }
        if (String(url).includes("/applications/reserved/")) {
            if (options.reservedWithoutSchedule === true) {
                return jsonResponse(200, {
                    data: {
                        currentState: "JOB_SELECTED",
                        workflowStepName: "\"job-opportunities\"",
                    },
                });
            }
            return jsonResponse(200, {
                data: {
                    currentState: "JOB_SELECTED",
                    jobScheduleSelected: {
                        scheduleId: "SCH-1",
                    },
                    workflowStepName: "\"job-opportunities\"",
                },
            });
        }
        if (String(url).includes("/application/api/config/")) {
            return jsonResponse(200, {
                data: options.workflowConfig || {
                    stepFunctionEndpoint: "wss://workflow.test/{applicationId}/{candidateId}",
                },
            });
        }
        throw new Error(`Unexpected fetch: ${url}`);
    });

    const sentSocketMessages = [];
    class FakeWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            if (options.workflowSocketStalls === true) return;
            setTimeout(() => {
                this.readyState = 1;
                this.onopen?.();
            }, 0);
        }
        send(message) {
            sentSocketMessages.push({ url: this.url, message });
        }
        close() {
            this.readyState = 3;
            this.onclose?.();
        }
    }
    if (options.workflowWebSocketEnabled === true) {
        dom.window.WebSocket = FakeWebSocket;
        globalThis.WebSocket = FakeWebSocket;
    }

    const { MESSAGE_TYPES } = DIRECT_APPLICATION.WAF;
    const pendingCaptchaRequests = [];
    const dispatchCaptchaResult = (request, result = {}) => {
        if (!request) return false;
        dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
            source: dom.window,
            data: {
                type: MESSAGE_TYPES.CAPTCHA_RESULT,
                requestId: request.requestId,
                ok: result.ok === true,
                reason: result.reason || "captcha-render-failed",
                errorMessage: result.errorMessage || "captcha could not render",
            },
        }));
        return true;
    };

    dom.window.postMessage = vi.fn(message => {
        if (message?.type === MESSAGE_TYPES.BRIDGE_PING) {
            setTimeout(() => {
                dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
                    source: dom.window,
                    data: {
                        type: MESSAGE_TYPES.BRIDGE_READY,
                        requestId: message.requestId,
                        ok: true,
                        alreadyReady: true,
                    },
                }));
            }, 0);
            return;
        }

        if (message?.type === MESSAGE_TYPES.REQUEST_TOKEN) {
            setTimeout(() => {
                dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
                    source: dom.window,
                    data: {
                        type: MESSAGE_TYPES.TOKEN_RESULT,
                        requestId: message.requestId,
                        ok: true,
                        reason: "token-ready",
                    },
                }));
            }, 0);
            return;
        }

        if (message?.type === MESSAGE_TYPES.REQUEST_CAPTCHA) {
            if (options.holdCaptcha === true) {
                pendingCaptchaRequests.push(message);
                return;
            }
            setTimeout(() => {
                dispatchCaptchaResult(message);
            }, 0);
        }
    });

    return {
        storageWrites,
        notifications: globalThis.AMZ_NOTIFICATIONS,
        runtimeState,
        sentSocketMessages,
        audioPlays,
        pendingCaptchaCount: () => pendingCaptchaRequests.length,
        completeCaptcha: (result = {}) => dispatchCaptchaResult(pendingCaptchaRequests.shift(), result),
    };
}

function loadDirectApplicationScripts() {
    loadSharedScripts([
        "content/utils/alerts.js",
        "content/utils/direct-application-api.js",
        "content/utils/direct-application-guard.js",
        "content/utils/direct-application-mode.js",
        "content/utils/direct-application-waf.js",
        "content/utils/direct-application.js",
    ]);
}

describe("Direct application workflow", () => {
    beforeEach(() => {
        unloadSharedNamespaces([
            "AMZ_CONSTANTS",
            "AMZ_DIRECT_API",
            "AMZ_DIRECT_APPLICATION",
            "AMZ_DIRECT_GUARD",
            "AMZ_DIRECT_APPLICATION_MODE",
            "AMZ_DIRECT_WAF",
            "AMZ_APPLICATION_OBSERVABILITY",
            "AMZ_ALERTS",
            "AMZ_URL",
        ]);
    });

    afterEach(async () => {
        await flush();
        await flush();
        if (globalThis.window?.close) {
            globalThis.window.close();
        }
        delete globalThis.window;
        delete globalThis.document;
        delete globalThis.localStorage;
        delete globalThis.sessionStorage;
        delete globalThis.AMZ_STORAGE;
        delete globalThis.AMZ_LOGGER;
        delete globalThis.AMZ_NOTIFICATIONS;
        delete globalThis.Audio;
        delete globalThis.WebSocket;
        vi.restoreAllMocks();
        unloadSharedNamespaces([
            "AMZ_CONSTANTS",
            "AMZ_DIRECT_API",
            "AMZ_DIRECT_APPLICATION",
            "AMZ_DIRECT_GUARD",
            "AMZ_DIRECT_APPLICATION_MODE",
            "AMZ_DIRECT_WAF",
            "AMZ_APPLICATION_OBSERVABILITY",
            "AMZ_ALERTS",
            "AMZ_URL",
        ]);
    });

    it("marks failed post-create CAPTCHA recovery as captcha-failed", async () => {
        const { storageWrites, notifications, audioPlays } = setupDirectApplicationHarness({
            useDirectApplication: true,
        });
        const { DIRECT_APPLICATION, NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;

        loadDirectApplicationScripts();

        await waitFor(() => {
            const result = storageWrites
                .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
                .filter(Boolean)
                .at(-1);
            return result?.stage === DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED;
        });

        const result = storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .at(-1);

        expect(result).toMatchObject({
            stage: DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED,
            applicationId: "application-1",
            candidateId: "candidate-1",
            fallbackAllowed: false,
            captchaReason: "captcha-render-failed",
            errorClassification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED,
        });
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_FAILED,
            expect.objectContaining({
                applicationId: "application-1",
                errorClassification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED,
                redirectUrl: null,
            }),
            expect.any(Object)
        );
        const postMessageTypes = globalThis.window.postMessage.mock.calls
            .map(([message]) => message?.type);
        expect(postMessageTypes.indexOf(DIRECT_APPLICATION.WAF.MESSAGE_TYPES.BRIDGE_PING))
            .toBeLessThan(postMessageTypes.indexOf(DIRECT_APPLICATION.WAF.MESSAGE_TYPES.REQUEST_CAPTCHA));
        await waitFor(() => audioPlays.includes("assets/sounds/alert.wav"));
    });

    it("does not call direct APIs when useDirectApplication is false", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: false,
        });

        loadDirectApplicationScripts();
        await flush();

        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(storageWrites).toEqual([]);
        expect(notifications.emit).not.toHaveBeenCalled();
    });

    it("records country application form routes and keeps automation active without direct APIs", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            url: "https://hiring.amazon.com/application/us/?country=us&jobId=JOB-1&scheduleId=SCH-1#/general-questions?country=us&jobId=JOB-1&scheduleId=SCH-1&applicationId=app-1",
        });
        const { NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const recordApplicationFormOpened = vi.fn(async () => ({ ok: true, status: 201 }));
        globalThis.AMZ_APPLICATION_OBSERVABILITY = {
            recordApplicationFormOpened,
            finalizePendingDeactivated: vi.fn(),
        };

        loadDirectApplicationScripts();

        await waitFor(() => recordApplicationFormOpened.mock.calls.length > 0);

        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(recordApplicationFormOpened).toHaveBeenCalledWith(
            expect.objectContaining({
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "app-1",
            }),
            expect.objectContaining({
                route: "general-questions",
                source: "application-form-route",
                terminal: true,
                outcome: "BOOKED",
            })
        );
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.FORM_OPENED,
            expect.objectContaining({
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "app-1",
                currentState: "APPLICATION_FORM_OPENED",
                mode: "direct",
                workflowStepName: "general-questions",
                redirectUrl: expect.stringContaining("#/general-questions?"),
            }),
            expect.any(Object)
        );
        expect(storageWrites).not.toContainEqual({
            [STORAGE_KEYS.ACTIVE]: false,
        });

        await globalThis.AMZ_DIRECT_APPLICATION.run("repeat-final-form-route");
        await flush();

        expect(recordApplicationFormOpened).toHaveBeenCalledTimes(1);
        expect(notifications.emit.mock.calls.filter(([event]) =>
            event === NOTIFICATIONS.EVENTS.FORM_OPENED
        )).toHaveLength(1);
    });

    it("emits final manual success when the Amazon application form opens", async () => {
        const { notifications } = setupDirectApplicationHarness({
            useDirectApplication: false,
            url: "https://hiring.amazon.ca/application/ca/?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1#/general-questions?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1",
        });
        const { NOTIFICATIONS } = globalThis.AMZ_CONSTANTS;
        const recordApplicationFormOpened = vi.fn(async () => ({ ok: true, status: 201 }));
        globalThis.AMZ_APPLICATION_OBSERVABILITY = {
            recordApplicationFormOpened,
            finalizePendingDeactivated: vi.fn(),
        };

        loadDirectApplicationScripts();

        await waitFor(() => notifications.emit.mock.calls.length >= 2);

        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(recordApplicationFormOpened).toHaveBeenCalledWith(
            expect.objectContaining({
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "app-1",
            }),
            expect.objectContaining({
                route: "general-questions",
                source: "application-form-route",
                terminal: true,
                outcome: "BOOKED",
            })
        );
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            expect.objectContaining({
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "app-1",
                currentState: "APPLICATION_FORM_OPENED",
                selectedScheduleId: "SCH-1",
                mode: "manual",
                workflowStepName: "general-questions",
                redirectUrl: expect.stringContaining("#/general-questions?"),
            }),
            expect.any(Object)
        );
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.FORM_OPENED,
            expect.objectContaining({
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "app-1",
                currentState: "APPLICATION_FORM_OPENED",
                selectedScheduleId: "SCH-1",
                mode: "manual",
                workflowStepName: "general-questions",
                redirectUrl: expect.stringContaining("#/general-questions?"),
            }),
            expect.any(Object)
        );
    });

    it("does not repeatedly redirect an already confirmed application while the form shell settles", async () => {
        setupDirectApplicationHarness({
            useDirectApplication: true,
            redirectAfterSuccess: true,
            url: "https://hiring.amazon.ca/application/ca/?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1",
        });
        const { DIRECT_APPLICATION } = globalThis.AMZ_CONSTANTS;
        globalThis.sessionStorage.setItem(
            [
                DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
                "JOB-1",
                "SCH-1",
            ].join("::"),
            JSON.stringify({
                stage: DIRECT_APPLICATION.STAGES.JOB_CONFIRMED,
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "app-1",
                confirmedScheduleId: "SCH-1",
                currentState: "JOB_SELECTED",
            })
        );
        const realWindowSetTimeout = globalThis.window.setTimeout.bind(globalThis.window);
        const redirectSchedules = [];
        globalThis.window.setTimeout = (callback, delay, ...args) => {
            if (String(callback).includes("window.location.assign")) {
                redirectSchedules.push({ delay });
                return 0;
            }
            return realWindowSetTimeout(callback, delay, ...args);
        };

        loadDirectApplicationScripts();

        await waitFor(() => redirectSchedules.length === 1);
        await globalThis.AMZ_DIRECT_APPLICATION.run("repeat-terminal-success-route");
        await flush();

        expect(redirectSchedules).toHaveLength(1);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("suppresses stale unavailable failures after the same application is already booked", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmJobSelected: true,
            confirmUnavailableAfterSuccess: true,
        });
        const { DIRECT_APPLICATION, NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;

        loadDirectApplicationScripts();

        await waitFor(() => notifications.emit.mock.calls.some(([event]) =>
            event === NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED
        ));
        globalThis.sessionStorage.setItem(
            [
                DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
                "JOB-1",
                "SCH-1",
            ].join("::"),
            JSON.stringify({
                stage: DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM,
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "application-1",
                currentState: "APPLICATION_CREATED",
            })
        );

        await globalThis.AMZ_DIRECT_APPLICATION.run("stale-confirm-after-success");
        await flush();

        expect(notifications.emit.mock.calls.some(([event]) =>
            event === NOTIFICATIONS.EVENTS.BOOKING_FAILED
        )).toBe(false);
        expect(storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result =>
                result.stage === DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WITHOUT_SCHEDULE &&
                result.errorCode === "SELECTED_SCHEDULE_NOT_AVAILABLE"
            )
        ).toBe(false);
    });

    it("warms WAF tokens without blocking create and confirm APIs", async () => {
        setupDirectApplicationHarness({
            useDirectApplication: true,
        });
        const { MESSAGE_TYPES } = globalThis.AMZ_CONSTANTS.DIRECT_APPLICATION.WAF;

        loadDirectApplicationScripts();

        await waitFor(() => globalThis.window.postMessage.mock.calls
            .map(([message]) => message)
            .filter(message => message?.type === MESSAGE_TYPES.REQUEST_TOKEN)
            .length >= 2);

        const tokenRequests = globalThis.window.postMessage.mock.calls
            .map(([message]) => message)
            .filter(message => message?.type === MESSAGE_TYPES.REQUEST_TOKEN);
        expect(tokenRequests.length).toBeGreaterThanOrEqual(2);
        expect(tokenRequests[0]).toEqual(expect.objectContaining({
            type: MESSAGE_TYPES.REQUEST_TOKEN,
            sdkUrl: expect.any(String),
            sdkLoadTimeoutMs: expect.any(Number),
        }));
        expect(tokenRequests.some(request => request.preferRefresh === true)).toBe(true);
        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/get-schedule-details/")
        )).toBe(true);
        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/ds/create-application/")
        )).toBe(true);
        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/update-application")
        )).toBe(true);
    });

    it("emits success after JOB_SELECTED with matching schedule without waiting for reservation observability", async () => {
        const { storageWrites, notifications, audioPlays } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmJobSelected: true,
            clientEmail: "client-attempt@example.com",
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS, NOTIFICATIONS } = globalThis.AMZ_CONSTANTS;
        notifications.emit.mockImplementation(() => new Promise(() => {}));

        loadDirectApplicationScripts();

        await waitFor(() => {
            return storageWrites
                .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
                .filter(Boolean)
                .some(result => result.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED);
        });

        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            expect.objectContaining({
                applicationId: "application-1",
                currentState: "JOB_SELECTED",
                clientEmail: "client-attempt@example.com",
                mode: "direct",
                redirectUrl: expect.stringContaining("#/general-questions?"),
            }),
            expect.any(Object)
        );
        const successPayload = notifications.emit.mock.calls
            .find(([event]) => event === NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED)?.[1];
        expect(successPayload.redirectUrl).toContain("applicationId=application-1");
        expect(successPayload.redirectUrl).toContain("scheduleId=SCH-1");
        expect(successPayload.redirectUrl).not.toContain("#/consent?");
        expect(successPayload.redirectUrl).not.toContain("/app#/myApplications");
        await waitFor(() => Boolean(globalThis.document.querySelector(".amazon-booking-confirmed-toast")));
        expect(globalThis.document.querySelector(".amazon-booking-confirmed-toast").textContent)
            .toContain("Booking confirmed");
        await waitFor(() => audioPlays.includes("assets/sounds/alert.wav"));
    });

    it("emits success before post-confirm workflow websocket observability finishes", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmJobSelected: true,
            workflowWebSocketEnabled: true,
            workflowSocketStalls: true,
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS, NOTIFICATIONS } = globalThis.AMZ_CONSTANTS;

        loadDirectApplicationScripts();

        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result => result.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED)
        );

        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            expect.objectContaining({
                applicationId: "application-1",
                currentState: "JOB_SELECTED",
            }),
            expect.any(Object)
        );
        expect(storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result => result.stage === DIRECT_APPLICATION.STAGES.WORKFLOW_WS_COMPLETED)
        ).toBe(false);
    });

    it("rehydrates and updates workflow before redirecting confirmed schedules to the form", async () => {
        const { storageWrites, notifications, audioPlays } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmJobSelected: true,
            redirectAfterSuccess: true,
            url: "https://hiring.amazon.ca/application/ca/?country=ca&locale=en-CA&jobId=JOB-1&scheduleId=SCH-1&token=secret",
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS, NOTIFICATIONS } = globalThis.AMZ_CONSTANTS;
        const realWindowSetTimeout = globalThis.window.setTimeout.bind(globalThis.window);
        const redirectSchedules = [];
        globalThis.window.setTimeout = (callback, delay, ...args) => {
            if (String(callback).includes("window.location.assign")) {
                redirectSchedules.push({
                    delay,
                    fetchCount: globalThis.fetch.mock.calls.length,
                });
                return 0;
            }
            return realWindowSetTimeout(callback, delay, ...args);
        };

        loadDirectApplicationScripts();

        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result => result.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED)
        );
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            expect.objectContaining({
                applicationId: "application-1",
                redirectUrl: expect.stringContaining("#/general-questions?"),
            }),
            expect.any(Object)
        );
        const successPayload = notifications.emit.mock.calls
            .find(([event]) => event === NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED)?.[1];
        expect(successPayload.redirectUrl).toContain("applicationId=application-1");
        expect(successPayload.redirectUrl).toContain("scheduleId=SCH-1");
        expect(successPayload.redirectUrl).not.toContain("#/consent?");
        expect(successPayload.redirectUrl).not.toContain("/app#/myApplications");
        const createBody = JSON.parse(globalThis.fetch.mock.calls
            .find(call => String(call[0]).includes("/ds/create-application/"))[1].body);
        expect(createBody).toEqual(expect.objectContaining({
            jobId: "JOB-1",
            scheduleId: "SCH-1",
        }));
        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/update-application")
        )).toBe(true);
        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result =>
                result.stage === DIRECT_APPLICATION.STAGES.WORKFLOW_UPDATED &&
                result.formHandoff === true
            )
        );
        await waitFor(() => redirectSchedules.length === 1);
        const preRedirectFetches = globalThis.fetch.mock.calls
            .slice(0, redirectSchedules[0].fetchCount)
            .map(call => String(call[0]));
        expect(preRedirectFetches.filter(url =>
            url.includes("/application/api/candidate-application/applications/application-1")
        )).toHaveLength(2);
        expect(preRedirectFetches.some(url =>
            url.includes("/application/api/candidate-application/update-workflow-step-name")
        )).toBe(true);
        await waitFor(() => audioPlays.includes("assets/sounds/alert.wav"));
    });

    it("treats thin 200 job-confirm responses as provisional and verifies reservation before success", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmThinSuccess: true,
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS, NOTIFICATIONS } = globalThis.AMZ_CONSTANTS;

        loadDirectApplicationScripts();

        await waitFor(() => {
            return storageWrites
                .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
                .filter(Boolean)
                .some(result => result.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED);
        });

        const confirmedResult = storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .find(result => result.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED);

        expect(confirmedResult).toEqual(expect.objectContaining({
            provisionalConfirm: true,
            currentState: "JOB_SELECTED",
            confirmedScheduleId: "SCH-1",
        }));
        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/applications/application-1")
        )).toBe(true);
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            expect.objectContaining({
                applicationId: "application-1",
                currentState: "JOB_SELECTED",
            }),
            expect.any(Object)
        );
    });

    it("falls back to reserved application verification if official application details is unavailable", async () => {
        const { storageWrites } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmThinSuccess: true,
            applicationDetailsUnavailable: true,
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;

        loadDirectApplicationScripts();

        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result => result.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED)
        );

        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/applications/application-1")
        )).toBe(true);
        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/applications/reserved/application-1")
        )).toBe(true);
    });

    it("continues provisional confirm when reserved application details are stale", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmThinSuccess: true,
            applicationDetailsUnavailable: true,
            reservedWithoutSchedule: true,
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS, NOTIFICATIONS } = globalThis.AMZ_CONSTANTS;

        loadDirectApplicationScripts();

        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(entry => entry.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED)
        );

        const verificationResult = storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .find(entry => entry.stage === DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED);

        expect(verificationResult).toEqual(expect.objectContaining({
            errorClassification:
                DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
            nonBlockingProvisional: true,
            fallbackAllowed: false,
        }));
        const confirmedResult = storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .find(entry => entry.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED);
        expect(confirmedResult).toEqual(expect.objectContaining({
            currentState: "JOB_SELECTED",
            confirmedScheduleId: "SCH-1",
            provisionalConfirm: true,
            provisionalScheduleFallback: true,
        }));
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            expect.objectContaining({
                currentState: "JOB_SELECTED",
                selectedScheduleId: "SCH-1",
            }),
            expect.any(Object)
        );
    });

    it("opens the final form route for application-created job-confirm bodies", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmApplicationCreatedNoSchedule: true,
            applicationDetailsUnavailable: true,
            reservedWithoutSchedule: true,
            redirectAfterSuccess: true,
            url: "https://hiring.amazon.ca/application/ca/?country=ca&locale=en-CA&jobId=JOB-1&scheduleId=SCH-1",
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS, NOTIFICATIONS } = globalThis.AMZ_CONSTANTS;
        const realWindowSetTimeout = globalThis.window.setTimeout.bind(globalThis.window);
        const redirectSchedules = [];
        globalThis.window.setTimeout = (callback, delay, ...args) => {
            if (String(callback).includes("window.location.assign")) {
                redirectSchedules.push({
                    delay,
                    fetchCount: globalThis.fetch.mock.calls.length,
                });
                return 0;
            }
            return realWindowSetTimeout(callback, delay, ...args);
        };

        loadDirectApplicationScripts();

        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result =>
                result.stage === DIRECT_APPLICATION.STAGES.WORKFLOW_UPDATED &&
                result.formHandoff === true
            )
        );
        await waitFor(() => redirectSchedules.length === 1);

        const confirmedResult = storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .find(result => result.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED);
        expect(confirmedResult).toEqual(expect.objectContaining({
            currentState: "JOB_SELECTED",
            confirmedScheduleId: "SCH-1",
            provisionalConfirm: true,
            provisionalScheduleFallback: true,
        }));
        const successPayload = notifications.emit.mock.calls
            .find(([event]) => event === NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED)?.[1];
        expect(successPayload).toEqual(expect.objectContaining({
            applicationId: "application-1",
            currentState: "JOB_SELECTED",
            selectedScheduleId: "SCH-1",
        }));
        expect(successPayload.redirectUrl).toContain("#/general-questions?");
        expect(successPayload.redirectUrl).toContain("applicationId=application-1");
        expect(successPayload.redirectUrl).toContain("scheduleId=SCH-1");
        expect(successPayload.redirectUrl).not.toContain("#/consent?");
        expect(successPayload.redirectUrl).not.toContain("/app#/myApplications");
        const preRedirectFetches = globalThis.fetch.mock.calls
            .slice(0, redirectSchedules[0].fetchCount)
            .map(call => String(call[0]));
        expect(preRedirectFetches.some(url =>
            url.includes("/application/api/candidate-application/update-workflow-step-name")
        )).toBe(true);
    });

    it("sends official-style workflow websocket messages after verified success", async () => {
        const { storageWrites, sentSocketMessages } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmJobSelected: true,
            workflowWebSocketEnabled: true,
            url: "https://hiring.amazon.ca/application/?country=ca&locale=en-CA&jobId=JOB-1&scheduleId=SCH-1&token=route-token",
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;

        loadDirectApplicationScripts();

        await waitFor(() => sentSocketMessages.length >= 2);
        await waitFor(() => storageWrites
            .map(write => write[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result => result.stage === globalThis.AMZ_CONSTANTS.DIRECT_APPLICATION.STAGES.WORKFLOW_WS_COMPLETED)
        );

        const actions = sentSocketMessages.map(entry => JSON.parse(entry.message).action);
        expect(actions).toEqual(["startWorkflow", "completeTask"]);
        expect(JSON.parse(sentSocketMessages[0].message)).toEqual(expect.objectContaining({
            applicationId: "application-1",
            candidateId: "candidate-1",
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            partitionAttributes: {
                countryCodes: ["CA"],
                ownerOrgs: ["AMZL"],
            },
        }));
        expect(new URL(sentSocketMessages[0].url).searchParams.get("authToken"))
            .toBe("route-token");
        expect(JSON.parse(sentSocketMessages[1].message)).toEqual(expect.objectContaining({
            eventSource: "HVH-CA-UI",
            currentWorkflowStep: "job-opportunities",
            state: "ON",
            employmentType: "Seasonal",
        }));
        expect(storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result => result.stage === DIRECT_APPLICATION.STAGES.WORKFLOW_WS_COMPLETED)
        ).toBe(true);
    });

    it("decorates workflow websocket URLs with official auth fallback and ASO organization id", async () => {
        const { sentSocketMessages } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmJobSelected: true,
            workflowWebSocketEnabled: true,
            workflowConfig: {
                CSDomain: "https://workflow-domain.test",
                stepFunctionQueryPath:
                    "/step-function?applicationId={applicationId}&candidateId={candidateId}",
                stepFunctionEndpoint: "wss://workflow-fallback.test/{applicationId}/{candidateId}",
            },
        });
        globalThis.sessionStorage.setItem("organization", JSON.stringify({
            organizationId: "aso-123",
            staffingOrganizationType: "ASO",
        }));
        globalThis.sessionStorage.setItem("query-params", JSON.stringify({
            bypasscorp: "true",
        }));

        loadDirectApplicationScripts();

        await waitFor(() => sentSocketMessages.length >= 2);

        const socketUrl = new URL(sentSocketMessages[0].url);
        expect(socketUrl.origin).toBe("wss://workflow-domain.test");
        expect(socketUrl.pathname).toBe("/step-function");
        expect(socketUrl.searchParams.get("applicationId")).toBe("application-1");
        expect(socketUrl.searchParams.get("candidateId")).toBe("candidate-1");
        expect(socketUrl.searchParams.get("authToken")).toBe("dummy");
        expect(socketUrl.searchParams.get("asoId")).toBe("aso-123");
        expect(socketUrl.searchParams.get("bypasscorp")).toBe("true");
        expect(socketUrl.searchParams.get("asoId")).not.toContain("staffingOrganizationType");
    });

    it("starts direct APIs when manual mode is switched to automated without a refresh", async () => {
        let storageListener = null;
        const { runtimeState } = setupDirectApplicationHarness({
            useDirectApplication: true,
            storedUseDirectApplication: false,
        });
        chrome.storage.onChanged.addListener = vi.fn(listener => {
            storageListener = listener;
        });

        loadDirectApplicationScripts();
        await flush();
        expect(globalThis.fetch).not.toHaveBeenCalled();

        runtimeState.useDirectApplication = true;
        storageListener({
            [globalThis.AMZ_CONSTANTS.STORAGE_KEYS.USE_DIRECT_APPLICATION]: {
                oldValue: false,
                newValue: true,
            },
        }, "local");

        await waitFor(() => globalThis.fetch.mock.calls.length > 0);
    });

    it("starts direct APIs from the early application URL before the country route", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmJobSelected: true,
            url: "https://hiring.amazon.com/application/?jobId=JOB-1&page=pre-consent&scheduleId=SCH-1&locale=en-US&country=us&token=secret",
        });
        const { DIRECT_APPLICATION, NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;

        loadDirectApplicationScripts();

        await waitFor(() => {
            return storageWrites
                .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
                .filter(Boolean)
                .some(result => result.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED);
        });

        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/ds/create-application/")
        )).toBe(true);
        const successPayload = notifications.emit.mock.calls
            .find(([event]) => event === NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED)?.[1];
        expect(successPayload.redirectUrl)
            .toContain("https://hiring.amazon.com/application/us/");
        expect(successPayload.redirectUrl).toContain("#/general-questions?");
        expect(successPayload.redirectUrl).toContain("applicationId=application-1");
    });

    it("resumes direct confirmation when Amazon drops scheduleId on an applicationId route", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmJobSelected: true,
            url: "https://hiring.amazon.ca/application/ca/?applicationId=application-1&jobId=JOB-1&locale=en-CA",
        });
        const { DIRECT_APPLICATION, NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        globalThis.sessionStorage.setItem(
            [
                DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
                "JOB-1",
                "SCH-1",
            ].join("::"),
            JSON.stringify({
                stage: DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM,
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "application-1",
                candidateId: "candidate-1",
                currentState: "APPLICATION_CREATED",
            })
        );

        loadDirectApplicationScripts();

        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result => result.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED)
        );

        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/ds/create-application/")
        )).toBe(false);
        const confirmCall = globalThis.fetch.mock.calls
            .find(call => String(call[0]).includes("/update-application"));
        expect(JSON.parse(confirmCall[1].body)).toEqual(expect.objectContaining({
            applicationId: "application-1",
            payload: expect.objectContaining({
                jobId: "JOB-1",
                scheduleId: "SCH-1",
            }),
        }));
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            expect.objectContaining({
                applicationId: "application-1",
                scheduleId: "SCH-1",
                redirectUrl: expect.stringContaining("scheduleId=SCH-1"),
            }),
            expect.any(Object)
        );
    });

    it("skips duplicate direct API work when another navigation context owns the attempt lock", async () => {
        const { storageWrites } = setupDirectApplicationHarness({
            useDirectApplication: true,
        });
        const { DIRECT_APPLICATION } = globalThis.AMZ_CONSTANTS;
        globalThis.sessionStorage.setItem(
            [
                DIRECT_APPLICATION.ATTEMPT_LOCK_STORAGE_PREFIX,
                "JOB-1",
                "SCH-1",
                "pending",
            ].join("::"),
            JSON.stringify({
                ownerId: "other-context",
                stage: "application-created-waiting-for-confirm",
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                updatedAt: Date.now(),
                expiresAt: Date.now() + DIRECT_APPLICATION.ACTIVE_ATTEMPT_LOCK_TTL_MS,
            })
        );

        loadDirectApplicationScripts();
        await flush();
        await flush();

        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(storageWrites).toEqual([]);
    });

    it("keeps the post-create guard resumable when WAF token updates arrive", async () => {
        const { storageWrites, pendingCaptchaCount, completeCaptcha } = setupDirectApplicationHarness({
            useDirectApplication: true,
            holdCaptcha: true,
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const guardKey = [
            DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
            "JOB-1",
            "SCH-1",
        ].join("::");

        loadDirectApplicationScripts();

        await waitFor(() => {
            return storageWrites
                .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
                .filter(Boolean)
                .some(result =>
                    result.stage === DIRECT_APPLICATION.STAGES.WAF_TOKEN_READY &&
                    result.applicationId === "application-1"
                ) && pendingCaptchaCount() > 0;
        });

        const guard = JSON.parse(globalThis.sessionStorage.getItem(guardKey));
        expect(guard).toEqual(expect.objectContaining({
            applicationId: "application-1",
        }));
        expect(guard.stage).not.toBe(DIRECT_APPLICATION.STAGES.WAF_TOKEN_READY);
        expect(DIRECT_APPLICATION.UI_FALLBACK_SUPPRESSION_STAGES).toContain(guard.stage);

        expect(completeCaptcha()).toBe(true);
        await waitFor(() => {
            const result = storageWrites
                .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
                .filter(Boolean)
                .at(-1);
            return result?.stage === DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED;
        });
    });

    it("marks post-create SELECTED_SCHEDULE_NOT_AVAILABLE unavailable before returning to search", async () => {
        const { storageWrites } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmUnavailable: true,
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;

        loadDirectApplicationScripts();

        await waitFor(() => {
            const result = storageWrites
                .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
                .filter(Boolean)
                .at(-1);
            return result?.stage === DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WITHOUT_SCHEDULE &&
                result?.postCreateConfirmFailed === true;
        });

        const wildcardCooldown = JSON.parse(globalThis.sessionStorage.getItem(
            [
                DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_STORAGE_PREFIX,
                "JOB-1",
                "*",
            ].join("::")
        ));
        const exactCooldown = JSON.parse(globalThis.sessionStorage.getItem(
            [
                DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_STORAGE_PREFIX,
                "JOB-1",
                "SCH-1",
            ].join("::")
        ));

        expect(wildcardCooldown).toEqual(expect.objectContaining({
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            applicationId: "application-1",
            errorCode: "SELECTED_SCHEDULE_NOT_AVAILABLE",
        }));
        expect(exactCooldown).toEqual(expect.objectContaining({
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            applicationId: "application-1",
            errorCode: "SELECTED_SCHEDULE_NOT_AVAILABLE",
        }));
    });

    it("returns to job search when post-create job-confirm cannot keep the selected schedule", async () => {
        const { storageWrites, notifications, audioPlays } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmUnavailable: true,
            otherSchedulesAvailable: true,
            redirectAfterSuccess: true,
        });
        const { DIRECT_APPLICATION, NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const realWindowSetTimeout = globalThis.window.setTimeout.bind(globalThis.window);
        globalThis.window.setTimeout = (callback, delay, ...args) => {
            if (String(callback).includes("window.location.assign")) return 0;
            return realWindowSetTimeout(callback, delay, ...args);
        };

        loadDirectApplicationScripts();

        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result =>
                    result.stage === DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WITHOUT_SCHEDULE
            )
        );

        const createBodies = globalThis.fetch.mock.calls
            .filter(call => String(call[0]).includes("/ds/create-application/"))
            .map(call => JSON.parse(call[1].body));
        expect(createBodies).toHaveLength(1);
        expect(createBodies[0]).toEqual(expect.objectContaining({
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            candidateId: "candidate-1",
            dspEnabled: true,
            activeApplicationCheckEnabled: true,
        }));
        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/get-all-schedules/JOB-1")
        )).toBe(false);
        expect(globalThis.sessionStorage.getItem("scheduleNotAvailable")).toBeNull();
        expect(JSON.parse(globalThis.sessionStorage.getItem([
            DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_STORAGE_PREFIX,
            "JOB-1",
            "SCH-1",
        ].join("::")))).toEqual(expect.objectContaining({
            applicationId: "application-1",
            errorCode: "SELECTED_SCHEDULE_NOT_AVAILABLE",
        }));
        const finalResult = storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .find(result =>
                result.stage === DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WITHOUT_SCHEDULE
            );
        expect(finalResult).toEqual(expect.objectContaining({
            applicationId: "application-1",
            postCreateConfirmFailed: true,
            withoutSelectedSchedule: true,
        }));
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_FAILED,
            expect.objectContaining({
                applicationId: "application-1",
                scheduleId: "SCH-1",
                errorCode: "SELECTED_SCHEDULE_NOT_AVAILABLE",
                errorClassification:
                    DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
                postCreateConfirmFailed: true,
                withoutSelectedSchedule: true,
                redirectUrl: "https://hiring.amazon.ca/app#/jobSearch",
            }),
            expect.any(Object)
        );
        const failurePayload = notifications.emit.mock.calls
            .find(([event]) => event === NOTIFICATIONS.EVENTS.BOOKING_FAILED)?.[1];
        expect(failurePayload.redirectUrl).toBe("https://hiring.amazon.ca/app#/jobSearch");
        expect(failurePayload.redirectUrl).not.toContain("#/consent?");
        expect(failurePayload.redirectUrl).not.toContain("/app#/myApplications");
        await waitFor(() => audioPlays.includes("assets/sounds/alert.wav"));
    });

    it("treats resumed JOB_SELECTED applications as confirmed instead of without-schedule fallback", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            confirmUnavailable: true,
            redirectAfterSuccess: true,
        });
        const { DIRECT_APPLICATION, NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const realWindowSetTimeout = globalThis.window.setTimeout.bind(globalThis.window);
        const redirectSchedules = [];
        globalThis.window.setTimeout = (callback, delay, ...args) => {
            if (String(callback).includes("window.location.assign")) {
                redirectSchedules.push({
                    delay,
                    fetchCount: globalThis.fetch.mock.calls.length,
                });
                return 0;
            }
            return realWindowSetTimeout(callback, delay, ...args);
        };
        globalThis.sessionStorage.setItem(
            [
                DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
                "JOB-1",
                "SCH-1",
            ].join("::"),
            JSON.stringify({
                stage: DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM,
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "application-1",
                candidateId: "candidate-1",
                currentState: "JOB_SELECTED",
                confirmedScheduleId: "SCH-1",
            })
        );

        loadDirectApplicationScripts();

        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result => result.stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED)
        );
        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result =>
                result.stage === DIRECT_APPLICATION.STAGES.WORKFLOW_UPDATED &&
                result.formHandoff === true &&
                result.resumedFromSelectedApplication === true
            )
        );
        await waitFor(() => redirectSchedules.length === 1);

        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            expect.objectContaining({
                applicationId: "application-1",
                currentState: "JOB_SELECTED",
                selectedScheduleId: "SCH-1",
            }),
            expect.any(Object)
        );
        const preRedirectFetches = globalThis.fetch.mock.calls
            .slice(0, redirectSchedules[0].fetchCount)
            .map(call => String(call[0]));
        expect(preRedirectFetches.some(url =>
            url.includes("/application/api/candidate-application/update-workflow-step-name")
        )).toBe(true);
    });

    it("goes silent on consent form routes without a schedule id", async () => {
        const { notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            url: "https://hiring.amazon.ca/application/ca/?jobId=JOB-1#/consent?jobId=JOB-1&locale=en-CA",
        });
        const { DIRECT_APPLICATION } = globalThis.AMZ_CONSTANTS;
        const toastKey = DIRECT_APPLICATION.GUARD_STORAGE_PREFIX + "::booking-confirmed-toast";
        globalThis.sessionStorage.setItem(
            toastKey,
            JSON.stringify({
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "application-1",
                currentState: "JOB_SELECTED",
                expiresAt: Date.now() + 60000,
            })
        );

        loadDirectApplicationScripts();
        await waitFor(() => globalThis.sessionStorage.getItem(toastKey) === null);

        expect(notifications.emit).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(globalThis.document.querySelector(".amazon-booking-confirmed-toast")).toBeNull();
        expect(globalThis.sessionStorage.getItem(toastKey)).toBeNull();
    });

    it("uses the same no-schedule fallback before create when schedule verification catches staleness", async () => {
        const { storageWrites } = setupDirectApplicationHarness({
            useDirectApplication: true,
            scheduleUnavailable: true,
            scheduleVerifyBeforeCreate: true,
            otherSchedulesAvailable: true,
        });
        const { DIRECT_APPLICATION, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;

        loadDirectApplicationScripts();

        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result =>
                result.stage === DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WITHOUT_SCHEDULE
            )
        );

        const createBodies = globalThis.fetch.mock.calls
            .filter(call => String(call[0]).includes("/ds/create-application/"))
            .map(call => JSON.parse(call[1].body));
        expect(createBodies).toEqual([
            {
                jobId: "JOB-1",
                dspEnabled: true,
                activeApplicationCheckEnabled: true,
            },
        ]);
        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/update-application")
        )).toBe(false);
    });

    it("routes to the official already-applied page when fallback create reports an existing application", async () => {
        const { storageWrites, notifications } = setupDirectApplicationHarness({
            useDirectApplication: true,
            scheduleUnavailable: true,
            scheduleVerifyBeforeCreate: true,
            otherSchedulesAvailable: true,
            fallbackCreateAlreadyExists: true,
            redirectAfterSuccess: true,
        });
        const { DIRECT_APPLICATION, NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const realWindowSetTimeout = globalThis.window.setTimeout.bind(globalThis.window);
        globalThis.window.setTimeout = (callback, delay, ...args) => {
            if (String(callback).includes("window.location.assign")) return 0;
            return realWindowSetTimeout(callback, delay, ...args);
        };

        loadDirectApplicationScripts();

        await waitFor(() => storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .some(result =>
                result.fallbackCreateFailed === true &&
                result.errorCode === "APPLICATION_ALREADY_EXIST"
            )
        );

        const fallbackCheck = storageWrites
            .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
            .filter(Boolean)
            .find(result => result.fallbackCreateFailed === true);
        expect(fallbackCheck).toEqual(expect.objectContaining({
            errorCode: "APPLICATION_ALREADY_EXIST",
            fallbackCreateFailed: true,
        }));
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_FAILED,
            expect.objectContaining({
                errorCode: "APPLICATION_ALREADY_EXIST",
                redirectUrl: expect.stringContaining("#/already-applied?"),
            }),
            expect.any(Object)
        );
        const failurePayload = notifications.emit.mock.calls
            .find(([event]) => event === NOTIFICATIONS.EVENTS.BOOKING_FAILED)?.[1];
        expect(failurePayload.redirectUrl).toContain("jobId=JOB-1");
        expect(failurePayload.redirectUrl).not.toContain("/app#/myApplications");
        expect(globalThis.sessionStorage.getItem([
            DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_STORAGE_PREFIX,
            "JOB-1",
            "SCH-1",
        ].join("::"))).toBeNull();
    });

    it("routes no-available-shift before create when the stale schedule has no alternatives", async () => {
        const { storageWrites, notifications, audioPlays } = setupDirectApplicationHarness({
            useDirectApplication: true,
            scheduleUnavailable: true,
            scheduleVerifyBeforeCreate: true,
            redirectAfterSuccess: true,
        });
        const { DIRECT_APPLICATION, NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const realWindowSetTimeout = globalThis.window.setTimeout.bind(globalThis.window);
        globalThis.window.setTimeout = (callback, delay, ...args) => {
            if (String(callback).includes("window.location.assign")) return 0;
            return realWindowSetTimeout(callback, delay, ...args);
        };

        loadDirectApplicationScripts();

        await waitFor(() => {
            const result = storageWrites
                .map(write => write[STORAGE_KEYS.DIRECT_APPLICATION_RESULT])
                .filter(Boolean)
                .at(-1);
            return result?.stage === DIRECT_APPLICATION.STAGES.SCHEDULE_UNAVAILABLE &&
                result?.noAvailableShift === true;
        });

        expect(globalThis.fetch.mock.calls.some(call =>
            String(call[0]).includes("/ds/create-application/")
        )).toBe(false);
        expect(notifications.emit).toHaveBeenCalledWith(
            NOTIFICATIONS.EVENTS.BOOKING_FAILED,
            expect.objectContaining({
                noAvailableShift: true,
                redirectUrl: expect.stringContaining("#/no-available-shift?"),
            }),
            expect.any(Object)
        );
        const failurePayload = notifications.emit.mock.calls
            .find(([event]) => event === NOTIFICATIONS.EVENTS.BOOKING_FAILED)?.[1];
        expect(failurePayload.redirectUrl).toContain("jobId=JOB-1");
        expect(failurePayload.redirectUrl).not.toContain("/app#/myApplications");
        expect(globalThis.sessionStorage.getItem([
            DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_STORAGE_PREFIX,
            "JOB-1",
            "SCH-1",
        ].join("::"))).toBeNull();
        await waitFor(() => audioPlays.includes("assets/sounds/alert.wav"));
    });
});
