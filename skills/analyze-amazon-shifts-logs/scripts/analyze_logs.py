#!/usr/bin/env python3
"""Analyze Amazon Shifts extension debug logs and optional HAR files."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse


DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[3]

SENSITIVE_RE = re.compile(
    r'("(?:authorization|cookie|csrf|token|sessionToken|captchaToken|'
    r'captchaResponse|wafToken|candidateId|email|emailId|username|password|pin)"\s*:\s*)"[^"]*"',
    re.IGNORECASE,
)
BEARER_RE = re.compile(r"Bearer\s+[^\s\"']+", re.IGNORECASE)
SENSITIVE_QUERY_KEYS = {
    "api_key",
    "authorization",
    "captcharesponse",
    "captchatoken",
    "cookie",
    "csrf",
    "email",
    "password",
    "pin",
    "session",
    "sessiontoken",
    "token",
    "username",
    "waftoken",
}

OFFICIAL_RESOURCE_SIGNALS = [
    (
        "create-application DS API",
        ["createapplicationds", "/ds/create-application/"],
    ),
    (
        "update-application job-confirm API",
        ["updateapplication", "/update-application", "job-confirm"],
    ),
    (
        "create-and-skip-schedule action",
        ["create_application_and_skip_schedule"],
    ),
    (
        "fallback schedule list API",
        ["get-all-schedules"],
    ),
    (
        "schedule detail availability check",
        ["getscheduledetailbyscheduleid", "/get-schedule-details/"],
    ),
    (
        "reserved application rehydrate API",
        ["/applications/reserved/"],
    ),
    (
        "consent handoff route",
        ["consent"],
    ),
    (
        "no available shift route",
        ["no-available-shift"],
    ),
    (
        "already applied route",
        ["already-applied"],
    ),
    (
        "selected schedule unavailable marker",
        ["schedulenotavailable"],
    ),
    (
        "liveness check branch",
        ["enable_liveness_check", "livenesscheckpayload"],
    ),
    (
        "workflow websocket handoff",
        ["stepfunctionservice", "websocket"],
    ),
]


@dataclass
class ParsedLog:
    index: int
    timestamp: str
    timestamp_utc: str
    level: str
    prefix: str
    step: str
    details: Any
    raw_message: str


@dataclass
class Event:
    name: str
    timestamp: datetime
    log_index: int | None = None
    details: Any = None
    source: str = "log"


def redact(value: str) -> str:
    return BEARER_RE.sub("Bearer [REDACTED]", SENSITIVE_RE.sub(r'\1"[REDACTED]"', value))


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def fmt_dt(value: datetime | None) -> str:
    if not value:
        return "?"
    local = value.astimezone()
    return local.isoformat(timespec="milliseconds")


def fmt_ms(ms: float | int | None) -> str:
    if ms is None:
        return "?"
    ms = float(ms)
    if ms < 1000:
        return f"{ms:.0f}ms"
    seconds = ms / 1000
    if seconds < 60:
        return f"{seconds:.2f}s"
    minutes = int(seconds // 60)
    return f"{minutes}m {seconds - minutes * 60:.1f}s"


def compact_json(value: Any, limit: int = 420) -> str:
    if value is None:
        return ""
    try:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except TypeError:
        text = str(value)
    text = redact(text)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def sanitize_path(url: str, limit: int = 240) -> str:
    try:
        parsed = urlparse(url)
    except Exception:
        return redact(url)[:limit]

    pairs = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        normalized = re.sub(r"[^a-z0-9]", "", key.lower())
        if normalized in SENSITIVE_QUERY_KEYS or "token" in normalized or "key" in normalized:
            pairs.append((key, "[REDACTED]"))
        else:
            pairs.append((key, value))
    path = parsed.path + (f"?{urlencode(pairs)}" if pairs else "")
    return path if len(path) <= limit else path[: limit - 3] + "..."


def find_latest_json(path: Path) -> Path | None:
    if path.is_file():
        if path.suffix.lower() == ".json":
            return path
        path = path.parent
    candidates = sorted(
        path.glob("amazon-shifts-debug-logs-*.json"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        candidates = sorted(path.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
    if not candidates:
        return None
    return candidates[0]


def find_latest_har(path: Path) -> Path | None:
    directory = path if path.is_dir() else path.parent
    candidates = sorted(directory.glob("*.har"), key=lambda item: item.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def find_repo_root(*paths: Path | None) -> Path:
    candidates: list[Path] = []
    for path in paths:
        if not path:
            continue
        current = path if path.is_dir() else path.parent
        candidates.extend([current, *current.parents])
    candidates.extend([Path.cwd(), *Path.cwd().parents, DEFAULT_REPO_ROOT])

    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if (resolved / "resources").exists() and (resolved / "src").exists():
            return resolved
    return DEFAULT_REPO_ROOT


def resource_files(resources_root: Path) -> list[Path]:
    if resources_root.is_file():
        return [resources_root]
    if not resources_root.exists():
        return []

    priority = [
        resources_root / "js files.har",
        resources_root / "3387.prod.chunk.js",
        resources_root / "3133.prod.chunk.js",
        resources_root / "2369.prod.chunk.js",
        resources_root / "1352.prod.chunk.js",
        resources_root / "main.prod.js",
        resources_root / "ca.prod.js",
    ]
    files = [path for path in priority if path.exists() and path.is_file()]
    if files:
        return files
    return sorted(path for path in resources_root.glob("*.js") if path.is_file())


def read_resource_text(paths: list[Path]) -> str:
    chunks: list[str] = []
    for path in paths:
        try:
            chunks.append(path.read_text(errors="ignore"))
        except Exception:
            continue
    return "\n".join(chunks).replace("\\/", "/").lower()


def official_resource_baseline(resources_path: Path | None, log_file: Path | None, har_file: Path | None) -> dict[str, Any]:
    repo_root = find_repo_root(log_file, har_file)
    root = resources_path.expanduser().resolve() if resources_path else repo_root / "resources"
    files = resource_files(root)
    text = read_resource_text(files)
    signals = []
    for name, needles in OFFICIAL_RESOURCE_SIGNALS:
        signals.append({
            "name": name,
            "found": all(needle.lower() in text for needle in needles),
        })

    critical = {
        "create-application DS API",
        "update-application job-confirm API",
        "fallback schedule list API",
    }
    critical_found = all(
        signal["found"] for signal in signals if signal["name"] in critical
    )
    return {
        "resourcesRoot": root,
        "files": files,
        "signals": signals,
        "available": bool(files and text),
        "criticalFound": critical_found,
    }


def observed_direct_api_order(timeline: list[Event]) -> list[str]:
    output: list[str] = []
    previous = None
    for event in timeline:
        details = event.details if isinstance(event.details, dict) else {}
        text = " ".join(
            str(value or "")
            for value in [
                event.name,
                details.get("operation"),
                details.get("path"),
                details.get("pathname"),
                details.get("redirectUrl"),
            ]
        ).lower()
        label = None
        if "get-all-schedules" in text:
            label = "get-all-schedules"
        elif "create-application" in text:
            label = "create-application"
        elif "update-application" in text or "job-confirm" in text:
            label = "update-application/job-confirm"
        elif "applications/reserved" in text or "reservation-verification" in text:
            label = "reserved-application"
        if not label:
            continue
        status = details.get("status") or details.get("httpStatus")
        label = f"{label} {status}" if status else label
        if label != previous:
            output.append(label)
            previous = label
    return output


def resolve_inputs(paths: list[str], har_override: str | None = None) -> tuple[Path | None, Path | None]:
    log_file: Path | None = None
    har_file: Path | None = Path(har_override).expanduser().resolve() if har_override else None
    search_dirs: list[Path] = []

    for raw_path in paths or ["logs"]:
        path = Path(raw_path).expanduser().resolve()
        if path.is_dir():
            search_dirs.append(path)
            if log_file is None:
                log_file = find_latest_json(path)
            if har_file is None:
                har_file = find_latest_har(path)
            continue

        if path.is_file() and path.suffix.lower() == ".json":
            log_file = path
            search_dirs.append(path.parent)
            continue

        if path.is_file() and path.suffix.lower() == ".har":
            har_file = path
            search_dirs.append(path.parent)
            continue

        raise FileNotFoundError(f"Input path does not exist or is not a JSON/HAR file: {path}")

    if log_file is None:
        for directory in search_dirs:
            log_file = find_latest_json(directory)
            if log_file:
                break

    if har_file is None:
        for directory in search_dirs:
            har_file = find_latest_har(directory)
            if har_file:
                break

    if log_file is None and har_file is None:
        raise FileNotFoundError("No debug JSON log or HAR file found.")

    return log_file, har_file


def split_message(message: str) -> tuple[str, Any]:
    without_prefix = re.sub(r"^((\[[^\]]+\])+\s*)", "", message or "")
    json_match = re.search(r"\s+(\{.*\})$", without_prefix)
    if not json_match:
        return without_prefix.strip(), None
    step = without_prefix[: json_match.start()].strip()
    try:
        return step, json.loads(json_match.group(1))
    except json.JSONDecodeError:
        return without_prefix.strip(), None


def read_logs(path: Path) -> tuple[dict[str, Any], list[ParsedLog]]:
    payload = json.loads(path.read_text())
    raw_logs = payload.get("logs") if isinstance(payload, dict) else payload
    if not isinstance(raw_logs, list):
        raw_logs = []
    parsed: list[ParsedLog] = []
    for index, entry in enumerate(raw_logs):
        message = str(entry.get("message", ""))
        step, details = split_message(message)
        parsed.append(
            ParsedLog(
                index=index,
                timestamp=str(entry.get("timestamp", "")),
                timestamp_utc=str(entry.get("timestampUtc", entry.get("timestamp", ""))),
                level=str(entry.get("level", "")),
                prefix=str(entry.get("prefix", "")),
                step=step,
                details=details,
                raw_message=message,
            )
        )
    return payload if isinstance(payload, dict) else {}, parsed


def event_from_log(log: ParsedLog) -> Event | None:
    dt = parse_dt(log.timestamp_utc) or parse_dt(log.timestamp)
    if not dt:
        return None

    details = log.details if isinstance(log.details, dict) else {}
    step = log.step
    name = None

    if step == "matching job found":
        name = "Job matched"
    elif step == "opening matched job detail and starting schedule automation":
        name = "Open job detail"
    elif step == "navigating to matched job detail by URL":
        name = "Navigate job detail"
    elif step == "select schedule click result" and details.get("clicked") is True:
        name = "Select schedule clicked"
    elif step == "schedule apply clicked" and details.get("clicked") is True:
        name = "Schedule apply clicked"
    elif step == "direct booking started":
        name = "Direct booking started"
    elif step == "api request":
        op = details.get("operation") or details.get("pathname") or "API"
        name = f"API request: {op}"
    elif step == "api response":
        op = details.get("operation") or "API"
        status = details.get("httpStatus") or details.get("status")
        code = details.get("errorCode")
        suffix = f" {status}" if status else ""
        if code:
            suffix += f" {code}"
        name = f"API response: {op}{suffix}"
    elif step == "stage updated":
        stage = details.get("stage")
        if stage:
            name = f"Stage: {stage}"
    elif step in {
        "booking captcha required",
        "booking captcha visible",
        "booking captcha solved",
        "booking captcha failed",
        "job confirmed",
        "reservation verified",
        "reservation verification failed",
        "direct booking failed",
    }:
        name = step.title()
    elif step == "notification received":
        event_name = details.get("eventName")
        if event_name in {"booking.failed", "booking.succeeded", "booking.captcha_solved"}:
            name = f"Notification: {event_name}"
    elif step == "notification delivered":
        event_name = details.get("eventName")
        if event_name in {"booking.failed", "booking.succeeded"}:
            name = f"Delivered: {event_name}"
    elif step == "no apply path detected":
        name = "No apply path"
    elif step == "schedule unavailable after direct create; returning to job search":
        name = "Unavailable redirect"

    if not name:
        return None
    return Event(name=name, timestamp=dt, log_index=log.index, details=details, source="log")


def is_routine_poll(log: ParsedLog) -> bool:
    details = log.details if isinstance(log.details, dict) else {}
    return (
        log.step in {
            "fetchJobs request started",
            "graphql request prepared",
            "fetchJobs returned zero job cards",
        }
        or (log.step == "graphql response received" and details.get("status") == 200 and details.get("ok") is True)
        or (log.step == "graphql request succeeded" and details.get("jobCount") == 0)
        or (
            log.step == "fetchJobs request completed"
            and details.get("state") == "success"
            and details.get("jobCount") == 0
        )
    )


def read_har(path: Path | None) -> list[dict[str, Any]]:
    if not path or not path.exists():
        return []
    try:
        har = json.loads(path.read_text())
    except Exception:
        return []
    return har.get("log", {}).get("entries", []) or []


def har_events(entries: list[dict[str, Any]]) -> list[Event]:
    output: list[Event] = []
    for entry in entries:
        req = entry.get("request", {})
        res = entry.get("response", {})
        url = req.get("url", "")
        path = sanitize_path(url)
        status = res.get("status")
        content_text = res.get("content", {}).get("text") or ""
        is_application_api = "/application/api/" in path
        is_candidate_graphql = path == "/candidate/graphql"
        is_captcha_api = "/00480ef49626/problem" in path or "/00480ef49626/verify" in path
        is_graphql_signal = (
            path == "/graphql" and
            (status != 200 or '"jobCards":[{' in content_text or '"errors"' in content_text)
        )
        if not (is_application_api or is_candidate_graphql or is_captcha_api or is_graphql_signal):
            continue
        dt = parse_dt(entry.get("startedDateTime"))
        if not dt:
            continue
        method = req.get("method", "GET")
        headers = {str(h.get("name", "")).lower(): str(h.get("value", "")) for h in res.get("headers", [])}
        waf_action = headers.get("x-amzn-waf-action", "")
        name = f"HAR {method} {status} {path}"
        if status == 405 and waf_action.lower() == "captcha":
            name += " [WAF CAPTCHA]"
        output.append(
            Event(
                name=name,
                timestamp=dt,
                details={
                    "durationMs": entry.get("time"),
                    "status": status,
                    "method": method,
                    "path": path,
                    "wafAction": waf_action or None,
                },
                source="har",
            )
        )
    return output


def derive_findings(metadata: dict[str, Any], logs: list[ParsedLog], events: list[Event], har: list[Event]) -> list[str]:
    findings: list[str] = []
    steps = {event.name for event in events}
    routine_count = sum(1 for log in logs if is_routine_poll(log))
    failed = [event for event in events if "booking.failed" in event.name or event.name == "Direct Booking Failed"]
    succeeded = [event for event in events if "booking.succeeded" in event.name or event.name == "Job Confirmed"]
    waf_405 = [event for event in har if "[WAF CAPTCHA]" in event.name]
    confirm_200 = [
        event for event in har
        if "update-application" in event.name and str(event.details.get("status")) == "200"
    ]

    if routine_count > max(100, len(logs) * 0.5):
        findings.append(
            f"Routine empty polling dominates the export ({routine_count}/{len(logs)} lines). "
            "Use a build with polling log throttling before deep debugging."
        )
    if "Job matched" in steps:
        findings.append("Search and local matching worked: at least one job reached the booking flow.")
    if "Schedule apply clicked" in steps:
        findings.append("Schedule UI automation worked: Select schedule and/or Apply was clicked.")
    if waf_405:
        findings.append("Amazon WAF required CAPTCHA (HTTP 405 with x-amzn-waf-action=captcha). This is website/API-driven.")
    if waf_405 and confirm_200 and failed:
        findings.append(
            "Post-CAPTCHA job-confirm reached HTTP 200 but the extension still emitted booking.failed. "
            "Inspect confirm response interpretation and add reservation verification before declaring failure."
        )
    elif failed:
        findings.append("Booking failed notification was emitted; inspect attached errorCode/errorClassification if present.")
    if succeeded and not failed:
        findings.append("Booking success was emitted; remaining work is audit/redirect verification.")
    if metadata.get("extensionVersion"):
        findings.append(f"Log export came from extension version {metadata.get('extensionVersion')}.")
    return findings


def suggestions(events: list[Event], har: list[Event], logs: list[ParsedLog]) -> list[str]:
    names = [event.name for event in events]
    has_failed = any("booking.failed" in name or name == "Direct Booking Failed" for name in names)
    has_captcha = any("[WAF CAPTCHA]" in event.name for event in har) or any("captcha" in name.lower() for name in names)
    has_confirm_200 = any("update-application" in event.name and str(event.details.get("status")) == "200" for event in har)
    output: list[str] = []

    if has_captcha and has_confirm_200 and has_failed:
        output.append(
            "Treat HTTP 200 job-confirm after CAPTCHA as provisional success and immediately run reserved-application verification before failing."
        )
        output.append(
            "Log job-confirm response shape with currentState, selectedScheduleId, workflowStepName, and raw top-level keys."
        )
    if has_failed and not any("errorCode" in compact_json(event.details) for event in events if "booking.failed" in event.name):
        output.append("Include errorCode, errorClassification, httpStatus, failedStage, and captchaReason in booking.failed logs and notifications.")
    if sum(1 for log in logs if is_routine_poll(log)) > 100:
        output.append("Reload the newest extension build so polling-log throttling keeps failure context in the last 1000 lines.")
    if not output:
        output.append("No obvious code change follows from this export; collect a HAR plus debug log around the next failure.")
    return output


def build_report(log_file: Path | None, har_file: Path | None, resources_path: Path | None = None) -> str:
    metadata, logs = read_logs(log_file) if log_file else ({}, [])
    har_entries = read_har(har_file)
    log_events = [event for log in logs if (event := event_from_log(log))]
    network_events = har_events(har_entries)
    timeline = sorted(log_events + network_events, key=lambda event: event.timestamp)
    official = official_resource_baseline(resources_path, log_file, har_file)

    first = timeline[0].timestamp if timeline else None
    last = timeline[-1].timestamp if timeline else None
    job_found = next((event.timestamp for event in timeline if event.name == "Job matched"), first)
    terminal = next(
        (
            event.timestamp for event in reversed(timeline)
            if "booking.failed" in event.name or "booking.succeeded" in event.name or event.name == "Direct Booking Failed"
        ),
        last,
    )

    lines: list[str] = []
    lines.append("# Amazon Shifts Log Analysis")
    lines.append("")
    lines.append(f"- Log file: `{log_file}`" if log_file else "- Log file: `not provided`")
    if har_file:
        lines.append(f"- HAR file: `{har_file}`")
    elif not log_file:
        lines.append("- HAR file: `not provided`")
    lines.append(f"- Exported at: `{metadata.get('exportedAt') or '?'}`")
    lines.append(f"- Extension version: `{metadata.get('extensionVersion') or '?'}`")
    lines.append(f"- Log lines: `{len(logs)}`")
    if first and last:
        lines.append(f"- Timeline window: `{fmt_dt(first)}` to `{fmt_dt(last)}` ({fmt_ms((last - first).total_seconds() * 1000)})")
    if job_found and terminal:
        lines.append(f"- Attempt time from job found/first step to terminal signal: `{fmt_ms((terminal - job_found).total_seconds() * 1000)}`")
    lines.append("")

    lines.append("## Official Resource Baseline")
    if official["available"]:
        lines.append(f"- Resources: `{official['resourcesRoot']}`")
        lines.append(
            "- Files checked: " +
            ", ".join(f"`{path.name}`" for path in official["files"][:8])
        )
        signal_summary = ", ".join(
            f"{'ok' if signal['found'] else 'missing'} {signal['name']}"
            for signal in official["signals"]
        )
        lines.append(f"- Signals: {signal_summary}")
        lines.append(
            "- Expected selected-shift success: `create-application -> update-application/job-confirm -> #/consent`."
        )
        lines.append(
            "- Expected stale-schedule fallback: `get-all-schedules -> create without scheduleId -> #/consent`, or `#/no-available-shift` when no schedules exist."
        )
    else:
        lines.append(f"- Resources: missing or unreadable at `{official['resourcesRoot']}`")
    observed_order = observed_direct_api_order(timeline)
    if observed_order:
        lines.append(f"- Observed direct API order: `{' -> '.join(observed_order)}`")
    else:
        lines.append("- Observed direct API order: `none detected in supplied log/HAR`")
    lines.append("")

    lines.append("## Timeline")
    previous: datetime | None = None
    for event in timeline:
        delta = fmt_ms((event.timestamp - previous).total_seconds() * 1000) if previous else "-"
        detail = compact_json(event.details, 260)
        idx = f" #{event.log_index}" if event.log_index is not None else ""
        lines.append(f"- `{fmt_dt(event.timestamp)}` `+{delta}` [{event.source}{idx}] {event.name}{' ' + detail if detail else ''}")
        previous = event.timestamp
    if not timeline:
        lines.append("- No high-signal timeline events detected.")
    lines.append("")

    lines.append("## Findings")
    for finding in derive_findings(metadata, logs, log_events, network_events):
        lines.append(f"- {finding}")
    lines.append("")

    lines.append("## Suggestions")
    for suggestion in suggestions(log_events, network_events, logs):
        lines.append(f"- {suggestion}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "paths",
        nargs="*",
        default=["logs"],
        help="Directory, debug JSON file, HAR file, or JSON+HAR pair.",
    )
    parser.add_argument("--har", help="Optional HAR file. Defaults to newest .har beside the log or input directory.")
    parser.add_argument(
        "--resources",
        help="Optional resources directory or resource HAR. Defaults to the amazon-shifts repo resources folder.",
    )
    args = parser.parse_args()

    log_file, har_file = resolve_inputs(args.paths, args.har)
    resources_path = Path(args.resources).expanduser().resolve() if args.resources else None
    print(build_report(log_file, har_file, resources_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
