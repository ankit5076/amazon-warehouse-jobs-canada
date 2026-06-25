import { describe, it, expect, beforeAll } from "vitest";
import { loadSharedScripts } from "./_load.js";

beforeAll(() => {
    loadSharedScripts(["shared/constants.js"]);
});

describe("AMZ_CONSTANTS namespace", () => {
    it("is exposed on globalThis and frozen", () => {
        expect(globalThis.AMZ_CONSTANTS).toBeDefined();
        expect(Object.isFrozen(AMZ_CONSTANTS)).toBe(true);
    });

    it("exposes the structured post-refactor top-level configuration groups", () => {
        const keys = Object.keys(AMZ_CONSTANTS).sort();
        expect(keys).toEqual([
            "ALERTS",
            "AMAZON",
            "AUTH_PROBE",
            "CREATE_APPLICATION",
            "DIRECT_APPLICATION",
            "DOM",
            "EMAIL_REGEX",
            "IDENTITY",
            "INSTALL_DEFAULTS",
            "LOCAL_DEFAULTS",
            "LOGGING",
            "MESSAGE_ACTIONS",
            "NOTIFICATIONS",
            "POLLING",
            "POPUP",
            "RESET_DEFAULTS",
            "SCHEDULE_AUTOMATION",
            "SELECTORS",
            "STORAGE_KEYS",
            "TEXT_LIMITS",
            "USERNAME_REGEX",
            "isCanada",
        ]);
    });

    it("does not expose legacy flat configuration names", () => {
        expect(AMZ_CONSTANTS.AMAZON_PAGE_PATTERNS).toBeUndefined();
        expect(AMZ_CONSTANTS.AMAZON_URLS).toBeUndefined();
        expect(AMZ_CONSTANTS.CREATEAPP).toBeUndefined();
    });
});

describe("AMAZON configuration", () => {
    it("page patterns cover hiring + auth subdomains", () => {
        const patterns = AMZ_CONSTANTS.AMAZON.PAGE_PATTERNS;
        expect(patterns).toContain("https://hiring.amazon.ca/*");
        expect(patterns.some((x) => x.includes("auth.hiring.amazon.com"))).toBe(true);
        expect(patterns.some((x) => x.includes("auth.hiring.amazon.ca"))).toBe(true);
    });

    it("redirect URLs point at expected hash routes", () => {
        const expectedDomain = AMZ_CONSTANTS.isCanada ? "hiring.amazon.ca" : "hiring.amazon.com";
        expect(AMZ_CONSTANTS.AMAZON.URLS.MY_APPLICATIONS).toBe(
            `https://${expectedDomain}/app#/myApplications`
        );
        expect(AMZ_CONSTANTS.AMAZON.URLS.JOB_SEARCH).toBe(
            `https://${expectedDomain}/app#/jobSearch`
        );
    });

    it("derives country-specific Amazon endpoints from the isCanada feature flag", () => {
        const expected = AMZ_CONSTANTS.isCanada
            ? {
                domain: "hiring.amazon.ca",
                authDomain: "auth.hiring.amazon.ca",
                loginUrl: "https://hiring.amazon.ca/app#/login",
                countryPath: "ca",
                locale: "en-CA",
                country: "Canada",
                countryCode: "CA",
                includeGeoQueryClause: true,
                includeHoursPerWeekRange: false,
                includeConsolidateSchedule: false,
                equalFilters: [],
                sorters: [{ fieldName: "totalPayRateMax", ascending: "false" }],
            }
            : {
                domain: "hiring.amazon.com",
                authDomain: "auth.hiring.amazon.com",
                loginUrl: "https://auth.hiring.amazon.com/#/login",
                countryPath: "us",
                locale: "en-US",
                country: "United States",
                countryCode: "US",
                includeGeoQueryClause: false,
                includeHoursPerWeekRange: true,
                includeConsolidateSchedule: true,
                equalFilters: [{ key: "scheduleRequiredLanguage", val: "en-US" }],
                sorters: [{ fieldName: "totalPayRateMax", ascending: "false" }],
            };

        expect(AMZ_CONSTANTS.AMAZON.COUNTRY_CONFIG).toEqual(expect.objectContaining({
            domain: expected.domain,
            authDomain: expected.authDomain,
            loginUrl: expected.loginUrl,
            applicationCountryPath: expected.countryPath,
            locale: expected.locale,
            country: expected.country,
            countryCode: expected.countryCode,
        }));
        expect(AMZ_CONSTANTS.AMAZON.COUNTRY_CONFIG.search).toEqual({
            includeGeoQueryClause: expected.includeGeoQueryClause,
            includeHoursPerWeekRange: expected.includeHoursPerWeekRange,
            includeConsolidateSchedule: expected.includeConsolidateSchedule,
            equalFilters: expected.equalFilters,
            sorters: expected.sorters,
        });
        expect(AMZ_CONSTANTS.AMAZON.GRAPHQL.URL).toBe(`https://${expected.domain}/graphql`);
        expect(AMZ_CONSTANTS.AMAZON.GRAPHQL.SCHEDULE_OPERATION_NAME).toBe("searchScheduleCards");
        expect(AMZ_CONSTANTS.AMAZON.GRAPHQL.SCHEDULE_PAGE_SIZE).toBeGreaterThan(
            AMZ_CONSTANTS.AMAZON.GRAPHQL.PAGE_SIZE
        );
        expect(AMZ_CONSTANTS.AMAZON.GRAPHQL.REQUEST_JITTER_MS).toBe(50);
        expect(AMZ_CONSTANTS.AMAZON.GRAPHQL.SCHEDULE_QUERY).toContain("searchScheduleCards");
        expect(AMZ_CONSTANTS.AMAZON.URLS.LOGIN).toBe(expected.loginUrl);
        expect(AMZ_CONSTANTS.AMAZON.URLS.CREATE_APPLICATION).toBe(
            `https://${expected.domain}/application/${expected.countryPath}/?country=${expected.countryPath}`
        );
        expect(AMZ_CONSTANTS.AUTH_PROBE.COUNTRY_CODE).toBe(expected.countryCode);
        expect(AMZ_CONSTANTS.AUTH_PROBE.CSRF_URL).toBe(
            `https://${expected.domain}/authorize/api/csrf?countryCode=${expected.countryCode}`
        );
        expect(AMZ_CONSTANTS.AUTH_PROBE.AUTHORIZE_URL).toBe(
            `https://${expected.domain}/authorize/api/authorize?countryCode=${expected.countryCode}`
        );
        expect(AMZ_CONSTANTS.AUTH_PROBE.REDIRECT_URL).toBe(expected.domain);
        expect(AMZ_CONSTANTS.AUTH_PROBE.NOT_AUTHENTICATED_HTTP_STATUSES).toEqual([401, 403]);
    });
});

