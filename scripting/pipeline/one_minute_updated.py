"""Generate a validated, 12-scene project from the PDF prompts with Groq."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

from .anthropic_client import ScriptClient
from .models import new_project, save
from .prompts import render, STYLE_LOCK

CHAR_TAG = re.compile(r"^@CHAR-\d{2}-[A-Z][A-Z0-9-]*$")
BG_TAG = re.compile(r"^#BGD-\d{2}-[A-Z][A-Z0-9-]*$")
PROJECTS_ROOT = Path(os.environ.get("PROJECTS_DIR", "projects"))


def ask(client: ScriptClient, prompt: str, max_tokens: int = 4800):
    return client.complete(prompt, max_tokens=max_tokens, temperature=0)


def _extract_json_object(raw: str) -> str:
    """Extract the first complete JSON object, tolerating surrounding prose/fences."""
    clean = re.sub(
        r"^\s*```(?:json)?\s*|\s*```\s*$",
        "",
        raw.strip(),
        flags=re.IGNORECASE,
    )

    start = clean.find("{")
    if start < 0:
        raise ValueError("Groq did not return a JSON object")

    depth = 0
    in_string = False
    escaped = False

    for index in range(start, len(clean)):
        char = clean[index]

        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return clean[start:index + 1]

    # The model may have malformed quotes and confuse brace detection. The
    # caller will get a helpful parse/repair error and the raw response is saved.
    last = clean.rfind("}")
    if last > start:
        return clean[start:last + 1]

    raise ValueError("Groq returned an incomplete JSON object (missing closing brace)")


def json_object(raw: str) -> dict:
    """Parse a model response as JSON; use json-repair for common LLM mistakes."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("Groq returned an empty response instead of JSON")

    clean = re.sub(
        r"^\s*```(?:json)?\s*|\s*```\s*$",
        "",
        raw.strip(),
        flags=re.IGNORECASE,
    )

    try:
        result: Any = json.loads(clean)
    except json.JSONDecodeError:
        candidate = _extract_json_object(clean)
        try:
            result = json.loads(candidate)
        except json.JSONDecodeError as original_error:
            try:
                from json_repair import repair_json
            except ImportError as import_error:
                raise RuntimeError(
                    "The model returned malformed JSON and the 'json-repair' package "
                    "is not installed. Run: python -m pip install json-repair"
                ) from import_error