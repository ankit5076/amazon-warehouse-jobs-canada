import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function setupBackgroundNotifications() {
    unloadSharedNamespaces([
        "AMZ_CONSTANTS",
        "AMZ_TEXT",
        "AMZ_URL",
        "AMZ_STORAGE",
        "AMZ_ACCOUNT",
        "AMZ_VALIDATION",
        "AMZ_API",
        "AMZ_TELEGRAM_CHANNEL",
        "AMZ_BACKGROUND_NOTIFICATIONS",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/text.js",
        "shared/utils/url.js",
    ]);

    const store = {};
    const sentTelegram = vi.fn().mockResolvedValue({ delivered: true, message_id: 42 });

    globalThis.AMZ_STORAGE = {
        getLocal: vi.fn(async keys => {
            if (Array.isArray(keys)) {
                return keys.reduce((values, key) => {
                    if (Object.prototype.hasOwnProperty.call(store, key)) values[key] = store[key];
                    return values;
                }, {});
            }
            return Object.prototype.hasOwnProperty.call(store, keys) ? { [keys]: store[keys] } : {};
        }),
        setLocal: vi.fn(async values => {
            Object.assign(store, values);
        }),
    };
    globalThis.AMZ_ACCOUNT = {
        getStoredOperatorUsername: vi.fn().mockResolvedValue("operator@example.com"),
        getStoredLoginUsername: vi.fn().mockResolvedValue("client@example.com"),
    };
    globalThis.AMZ_VALIDATION = {
        refreshFromServer: vi.fn().mockResolvedValue({
            valid: true,
            controls: { features: { telegram: true } },
        }),
    };
    globalThis.AMZ_API = {
        apiSendTelegramNotification: sentTelegram,
    };

    loadSharedScripts([
        "background/telegram.js",
        "background/notification-service.js",
    ]);

    return { store, sentTelegram };
}

describe("AMZ_NOTIFICATIONS content emitter", () => {
    beforeEach(() => {
        unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_TEXT", "AMZ_URL", "AMZ_MESSAGING", "AMZ_NOTIFICATIONS"]);
        loadSharedScripts([
            "shared/constants.js",
            "shared/utils/text.js",
            "shared/utils/url.js",
            "shared/utils/messaging.js",
            "shared/notifications.js",
        ]);
        globalThis.chrome.runtime.lastError = null;
    });

    it("normalizes events and strips sensitive URL data", () => {
        const event = globalThis.AMZ_NOTIFICATIONS.normalizeEvent(
            globalThis.AMZ_CONSTANTS.NOTIFICATIONS.EVENTS.BOOKING_FAILED,
            {
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                mode: "direct",
                pageUrl: "https://hiring.amazon.com/application/us/?jobId=JOB-1&scheduleId=SCH-1&token=secret#/general-questions?applicationId=app-1&jobId=JOB-1",
            }
        );

        expect(event).toMatchObject({
            eventName: "booking.failed",
            attemptId: "JOB-1::SCH-1",
            severity: "error",
            phase: "application",
            status: "failed",
            mode: "direct",
        });
        expect(event.pageUrl).not.toContain("token=");
        expect(event.pageUrl).not.toContain("applicationId=");
    });

    it("sends notification_event without waiting for channel delivery", async () => {
        const sendSpy = vi.fn((_message, callback) => {
            callback({ ok: true, result: { queued: true } });
        });
        globalThis.chrome.runtime.sendMessage = sendSpy;

        const result = await globalThis.AMZ_NOTIFICATIONS.emit(
            globalThis.AMZ_CONSTANTS.NOTIFICATIONS.EVENTS.JOB_FOUND,
            { jobId: "JOB-1" }
        );

        expect(result).toMatchObject({ ok: true, queued: true });
        expect(sendSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                action: globalThis.AMZ_CONSTANTS.MESSAGE_ACTIONS.NOTIFICATION_EVENT,
                event: expect.objectContaining({ eventName: "job_matched", jobId: "JOB-1" }),
            }),
            expect.any(Function)
        );
    });

    it("normalizes legacy dotted event names to observability-style names", () => {
        const jobEvent = globalThis.AMZ_NOTIFICATIONS.normalizeEvent("job.found", { jobId: "JOB-1" });
        const bookedEvent = globalThis.AMZ_NOTIFICATIONS.normalizeEvent("booking.succeeded", {
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            mode: "direct",
        });

        expect(jobEvent).toMatchObject({
            eventName: "job_matched",
            phase: "search",
            status: "succeeded",
            severity: "info",
        });
        expect(bookedEvent).toMatchObject({
            eventName: "booked",
            phase: "verify",
            status: "succeeded",
            severity: "success",
            mode: "direct",
        });
    });
});