describe("backend-owned runtime config", () => {
    it("does not export extension-side default config groups", () => {
        expect(AMZ_CONSTANTS.PAGE_REFRESH).toBeUndefined();
        expect(AMZ_CONSTANTS.JOB_SEARCH).toBeUndefined();
        expect(AMZ_CONSTANTS.FETCH_INTERVAL).toBeUndefined();
        expect(AMZ_CONSTANTS.DEFAULT_INPUTS).toBeUndefined();
        expect(AMZ_CONSTANTS.CITY_TAGS).toBeUndefined();
        expect(AMZ_CONSTANTS.GEO_DEFAULTS).toBeUndefined();
    });
});

describe("LOGGING", () => {
    it("defines console log modes and throttles", () => {
        expect(AMZ_CONSTANTS.LOGGING.POLLING_SUCCESS_THROTTLE_MS).toBe(30000);
        expect(AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS).toBe(2000);
        expect(AMZ_CONSTANTS.LOGGING.DEFAULT_MODE).toBe(AMZ_CONSTANTS.LOGGING.MODES.STANDARD);
        expect(AMZ_CONSTANTS.LOGGING.CONSOLE_METHOD_BY_LEVEL.error).toBe("error");
    });
});

describe("CREATE_APPLICATION", () => {
    it("delays are positive integers", () => {
        const createApplication = AMZ_CONSTANTS.CREATE_APPLICATION;
        expect(Number.isInteger(createApplication.NATIVE_CLICK_DELAY_MS)).toBe(true);
        expect(createApplication.NATIVE_CLICK_DELAY_MS).toBeGreaterThan(0);
        expect(Number.isInteger(createApplication.POST_NEXT_RESCAN_MS)).toBe(true);
        expect(createApplication.POST_NEXT_RESCAN_MS).toBeGreaterThan(0);
    });

    it("injects the direct-application mode helper before the native UI controller", () => {
        const files = AMZ_CONSTANTS.CREATE_APPLICATION.INJECTION_FILES;
        expect(files).toContain("content/utils/direct-application-guard.js");
        expect(files).toContain("content/utils/direct-application-mode.js");
        expect(files.indexOf("content/utils/direct-application-guard.js"))
            .toBeLessThan(files.indexOf("content/createapp.js"));
        expect(files.indexOf("content/utils/direct-application-mode.js"))
            .toBeLessThan(files.indexOf("content/createapp.js"));
    });
});

