"""Structlog config con filter de secretos (plan §4.10).

Redact automático de headers sensibles: Cookie, Authorization, Set-Cookie, X-DOVI-Token.
"""

import logging
import sys

import structlog

from app.core.config import get_settings

_REDACT_KEYS = frozenset({"cookie", "authorization", "set-cookie", "x-dovi-token"})


def _redact_secrets(_logger, _method, event_dict):
    for key in list(event_dict.keys()):
        if key.lower() in _REDACT_KEYS:
            event_dict[key] = "***REDACTED***"
        if isinstance(event_dict[key], dict):
            for subkey in list(event_dict[key].keys()):
                if subkey.lower() in _REDACT_KEYS:
                    event_dict[key][subkey] = "***REDACTED***"
    return event_dict


def configure_logging() -> None:
    s = get_settings()
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=s.log_level.upper(),
    )

    renderer: structlog.types.Processor
    if s.log_format == "json":
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer()

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            _redact_secrets,
            renderer,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
    )