describe("AMZ_BACKGROUND_NOTIFICATIONS", () => {
    it("mutes unsupported non-terminal events before queueing", async () => {
        const { store, sentTelegram } = setupBackgroundNotifications();

        const result = await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent({
            eventName: "booking.progress",
            jobId: "JOB-1",
        });

        expect(result).toEqual({ muted: true, eventName: "booking.progress" });
        expect(store[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.NOTIFICATION_QUEUE]).toBeUndefined();
        expect(sentTelegram).not.toHaveBeenCalled();
    });

    it("sends job matched and booked events with mode", async () => {
        const { store, sentTelegram } = setupBackgroundNotifications();
        const { NOTIFICATIONS } = globalThis.AMZ_CONSTANTS;

        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent({
            eventName: NOTIFICATIONS.EVENTS.JOB_FOUND,
            jobId: "JOB-1",
            mode: "manual",
            pageUrl: "https://hiring.amazon.ca/app#/jobDetail?jobId=JOB-1",
        });
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent({
            eventName: NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            applicationId: "app-1",
            mode: "direct",
        });
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();
        const formOpenedResult = await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent({
            eventName: NOTIFICATIONS.EVENTS.FORM_OPENED,
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            applicationId: "app-1",
            currentState: "APPLICATION_FORM_OPENED",
            mode: "direct",
        });
        const failedResult = await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent({
            eventName: NOTIFICATIONS.EVENTS.BOOKING_FAILED,
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            applicationId: "app-1",
            errorCode: "SELECTED_SCHEDULE_NOT_AVAILABLE",
            mode: "direct",
        });
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();

        expect(formOpenedResult).toEqual({ muted: true, eventName: "form.opened" });
        expect(failedResult).toEqual({ muted: true, eventName: "booking.failed" });
        expect(sentTelegram).toHaveBeenCalledTimes(2);
        expect(sentTelegram.mock.calls[0][0].text).toContain("Job Matched");
        expect(sentTelegram.mock.calls[0][0].text).toContain("Mode: Manual");
        expect(sentTelegram.mock.calls[1][0].text).toContain("Booked");
        expect(sentTelegram.mock.calls[1][0].text).toContain("Mode: Direct");
        expect(sentTelegram.mock.calls[0][0].text).toContain("Extension v1.0.0");
        expect(sentTelegram.mock.calls[1][0].text).toContain("Extension v1.0.0");
        expect(sentTelegram.mock.calls[0][0]).toEqual(expect.objectContaining({
            country: "Canada",
            event_name: "job_matched",
            extension_version: "1.0.0",
            operator_username: "operator@example.com",
            job_id: "JOB-1",
        }));
        expect(sentTelegram.mock.calls[1][0]).toEqual(expect.objectContaining({
            country: "Canada",
            event_name: "booked",
            extension_version: "1.0.0",
            operator_username: "operator@example.com",
            job_id: "JOB-1",
            schedule_id: "SCH-1",
            application_id: "app-1",
        }));
        expect(store[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.NOTIFICATION_QUEUE]).toEqual([]);
    });

    it("canonicalizes legacy queued event names before Telegram delivery", async () => {
        const { store, sentTelegram } = setupBackgroundNotifications();
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;

        store[STORAGE_KEYS.NOTIFICATION_QUEUE] = [{
            id: "legacy-booked",
            attempts: 0,
            queuedAt: new Date().toISOString(),
            event: {
                eventName: "booking.succeeded",
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "app-1",
                mode: "direct",
            },
        }];

        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();

        expect(sentTelegram).toHaveBeenCalledOnce();
        expect(sentTelegram.mock.calls[0][0].text).toContain("<b>Booked</b>");
        expect(sentTelegram.mock.calls[0][0].text).toContain("Mode: Direct");
        expect(store[STORAGE_KEYS.NOTIFICATION_QUEUE]).toEqual([]);
    });

    it("keeps failure diagnostics out of allowed booked Telegram messages", async () => {
        const { sentTelegram } = setupBackgroundNotifications();
        const { NOTIFICATIONS } = globalThis.AMZ_CONSTANTS;

        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent({
            eventName: NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            applicationId: "app-1",
            errorClassification: "network-or-timeout",
            errorCode: "NETWORK_TIMEOUT",
            httpStatus: 504,
            message: "This should stay in analytics, not Telegram.",
        });
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();

        const notificationText = sentTelegram.mock.calls[0][0].text;
        expect(notificationText).toContain("<b>Booked</b>");
        expect(notificationText).not.toContain("network-or-timeout");
        expect(notificationText).not.toContain("NETWORK_TIMEOUT");
        expect(notificationText).not.toContain("HTTP 504");
        expect(notificationText).not.toContain("This should stay in analytics");
    });

    it("dedupes terminal booking events by attempt", async () => {
        const { sentTelegram } = setupBackgroundNotifications();
        const event = {
            eventName: globalThis.AMZ_CONSTANTS.NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            applicationId: "app-1",
            pageUrl: "https://hiring.amazon.ca/application/ca/?jobId=JOB-1&scheduleId=SCH-1",
        };

        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent(event);
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent(event);
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();

        expect(sentTelegram).toHaveBeenCalledOnce();
    });

    it("uses event client email for terminal notification identity and dedupe", async () => {
        const { sentTelegram } = setupBackgroundNotifications();
        const { NOTIFICATIONS } = globalThis.AMZ_CONSTANTS;
        const baseEvent = {
            eventName: NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            applicationId: "app-1",
        };

        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent({
            ...baseEvent,
            clientEmail: "first-client@example.com",
        });
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent({
            ...baseEvent,
            clientEmail: "second-client@example.com",
        });
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();

        expect(sentTelegram).toHaveBeenCalledTimes(2);
        expect(sentTelegram.mock.calls[0][0].text).toContain("first-client@example.com");
        expect(sentTelegram.mock.calls[1][0].text).toContain("second-client@example.com");
    });

    it("flushes a persisted queue after a service-worker restart", async () => {
        const { store, sentTelegram } = setupBackgroundNotifications();
        const { NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        store[STORAGE_KEYS.NOTIFICATION_QUEUE] = [{
            id: "queued-1",
            attempts: 0,
            queuedAt: new Date().toISOString(),
            event: {
                eventName: NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
                jobId: "JOB-1",
                scheduleId: "SCH-1",
                applicationId: "app-1",
                pageUrl: "https://hiring.amazon.ca/application/ca/?jobId=JOB-1&scheduleId=SCH-1",
            },
        }];

        unloadSharedNamespaces(["AMZ_BACKGROUND_NOTIFICATIONS"]);
        loadSharedScripts(["background/notification-service.js"]);
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();

        expect(sentTelegram).toHaveBeenCalledOnce();
        expect(store[STORAGE_KEYS.NOTIFICATION_QUEUE]).toEqual([]);
    });

    it("drains events queued while a flush is already in progress", async () => {
        const { store, sentTelegram } = setupBackgroundNotifications();
        const { NOTIFICATIONS, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        let queuedFollowup = false;

        sentTelegram.mockImplementation(async () => {
            if (!queuedFollowup) {
                queuedFollowup = true;
                await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent({
                    eventName: NOTIFICATIONS.EVENTS.BOOKING_FAILED,
                    jobId: "JOB-2",
                    scheduleId: "SCH-2",
                    errorCode: "SELECTED_SCHEDULE_NOT_AVAILABLE",
                    message: "The schedule you have selected is no longer available.",
                });
            }
            return { delivered: true, message_id: sentTelegram.mock.calls.length };
        });

        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.sendEvent({
            eventName: NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            applicationId: "app-1",
        });
        await globalThis.AMZ_BACKGROUND_NOTIFICATIONS.flushQueue();

        expect(sentTelegram).toHaveBeenCalledOnce();
        expect(store[STORAGE_KEYS.NOTIFICATION_QUEUE]).toEqual([]);
    });
});

describe("AMZ_TELEGRAM_CHANNEL", () => {
    it("formats booking success as Booked", () => {
        setupBackgroundNotifications();

        const notificationText = globalThis.AMZ_TELEGRAM_CHANNEL.formatNotificationText({
            eventName: globalThis.AMZ_CONSTANTS.NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
        }, {
            clientEmail: "client@example.com",
            mode: "direct",
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            applicationId: "app-1",
            message: "Job confirmed after Amazon accepted the offer.",
            pageUrl: "https://hiring.amazon.ca/app#/jobSearch",
        });

        expect(notificationText).toContain("<b>Booked</b>");
        expect(notificationText).toContain("Mode: Direct");
        expect(notificationText).toContain("SCH-1");
        expect(notificationText).toContain("Extension v1.0.0");
        expect(notificationText).not.toContain("Job confirmed after Amazon accepted the offer.");
    });

    it("formats an explicit extension version when supplied", () => {
        setupBackgroundNotifications();

        const notificationText = globalThis.AMZ_TELEGRAM_CHANNEL.formatNotificationText({
            eventName: globalThis.AMZ_CONSTANTS.NOTIFICATIONS.EVENTS.JOB_FOUND,
        }, {
            jobId: "JOB-1",
            extensionVersion: "2.10.0",
        });

        expect(notificationText).toContain("Extension v2.10.0");
    });
});
