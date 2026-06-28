/* Central copyable console logger controlled by popup log mode. */
(function (root) {
  'use strict';

  if (root.AMZ_LOGGER) return;

  const constants = root.AMZ_CONSTANTS || {};
  const { LOGGING = {}, STORAGE_KEYS = {} } = constants;
  const MODES = LOGGING.MODES || Object.freeze({
    OFF: 'off',
    STANDARD: 'standard',
    DEBUG: 'debug',
  });
  const LEVELS = LOGGING.LEVELS || Object.freeze({
    EVENT: 'event',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
    DEBUG: 'debug',
    TRACE: 'trace',
  });
  const consoleMethodByLevel = LOGGING.CONSOLE_METHOD_BY_LEVEL || Object.freeze({
    event: 'log',
    info: 'info',
    warn: 'warn',
    error: 'error',
    debug: 'debug',
    trace: 'debug',
  });
  const standardLevels = new Set(LOGGING.STANDARD_LEVELS || [
    LEVELS.EVENT,
    LEVELS.INFO,
    LEVELS.WARN,
    LEVELS.ERROR,
  ]);
  const debugLevels = new Set(LOGGING.DEBUG_LEVELS || [
    LEVELS.EVENT,
    LEVELS.INFO,
    LEVELS.WARN,
    LEVELS.ERROR,
    LEVELS.DEBUG,
    LEVELS.TRACE,
  ]);
  const logModeKey = STORAGE_KEYS.LOG_MODE || 'logMode';
  const defaultMode = LOGGING.DEFAULT_MODE || MODES.STANDARD;
  const controlledMethods = Object.freeze(['log', 'info', 'debug', 'warn', 'error']);
  const originalConsole = {};
  const throttleEntries = new Map();
  let mode = defaultMode;

  controlledMethods.forEach(method => {
    originalConsole[method] = console[method]?.bind(console);
  });

  function isKnownMode(value) {
    return Object.values(MODES).includes(value);
  }

  function normalizeBoolean(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
  }

  function normalizeMode(value, fallback = defaultMode) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (isKnownMode(normalized)) return normalized;
    if (
      typeof value === 'boolean' ||
      value === 'true' ||
      value === 'false' ||
      value === 1 ||
      value === '1' ||
      value === 0 ||
      value === '0'
    ) {
      return normalizeBoolean(value) ? MODES.DEBUG : MODES.OFF;
    }
    return isKnownMode(fallback) ? fallback : defaultMode;
  }

  function resolveStoredMode(storageResult = {}) {
    if (isKnownMode(storageResult[logModeKey])) {
      return storageResult[logModeKey];
    }
    return defaultMode;
  }

  function setMode(value) {
    mode = normalizeMode(value);
  }

  function getMode() {
    return mode;
  }

  function setEnabled(value) {
    setMode(normalizeBoolean(value) ? MODES.DEBUG : MODES.OFF);
  }

  function getEnabled() {
    return mode !== MODES.OFF;
  }

  function shouldWriteLevel(level) {
    if (mode === MODES.OFF) return false;
    if (mode === MODES.DEBUG) return debugLevels.has(level);
    return standardLevels.has(level);
  }

  function shouldWrite(level, options = {}) {
    if (mode === MODES.OFF) return false;
    if (typeof options.enabled === 'function' && options.enabled() === false) return false;
    if (typeof options.mode === 'string' && normalizeMode(options.mode) === MODES.DEBUG) {
      return debugLevels.has(level);
    }
    return shouldWriteLevel(level);
  }

  function shouldThrottle(level, prefix, step, options = {}) {
    const throttleMs = Number(options.throttleMs || 0);
    const throttleKey = options.throttleKey || '';
    if (!throttleMs || !throttleKey) return false;

    const key = [level, prefix || '', throttleKey || step || ''].join('::');
    const now = Date.now();
    const lastAt = throttleEntries.get(key) || 0;
    if (now - lastAt < throttleMs) return true;
    throttleEntries.set(key, now);
    return false;
  }

  function isSensitiveKey(key) {
    const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return (
      normalized.includes('authorization') ||
      normalized.includes('cookie') ||
      normalized.includes('csrf') ||
      normalized.includes('email') ||
      normalized.includes('password') ||
      normalized.includes('pin') ||
      normalized.includes('sessiontoken') ||
      normalized.includes('sessionid') ||
      normalized.includes('username') ||
      normalized.includes('waftoken') ||
      normalized.includes('captchatoken') ||
      normalized.includes('captcharesponse') ||
      normalized.includes('candidateid') ||
      normalized === 'token'
    );
  }

  function describeElement(element) {
    return {
      tagName: element.tagName || null,
      id: element.id || null,
      className: typeof element.className === 'string' ? element.className : null,
      testId: element.getAttribute?.('data-test-id') || element.getAttribute?.('data-testid') || null,
      text: root.AMZ_TEXT?.compact?.(element.textContent || '', 120) || null,
    };
  }

  function normalizeForJson(value, seen = new WeakSet()) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
      return value;
    }
    if (typeof value === 'undefined') return '[undefined]';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;

    if (value instanceof Error) {
      const normalized = {
        name: value.name || 'Error',
        message: value.message || '',
      };
      if (value.stack) normalized.stack = value.stack;
      Object.keys(value).forEach(key => {
        normalized[key] = isSensitiveKey(key)
          ? '[REDACTED]'
          : normalizeForJson(value[key], seen);
      });
      return normalized;
    }

    if (value instanceof Date) return root.AMZ_TIME?.formatIstIso?.(value) || value.toISOString();

    if (
      typeof Element !== 'undefined' &&
      value instanceof Element
    ) {
      return describeElement(value);
    }

    if (typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);

      if (Array.isArray(value)) {
        const normalized = value.map(item => normalizeForJson(item, seen));
        seen.delete(value);
        return normalized;
      }

      const normalized = {};
      Object.keys(value).forEach(key => {
        normalized[key] = isSensitiveKey(key)
          ? '[REDACTED]'
          : normalizeForJson(value[key], seen);
      });
      seen.delete(value);
      return normalized;
    }

    return String(value);
  }

  function formatValue(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'undefined') return 'undefined';

    try {
      return JSON.stringify(normalizeForJson(value));
    } catch (error) {
      return JSON.stringify({
        serializationError: error?.message || 'Unable to serialize log value.',
      });
    }
  }

  function formatArgs(args) {
    return Array.from(args || []).map(formatValue).join(' ');
  }

  function getConsoleVisibilityLevel(method) {
    return method === 'warn'
      ? LEVELS.WARN
      : method === 'error'
        ? LEVELS.ERROR
        : LEVELS.DEBUG;
  }

  function bracketLabel(value) {
    const normalized = String(value || '')
      .replace(/[\r\n[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized ? `[${normalized}]` : '';
  }

  function splitPrefixLabels(prefix) {
    const raw = String(prefix || '').trim();
    if (!raw) return [];

    const labels = [...raw.matchAll(/\[([^\]]+)\]/g)]
      .map(match => match[1].trim())
      .filter(Boolean);
    if (labels.length > 0) return labels;
    return [raw.replace(/^\[|\]$/g, '').trim()].filter(Boolean);
  }

  function formatLoggerPrefix(prefix, options = {}) {
    const source = options.source || options.file || '';
    const workflow = options.workflow || '';
    if (!source && !workflow) return String(prefix || '');

    const prefixLabels = splitPrefixLabels(prefix);
    const app = options.app ||
      (prefixLabels.includes('amazon-shift') ? 'amazon-shift' : 'amazon-shift');
    const component = options.component ||
      options.scope ||
      [...prefixLabels].reverse().find(label => label !== app && label !== workflow) ||
      '';
    const labels = [
      app,
      workflow ? `workflow:${workflow}` : '',
      source ? `file:${source}` : '',
      component && component !== workflow ? `scope:${component}` : '',
    ];

    return labels.map(bracketLabel).join('');
  }

  function write(level, prefix, step, details, options = {}) {
    if (!shouldWrite(level, options)) return;
    if (shouldThrottle(level, prefix, step, options)) return;

    const args = [];
    if (prefix) args.push(prefix);
    if (typeof step !== 'undefined') args.push(step);
    if (typeof details !== 'undefined') args.push(details);

    const method = consoleMethodByLevel[level] || 'log';
    originalConsole[method]?.(formatArgs(args));
  }

  function create(prefix, options = {}) {
    const loggerPrefix = formatLoggerPrefix(prefix, options);
    const logger = (step, details, writeOptions) =>
      write(LEVELS.EVENT, loggerPrefix, step, details, { ...options, ...writeOptions });
    logger.event = logger;
    logger.log = logger;
    logger.info = (step, details, writeOptions) =>
      write(LEVELS.INFO, loggerPrefix, step, details, { ...options, ...writeOptions });
    logger.warn = (step, details, writeOptions) =>
      write(LEVELS.WARN, loggerPrefix, step, details, { ...options, ...writeOptions });
    logger.error = (step, details, writeOptions) =>
      write(LEVELS.ERROR, loggerPrefix, step, details, { ...options, ...writeOptions });
    logger.debug = (step, details, writeOptions) =>
      write(LEVELS.DEBUG, loggerPrefix, step, details, { ...options, ...writeOptions });
    logger.trace = (step, details, writeOptions) =>
      write(LEVELS.TRACE, loggerPrefix, step, details, { ...options, ...writeOptions });
    return Object.freeze(logger);
  }

  controlledMethods.forEach(method => {
    console[method] = (...args) => {
      if (!shouldWriteLevel(getConsoleVisibilityLevel(method))) return;
      originalConsole[method]?.(formatArgs(args));
    };
  });

  try {
    root.chrome?.storage?.local?.get?.({
      [logModeKey]: undefined,
    }, result => {
      if (root.chrome?.runtime?.lastError) return;
      setMode(resolveStoredMode(result || {}));
    });
    root.chrome?.storage?.onChanged?.addListener?.((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes?.[logModeKey]) {
        setMode(changes[logModeKey].newValue);
      }
    });
  } catch (_) {
    setMode(defaultMode);
  }

  root.AMZ_LOGGER = Object.freeze({
    MODES,
    LEVELS,
    create,
    formatArgs,
    formatLoggerPrefix,
    getEnabled,
    getMode,
    normalizeMode,
    setEnabled,
    setMode,
    log: (prefix, step, details, options) => write(LEVELS.EVENT, prefix, step, details, options),
    event: (prefix, step, details, options) => write(LEVELS.EVENT, prefix, step, details, options),
    info: (prefix, step, details, options) => write(LEVELS.INFO, prefix, step, details, options),
    warn: (prefix, step, details, options) => write(LEVELS.WARN, prefix, step, details, options),
    error: (prefix, step, details, options) => write(LEVELS.ERROR, prefix, step, details, options),
    debug: (prefix, step, details, options) => write(LEVELS.DEBUG, prefix, step, details, options),
    trace: (prefix, step, details, options) => write(LEVELS.TRACE, prefix, step, details, options),
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