describe("DIRECT_APPLICATION", () => {
    it("exposes the direct API booking feature flag", () => {
        expect(typeof AMZ_CONSTANTS.DIRECT_APPLICATION.useDirectApplication).toBe("boolean");
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.useDirectApplication).toBe(true);
    });

    it("suppresses UI Create Application fallback while a post-create CAPTCHA is active", () => {
        const { DIRECT_APPLICATION } = AMZ_CONSTANTS;
        expect(DIRECT_APPLICATION.UI_FALLBACK_SUPPRESSION_STAGES).toContain(
            DIRECT_APPLICATION.STAGES.CAPTCHA_RENDER_REQUESTED
        );
        expect(DIRECT_APPLICATION.UI_FALLBACK_SUPPRESSION_STAGES).toContain(
            DIRECT_APPLICATION.STAGES.CAPTCHA_PRESENTED
        );
        expect(DIRECT_APPLICATION.UI_FALLBACK_SUPPRESSION_STAGES).not.toContain(
            DIRECT_APPLICATION.STAGES.CAPTCHA_REQUIRED
        );
    });

    it("pauses app-route automation during direct confirmation recovery", () => {
        const { DIRECT_APPLICATION } = AMZ_CONSTANTS;
        expect(DIRECT_APPLICATION.NAVIGATION_PAUSE_STAGES).toContain(
            DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM
        );
        expect(DIRECT_APPLICATION.NAVIGATION_PAUSE_STAGES).toContain(
            DIRECT_APPLICATION.STAGES.CAPTCHA_RENDER_REQUESTED
        );
        expect(DIRECT_APPLICATION.NAVIGATION_PAUSE_STAGES).toContain(
            DIRECT_APPLICATION.STAGES.CAPTCHA_PRESENTED
        );
        expect(DIRECT_APPLICATION.NAVIGATION_PAUSE_STAGES).not.toContain(
            DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED
        );
        expect(DIRECT_APPLICATION.NAVIGATION_PAUSE_TTL_MS).toBeGreaterThan(
            DIRECT_APPLICATION.WAF.CAPTCHA_SOLVE_TIMEOUT_MS
        );
    });

    it("keeps direct booking terminal navigation on official Amazon routes", () => {
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.REDIRECT_AFTER_SUCCESS).toBe(true);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.REDIRECT_AFTER_JOB_CONFIRM).toBe(true);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.WAF_PREFLIGHT_ENABLED).toBe(true);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.RESERVATION_VERIFY_BEFORE_SUCCESS).toBe(false);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.SCHEDULE_VERIFY_BEFORE_CREATE).toBe(true);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.SCHEDULE_DETAIL_PREFETCH_ENABLED).toBe(true);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.JOB_DETAIL_PREFETCH_ENABLED).toBe(true);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.SCHEDULE_DETAIL_WORKFLOW_WAIT_MS).toBe(250);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.MY_APPLICATIONS_REDIRECT_DELAY_MS).toBe(0);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.CREATE_WITHOUT_SCHEDULE_FALLBACK_ENABLED).toBe(true);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.CONSENT_REDIRECT_DELAY_MS).toBe(0);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.NO_AVAILABLE_SHIFT_REDIRECT_DELAY_MS).toBe(0);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.FALLBACK_SELECTED_SCHEDULE_SESSION_KEY)
            .toBe("scheduleNotAvailable");
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.UNAVAILABLE_JOB_SEARCH_REDIRECT_DELAY_MS).toBe(250);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.SELECTED_SCHEDULE_CONSENT_HANDOFF_ENABLED).toBe(true);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.POST_CREATE_CONFIRM_FAILURE_CONSENT_HANDOFF_ENABLED)
            .toBe(true);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.TERMINAL_MY_APPLICATIONS_REDIRECT_ENABLED)
            .toBe(false);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.MY_APPLICATIONS_SELECT_SHIFT_HANDOFF_ENABLED).toBe(false);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.MY_APPLICATIONS_ACTIVE_SELECT_SHIFT_ENABLED).toBe(true);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.SUCCESS_MY_APPLICATIONS_FALLBACK_ENABLED).toBe(false);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.SUCCESS_MY_APPLICATIONS_FALLBACK_DELAY_MS)
            .toBeGreaterThan(0);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.EXISTING_APPLICATION_MY_APPLICATIONS_HANDOFF_ENABLED)
            .toBe(false);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.ACTIVE_ATTEMPT_LOCK_TTL_MS).toBeGreaterThan(0);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_COOLDOWN_MS).toBeGreaterThan(0);
        expect(AMZ_CONSTANTS.DIRECT_APPLICATION.EXISTING_APPLICATION_COOLDOWN_MS).toBeGreaterThan(0);
    });

    it("verifies schedule UI no-apply states through GraphQL before returning to search", () => {
        expect(AMZ_CONSTANTS.SCHEDULE_AUTOMATION.SCHEDULE_GRAPHQL_RECOVERY_ENABLED).toBe(true);
        expect(AMZ_CONSTANTS.SCHEDULE_AUTOMATION.POST_SELECT_SCHEDULE_OPTIONS_GRACE_MS)
            .toBeGreaterThan(0);
    });

    it("keeps the pre-match toast neutral until a job is actually matched", () => {
        expect(AMZ_CONSTANTS.ALERTS.MATCHING_PROGRESS_LABEL).toBe("Amazon returned jobs, checking filters");
    });

    it("defines WAF page bridge readiness messages and timeouts", () => {
        const { WAF } = AMZ_CONSTANTS.DIRECT_APPLICATION;
        expect(WAF.MESSAGE_TYPES.BRIDGE_PING).toBe("AMZ_DIRECT_WAF_BRIDGE_PING");
        expect(WAF.MESSAGE_TYPES.BRIDGE_READY).toBe("AMZ_DIRECT_WAF_BRIDGE_READY");
        expect(WAF.BRIDGE_READY_TIMEOUT_MS).toBeGreaterThan(0);
        expect(WAF.CAPTCHA_SDK_LOAD_TIMEOUT_MS).toBeGreaterThan(0);
    });
});

