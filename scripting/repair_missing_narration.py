"""Repair missing Hindi narration metadata in an already-generated pipeline project.

Run from the scripting directory:
    python repair_missing_narration.py

Or pass a specific pipeline.json path:
    python repair_missing_narration.py --project projects/<project-id>/pipeline.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

SCRIPTING_ROOT = Path(__file__).resolve().parent
load_dotenv(SCRIPTING_ROOT / ".env", override=False)

from pipeline.anthropic_client import ScriptClient  # noqa: E402
from pipeline.models import save  # noqa: E402
from pipeline.one_minute import json_object, validate  # noqa: E402

PROJECTS_ROOT = Path(os.environ.get("PROJECTS_DIR", "projects"))


def missing_narration_scenes(project: dict) -> list[dict]:
    scenes = project.get("scenes", [])
    return [
        scene
        for scene in scenes
        if isinstance(scene, dict)
        and scene.get("speaker") in {"NARRATOR", "none"}
        and not str(scene.get("narration_text", "")).strip()
    ]


def find_latest_project() -> Path:
    root = PROJECTS_ROOT
    if not root.is_absolute():
        root = SCRIPTING_ROOT / root
    candidates: list[tuple[float, Path]] = []

    for path in root.glob("*/pipeline.json"):
        try:
            project = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if len(project.get("scenes", [])) == 12 and missing_narration_scenes(project):
            candidates.append((path.stat().st_mtime, path))

    if not candidates:
        raise FileNotFoundError(
            f"No 12-scene project with missing narration was found under {root}. "
            "Pass --project with the correct pipeline.json path if needed."
        )
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project",
        help="Path to an existing pipeline.json (relative to scripting/ or absolute).",
    )
    args = parser.parse_args()

    if args.project:
        project_path = Path(args.project)
        if not project_path.is_absolute():
            project_path = (Path.cwd() / project_path).resolve()
    else:
        project_path = find_latest_project()

    if not project_path.exists():
        raise FileNotFoundError(f"Project not found: {project_path}")

    project = json.loads(project_path.read_text(encoding="utf-8"))
    missing = missing_narration_scenes(project)
    if not missing:
        print(f"No missing narration found in {project_path}")
        return

    story = str(project.get("script", {}).get("raw_text", "")).strip()
    if not story:
        raise ValueError("The selected project has no locked script text to guide narration repair.")

    requested = [
        {
            "scene_number": scene.get("scene_number"),
            "title": scene.get("title", ""),
            "visual_action": scene.get("visual_action", ""),
            "camera": scene.get("camera", ""),
            "effects": scene.get("effects", ""),
            "speaker": scene.get("speaker", "none"),
            "character_tags": scene.get("character_tags", []),
            "devanagari_dialogue": scene.get("devanagari_dialogue", ""),
        }
        for scene in missing
    ]

    prompt = (
        "Repair only missing narration metadata in the following existing Hindi folk-horror video. "
        'Return ONLY valid JSON shaped exactly like {"narration":[{"scene_number":4,"narration_text":"..."}]}. '
        f"Provide exactly one narration item for each of these scene numbers: "
        f"{[scene.get('scene_number') for scene in missing]}. Do not include any other scene numbers. "
        "Each narration_text must be one short, natural Hindi sentence written in Devanagari, consistent "
        "with both the locked story and the visual action. Reuse a suitable exact sentence from the story "
        "where possible. This is narrator voiceover metadata, not character dialogue. Do not include "
        "English transliteration, labels, markdown fences, comments, or explanations. Use double quotes "
        "for every JSON key and string value and do not add trailing commas.\n\n"
        "LOCKED STORY:\n"
        + story
        + "\n\nSCENES NEEDING NARRATION:\n"
        + json.dumps(requested, ensure_ascii=False)
    )

    client = ScriptClient()
    raw = client.complete(prompt, max_tokens=1600, temperature=0)
    project.setdefault("raw_stages", {})["narration_repair"] = raw
    save(project_path, project)  # Preserve the API response before parsing it.

    try:
        result = json_object(raw)
    except Exception:
        debug_path = project_path.with_name(project_path.stem + "_invalid_narration_repair.txt")
        debug_path.write_text(raw, encoding="utf-8")
        print(f"Could not parse the repair response. Raw response saved to: {debug_path}")
        raise

    items = result.get("narration", [])
    if not isinstance(items, list):
        items = []
    allowed = {int(scene["scene_number"]) for scene in missing}
    repair_map: dict[int, str] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            number = int(item.get("scene_number"))
        except (TypeError, ValueError):
            continue
        text = str(item.get("narration_text", "")).strip()
        if number in allowed and text and re.search(r"[\u0900-\u097F]", text):
            repair_map[number] = text

    for scene in project.get("scenes", []):
        number = int(scene.get("scene_number", -1))
        if number in repair_map and not str(scene.get("narration_text", "")).strip():
            scene["narration_text"] = repair_map[number]

    still_missing = missing_narration_scenes(project)
    if still_missing:
        save(project_path, project)
        numbers = ", ".join(str(s.get("scene_number")) for s in still_missing)
        raise ValueError(
            f"Narration repair did not fill scene(s) {numbers}. Raw output is stored in "
            f"pipeline.json under raw_stages.narration_repair."
        )

    # Re-run validation and regenerate derived scene prompts; save the repaired project.
    validate(project)
    save(project_path, project)

    print(f"Repaired narration for {len(repair_map)} scene(s).")
    print(f"Project file: {project_path}")
    print("Resume the production workflow with this project file from the repository root:")
    try:
        relative = project_path.resolve().relative_to(SCRIPTING_ROOT.parent.resolve())
        print(f'node start-video.mjs --project "{relative.as_posix()}"')
    except ValueError:
        print(f'node start-video.mjs --project "{project_path}"')


if __name__ == "__main__":
    main()