describe("NOTIFICATIONS", () => {
    it("defines canonical local workflow events without external channels", () => {
        const { NOTIFICATIONS } = AMZ_CONSTANTS;
        expect(NOTIFICATIONS.CHANNELS).toBeUndefined();
        expect(Object.values(NOTIFICATIONS.EVENTS)).toEqual([
            "job.found",
            "booking.succeeded",
            "booking.failed",
        ]);
        expect(NOTIFICATIONS.STANDARD_EVENTS).toEqual([
            NOTIFICATIONS.EVENTS.JOB_FOUND,
            NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED,
            NOTIFICATIONS.EVENTS.BOOKING_FAILED,
        ]);
    });
});

describe("INSTALL_DEFAULTS", () => {
    it("seeds activation OFF on first install", () => {
        expect(AMZ_CONSTANTS.INSTALL_DEFAULTS.$active).toBe(false);
        expect(AMZ_CONSTANTS.INSTALL_DEFAULTS.__ap).toBe(false);
        expect(AMZ_CONSTANTS.INSTALL_DEFAULTS.logMode).toBe(AMZ_CONSTANTS.LOGGING.MODES.STANDARD);
        expect(AMZ_CONSTANTS.INSTALL_DEFAULTS.useDirectApplication).toBe(true);
    });

    it("seeds local defaults and blank runtime-owned fields", () => {
        const installDefaults = AMZ_CONSTANTS.INSTALL_DEFAULTS;
        expect(installDefaults.selectedCity).toBe("");
        expect(installDefaults.allCitiesSelected).toBe(false);
        expect(installDefaults.distance).toBe("");
        expect(installDefaults.jobType).toEqual([]);
        expect(installDefaults.fetchIntervalValue).toBe("850");
        expect(installDefaults.fetchIntervalUnit).toBe("ms");
        expect(installDefaults.__amz_operator_username).toBe("");
        expect(installDefaults.__amz_selected_client_id).toBe("");
        expect(installDefaults.__amz_selected_client_label).toBe("");
    });

    it("seeds an empty city-tags list so the server-supplied list wins", () => {
        expect(AMZ_CONSTANTS.INSTALL_DEFAULTS.cityTags).toEqual([]);
    });

    it("resets log mode to standard", () => {
        expect(AMZ_CONSTANTS.RESET_DEFAULTS.logMode).toBe(AMZ_CONSTANTS.LOGGING.MODES.STANDARD);
    });

    it("resets fetch interval to the local polling default", () => {
        expect(AMZ_CONSTANTS.RESET_DEFAULTS.fetchIntervalValue).toBe("850");
        expect(AMZ_CONSTANTS.RESET_DEFAULTS.fetchIntervalUnit).toBe("ms");
    });
});

describe("EMAIL_REGEX", () => {
    const re = () => AMZ_CONSTANTS.EMAIL_REGEX;

    it("accepts well-formed addresses", () => {
        ["a@b.co", "first.last@example.com", "x+y@sub.domain.io"].forEach((email) => {
            expect(re().test(email), email).toBe(true);
        });
    });

    it("rejects malformed addresses", () => {
        ["", "noatsign", "a@b", "a @b.co", "a@b .co", "a@@b.co"].forEach((email) => {
            expect(re().test(email), email).toBe(false);
        });
    });
});

describe("USERNAME_REGEX", () => {
    const re = () => AMZ_CONSTANTS.USERNAME_REGEX;

    it("accepts any non-empty username shape", () => {
        ["paiduser", "not an email", "team-1"].forEach((username) => {
            expect(re().test(username), username).toBe(true);
        });
    });

    it("rejects blank usernames", () => {
        ["", "   "].forEach((username) => {
            expect(re().test(username), username).toBe(false);
        });
    });
});

describe("timing configuration", () => {
    it("uses positive dedupe and schedule timing values", () => {
        expect(AMZ_CONSTANTS.NOTIFICATIONS.DEFAULT_DEDUPE_TTL_MS).toBeGreaterThan(0);
        expect(AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS).toBeGreaterThan(0);
        expect(AMZ_CONSTANTS.LOGGING.DEFAULT_MODE).toBe(AMZ_CONSTANTS.LOGGING.MODES.STANDARD);
        expect(AMZ_CONSTANTS.SCHEDULE_AUTOMATION.NO_APPLY_JOB_SEARCH_REDIRECT_DELAY_MS).toBe(1500);
        expect(AMZ_CONSTANTS.SCHEDULE_AUTOMATION.POST_SELECT_SCHEDULE_OPTIONS_GRACE_MS).toBe(1500);
        expect(AMZ_CONSTANTS.SCHEDULE_AUTOMATION.POST_SCHEDULE_LABEL_APPLY_GRACE_MS).toBe(1500);
    });

    it("defines the default poll interval and scheduled jitter range", () => {
        expect(AMZ_CONSTANTS.POLLING.FALLBACK_DELAY_MS).toBe(850);
        expect(AMZ_CONSTANTS.POLLING.SCHEDULE_JITTER_MIN_MS).toBe(200);
        expect(AMZ_CONSTANTS.POLLING.SCHEDULE_JITTER_MAX_MS).toBe(800);
    });

    it("defines auth backoff timing", () => {
        const backoff = AMZ_CONSTANTS.POLLING.AUTH_BACKOFF;
        expect(backoff.ERROR_THRESHOLD).toBe(3);
        expect(backoff.INTERVAL_MS).toBe(2000);
        expect(backoff.DURATION_MS).toBe(60000);
        expect(backoff.RECOVERY_SUCCESS_THRESHOLD).toBe(2);
        expect(backoff.AUTH_HTTP_STATUSES).toEqual([401]);
    });
});

describe("ALERTS", () => {
    it("uses alert.wav for session unauthorized redirects", () => {
        expect(AMZ_CONSTANTS.ALERTS.SESSION_UNAUTHORIZED_SOUND_FILE).toBe("assets/sounds/alert.wav");
        expect(AMZ_CONSTANTS.ALERTS.BOOKING_TERMINAL_SOUND_FILE).toBe("assets/sounds/alert.wav");
        expect(AMZ_CONSTANTS.ALERTS.SESSION_UNAUTHORIZED_LOGIN_REDIRECT_DELAY_MS).toBeGreaterThan(0);
    });
});

describe("LOGGING", () => {
    it("maps debug and trace levels to console.debug", () => {
        expect(AMZ_CONSTANTS.LOGGING.CONSOLE_METHOD_BY_LEVEL.debug).toBe("debug");
        expect(AMZ_CONSTANTS.LOGGING.CONSOLE_METHOD_BY_LEVEL.trace).toBe("debug");
    });
});
