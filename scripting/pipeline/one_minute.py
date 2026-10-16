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

            try:
                result = repair_json(
                    candidate,
                    return_objects=True,
                    ensure_ascii=False,
                )
            except Exception as repair_error:
                raise ValueError(
                    f"Could not parse or repair the model's JSON response: {original_error}"
                ) from repair_error

    if not isinstance(result, dict):
        raise ValueError("Expected a JSON object at the top level")
    return result


def normalize_background_tags(backgrounds: list[dict]) -> list[dict]:
    """Ensure every background plate has a unique tag that matches BG_TAG.

    The scene prompt is built after this normalization, so the model receives
    the canonical tags and can reference them consistently.
    """
    normalized: list[dict] = []
    used: set[str] = set()

    for index, background in enumerate(backgrounds, start=1):
        if not isinstance(background, dict):
            raise ValueError(f"Background {index} must be a JSON object")

        original = str(background.get("tag", "")).strip()
        if BG_TAG.fullmatch(original) and original not in used:
            tag = original
        else:
            source = str(
                background.get("location_name")
                or background.get("look_summary")
                or "BACKGROUND"
            ).upper()
            slug = re.sub(r"[^A-Z0-9]+", "-", source).strip("-")
            if not slug or not slug[0].isalpha():
                slug = f"LOC-{slug}" if slug else "LOCATION"
            slug = slug[:48].rstrip("-") or "LOCATION"

            tag = f"#BGD-{index:02d}-{slug}"
            suffix = 2
            while tag in used or not BG_TAG.fullmatch(tag):
                tag = f"#BGD-{index:02d}-{slug}-{suffix}"
                suffix += 1

            print(
                f"Normalized background tag {original!r} to {tag!r} "
                f"for {background.get('location_name', 'unnamed background')!r}."
            )

        used.add(tag)
        normalized.append({**background, "tag": tag})

    return normalized


def save_stage(path: Path, project: dict, name: str, raw: str):
    """Persist the raw response immediately, even if parsing it later fails."""
    project.setdefault("raw_stages", {})[name] = raw
    save(path, project)


def parse_stage(path: Path, project: dict, name: str, raw: str) -> dict:
    """Save a stage response first, then parse it with a useful failure report."""
    save_stage(path, project, name, raw)
    try:
        return json_object(raw)
    except Exception as exc:
        debug_path = path.with_name(f"{path.stem}_invalid_{name}.txt")
        debug_path.write_text(raw, encoding="utf-8")
        print(f"\nCould not parse the Groq {name!r} response: {exc}")
        print(f"Raw model response saved to: {debug_path}")

        line_number = getattr(exc, "lineno", None)
        if line_number is not None:
            lines = raw.splitlines()
            start = max(0, line_number - 4)
            end = min(len(lines), line_number + 3)
            print("\nResponse around the error:")
            for index in range(start, end):
                print(f"{index + 1}: {lines[index]}")
        raise


def make_prompts(scene: dict, chars: dict, bgs: dict) -> dict:
    bg = scene["background_tag"]
    tags = scene["character_tags"]
    speaker = scene["speaker"]
    look = "; ".join(chars[tag]["look_summary"] for tag in tags) or "no visible characters"
    still = (
        "2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, "
        f"{bg} environment ({bgs[bg]['look_summary']}), {look}. "
        f"{scene['visual_action']} Camera: {scene['camera']}. "
        "Moody teal-blue rainy night lighting, natural adult human anatomy and proportions, "
        "flat 2D vector art, no text, no watermark, --ar 16:9."
    )
    common = (
        "### SYSTEM & ENVIRONMENT\n"
        "CLIP LENGTH: Let Flow determine the natural clip length needed to complete the action and dialogue. "
        "Do not truncate a spoken line or force a fixed duration.\n"
        "STYLE ANCHOR: 2D semi-realistic cartoon illustration, bold clean outlines, "
        "smooth flat cel shading. Maintain 100% flat 2D vector art aesthetics and realistic "
        "adult human proportions.\n"
        f"ACTIVE ENVIRONMENT: {bg}\nACTIVE CHARACTERS: {', '.join(tags) if tags else 'none'}\n\n"
        "### VISUAL ACTION & CAMERA\n"
        f"SCENE ACTION: {scene['visual_action']}\n"
        f"CAMERA: {scene['camera']}\n"
        f"PHYSICS/EFFECTS: {scene['effects']}\n\n"
    )
    restrictions = (
        "### NEGATIVE RESTRICTIONS\n- NO photorealism\n- NO 3D rendering\n"
        "- NO CGI shading\n- NO oversized head or body\n- NO realistic skin/hair textures\n"
        "- NO depth-of-field that breaks the 2D plane\n- NO English-accent inflection\n"
        "- NO dual-character lip-sync\n- NO text overlays\n- NO watermarks"
    )
    dialogue = str(scene.get("devanagari_dialogue", "")).strip()
    lip = (
        "### LIP-SYNC CONTROL & AUDIO\n"
        f"[LIP-SYNC LOCK]: Only {speaker}'s mouth animates to the dialogue. "
        f"All other characters ({', '.join(t for t in tags if t != speaker) or 'none'}) "
        "keep mouths completely closed and still.\n"
        "AUDIO PROTOCOL: Native Indian voice synthesis only.\n"
        f"SPEAKER IDENTITY: {chars[speaker]['voice_description']}\n"
        "LINGUISTIC CONSTRAINT: 100% native North Indian Hindi accent; no Western/English cadence.\n"
        f"DIALOGUE (DEVANAGARI ONLY): \"{dialogue}\"\n"
        f"SOUND DESIGN: {scene['sound_design']}\n\n"
    ) if speaker.startswith("@CHAR-") else ""
    silent = (
        "### LIP-SYNC CONTROL & AUDIO\n"
        "[LIP-SYNC LOCK]: No character speaks. All mouths closed and static.\n"
        "AUDIO PROTOCOL: No voice synthesis. Narrator voiceover will be layered in editing.\n"
        f"SOUND DESIGN: {scene['sound_design']}\n"
        "Do not add any dialogue.\n\n"
    )
    scene["assets"] = {"background_tag": bg, "character_tags": tags}
    # Flow owns duration; don't force a fixed length that can truncate dialogue.
    scene["clip_length_seconds"] = None
    scene["edit_length_seconds"] = None
    scene["still_image_prompt"] = still
    scene["animation_prompt_WITH_lipsync"] = common + lip + restrictions
    scene["animation_prompt_NARRATOR_ONLY"] = common + silent + restrictions
    scene["status"] = "pending"
    scene["error"] = None
    return scene


def validate(project: dict):
    chars_list = project.get("characters", [])
    bgs_list = project.get("backgrounds", [])
    scenes = project.get("scenes", [])

    if not isinstance(chars_list, list) or not isinstance(bgs_list, list):
        raise ValueError("Characters and backgrounds must both be JSON arrays")
    if not isinstance(scenes, list):
        raise ValueError("Scenes must be a JSON array")

    try:
        chars = {x["tag"]: x for x in chars_list}
        bgs = {x["tag"]: x for x in bgs_list}
    except (TypeError, KeyError) as exc:
        raise ValueError("Every character and background must have a 'tag'") from exc

    invalid_char_tags = [
        str(item.get("tag")) for item in chars_list
        if not isinstance(item.get("tag"), str) or not CHAR_TAG.fullmatch(item["tag"])
    ]
    duplicate_char_tags = sorted(
        tag for tag in chars if sum(item.get("tag") == tag for item in chars_list) > 1
    )
    if invalid_char_tags or len(chars) != len(chars_list):
        raise ValueError(
            "Duplicate or invalid character tags. "
            f"Invalid: {invalid_char_tags}; duplicates: {duplicate_char_tags}"
        )

    invalid_bg_tags = [
        str(item.get("tag")) for item in bgs_list
        if not isinstance(item.get("tag"), str) or not BG_TAG.fullmatch(item["tag"])
    ]
    duplicate_bg_tags = sorted(
        tag for tag in bgs if sum(item.get("tag") == tag for item in bgs_list) > 1
    )
    if invalid_bg_tags or len(bgs) != len(bgs_list):
        raise ValueError(
            "Duplicate or invalid background tags. "
            f"Invalid: {invalid_bg_tags}; duplicates: {duplicate_bg_tags}"
        )
    if len(scenes) != 12:
        raise ValueError(f"Expected 12 scenes, got {len(scenes)}")

    required_fields = {
        "scene_number", "background_tag", "character_tags", "speaker",
        "visual_action", "camera", "effects", "sound_design",
    }
    for i, scene in enumerate(scenes, 1):
        if not isinstance(scene, dict):
            raise ValueError(f"Scene {i} must be a JSON object")
        missing = required_fields - scene.keys()
        if missing:
            raise ValueError(f"Scene {i} is missing fields: {', '.join(sorted(missing))}")
        if scene["scene_number"] != i or scene["background_tag"] not in bgs:
            raise ValueError(f"Invalid scene number or background at scene {i}")
        if not isinstance(scene["character_tags"], list):
            raise ValueError(f"character_tags must be an array at scene {i}")
        if any(tag not in chars for tag in scene["character_tags"]):
            raise ValueError(f"Undefined character in scene {i}")
        if scene["speaker"] not in {"NARRATOR", "none", *chars}:
            raise ValueError(f"Invalid speaker in scene {i}")
        if scene["speaker"].startswith("@CHAR-") and scene["speaker"] not in scene["character_tags"]:
            raise ValueError(f"Speaker absent from scene {i}")
        scene["timestamp"] = "AUTO — determined by the completed Flow clip"
        make_prompts(scene, chars, bgs)


def generate(
    project_id: str,
    model: str | None = None,
    title: str | None = None,
    concept: str | None = None,
):
    client = ScriptClient(model=model)
    path = PROJECTS_ROOT / project_id / "pipeline.json"
    concept = concept or (
        "बारिश में उत्तर भारतीय कस्बे की आख़िरी बस; एक अकेली महिला यात्री, "
        "तीसरी खाली सीट, और पिछली दुर्घटना में मरी आत्मा"
    )
    project = new_project(project_id, "B", concept, 3)
    project["style_reference"] = STYLE_LOCK
    project["flow_project_name"] = f"YouTube Automation - {(title or 'Last Bus')[:48]}"
    save(path, project)

    if title:
        raw = "Title supplied directly by the user; idea selection intentionally skipped."
    else:
        idea_prompt = render(
            "ideas",
            {"CATEGORY": "", "CONCEPT": concept, "NUMBER_OF_IDEAS": 3},
        )
        raw = ask(
            client,
            idea_prompt + "\nReturn the numbered list exactly as requested. Do not invent real place names.",
            1800,
        )
    save_stage(path, project, "ideas", raw)
    project["idea"].update(status="done", raw_output=raw)

    # Lock the topic before subsequent stages so the premise cannot drift.
    if title:
        hook = ask(
            client,
            f"Write one single-sentence Devanagari Hindi folk-horror hook for this exact video title: {title}. "
            "Keep it original, set in a fictional North Indian town, and use no real people or places. "
            "Return only the hook.",
            220,
        )
        selected = {
            "index": 1,
            "title": title.strip(),
            "hook": hook.strip(),
            "entity_archetype": "Pret-aatma",
        }
    else:
        selected = {
            "index": 1,
            "title": "आख़िरी बस की तीसरी सीट (Aakhri Bus Ki Teesri Seat)",
            "hook": "बरसाती रात की आख़िरी बस में तीसरी सीट हर पड़ाव पर भीग जाती है, जबकि उस पर कोई दिखाई नहीं देता।",
            "entity_archetype": "Pret-aatma",
        }
    project["idea"].update(items=[selected], selected_index=1, selected=selected)
    save(path, project)

    story_prompt = render(
        "story",
        {
            "TITLE": selected["title"],
            "HOOK": selected["hook"],
            "LANGUAGE": "Hindi",
            "DURATION_MINUTES": 1,
            "WORD_COUNT": 150,
            "MONSTER": "बस की तीसरी सीट की प्रेत-आत्मा",
        },
    )
    raw = ask(
        client,
        story_prompt + "\nWrite the full 130–155-word Hindi story now. Use only fictional named people "
        "and a fictional unnamed North Indian town. Every line that will be spoken must be written in "
        "Devanagari. One female protagonist, one driver, one spectral woman. Do not switch to another premise.",
        4000,
    )
    project["script"].update(
        status="done",
        language="Hindi",
        duration_minutes=1,
        word_count=150,
        monster="प्रेत-आत्मा",
        raw_text=raw,
        raw_output=raw,
    )
    save(path, project)

    character_schema = """Return ONLY valid JSON:
{"characters":[{"tag":"@CHAR-01-NAME","name":"...","look_summary":"...","full_prompt":"...","voice_description":"..."}]}
All names/roles must come from the locked script. Never include a tag table as a character. Each full_prompt must be a complete 16:9 human-proportioned 2D reference-sheet prompt with exact face, clothes, age, and pose.
STRICT JSON RULES: Use double quotes around every key and every string value. Do not output bare Hindi text, comments, or trailing commas. Return one JSON object only."""
    raw = ask(
        client,
        render("characters", {"SCRIPT": project["script"]["raw_text"]}) + "\n" + character_schema,
        3000,
    )
    parsed_characters = parse_stage(path, project, "characters", raw).get("characters")
    if not isinstance(parsed_characters, list) or not parsed_characters:
        raise ValueError("Groq characters response must contain a non-empty 'characters' array")
    project["characters"] = [
        {**character, "status": "pending", "error": None}
        for character in parsed_characters
    ]
    save(path, project)

    background_schema = """Return ONLY valid JSON:
{"backgrounds":[{"tag":"#BGD-01-NAME","location_name":"...","look_summary":"...","full_prompt":"..."}]}
Every recurring location gets a wide and a close angle as separate tagged plates. All plates must be empty, 16:9, and in the locked 2D style.
STRICT JSON RULES: Use double quotes around every key and every string value. Do not output bare Hindi text, comments, or trailing commas. Return one JSON object only."""
    raw = ask(
        client,
        render("backgrounds", {"SCRIPT": project["script"]["raw_text"]}) + "\n" + background_schema,
        3000,
    )
    parsed_backgrounds = parse_stage(path, project, "backgrounds", raw).get("backgrounds")
    if not isinstance(parsed_backgrounds, list) or not parsed_backgrounds:
        raise ValueError("Groq backgrounds response must contain a non-empty 'backgrounds' array")
    project["backgrounds"] = normalize_background_tags([
        {**background, "status": "pending", "error": None}
        for background in parsed_backgrounds
    ])
    save(path, project)

    compact_chars = [
        {"tag": c["tag"], "name": c["name"], "look_summary": c["look_summary"]}
        for c in project["characters"]
    ]
    compact_bgs = [
        {"tag": b["tag"], "location_name": b["location_name"], "look_summary": b["look_summary"]}
        for b in project["backgrounds"]
    ]
    scene_prompt = render(
        "scenes",
        {
            "DURATION_MINUTES": 1,
            "MINIMUM_SCENES": 7,
            "SCENE_COUNT": 12,
            "SCRIPT": project["script"]["raw_text"],
            "CHARACTERS": json.dumps(compact_chars, ensure_ascii=False),
            "BACKGROUNDS": json.dumps(compact_bgs, ensure_ascii=False),
        },
    )
    scene_schema = """Return ONLY one valid JSON object with this structure:
{"scenes":[{"scene_number":1,"title":"...","background_tag":"#BGD-01-NAME","character_tags":["@CHAR-01-NAME"],"speaker":"NARRATOR|none|@CHAR-01-NAME","visual_action":"...","camera":"...","effects":"...","sound_design":"...","devanagari_dialogue":"...","narration_text":"..."}]}
Exactly 12 scenes in script order. Do not specify, request, or assume a fixed clip length: Flow must choose the natural length needed to complete the action and any dialogue. Use ONLY listed tags. Dialogue must be an exact line from the script; for narration, keep the exact line as metadata for later editing, not in the Flow animation prompt. For every NARRATOR or none scene, narration_text is mandatory: provide one concise Devanagari Hindi narration line consistent with the locked script, never blank. Do not invent character dialogue.
STRICT JSON SYNTAX: Every key and every string value must use double quotes. Example: "title": "लाइट फेड" — never write "title": लाइट फेड. Use JSON arrays for arrays, true/false/null only for JSON literals, no comments, and no trailing commas. Escape any double quotes inside string values. Start with { and finish with }. Return no markdown fences or explanation."""
    raw = ask(client, scene_prompt + "\n" + scene_schema, 6000)
    parsed_scenes = parse_stage(path, project, "scenes", raw).get("scenes")
    if not isinstance(parsed_scenes, list):
        raise ValueError("Groq scene response must contain a 'scenes' array")

    project["scenes"] = parsed_scenes
    save(path, project)

    validate(project)

    missing_scenes = [
        scene
        for scene in project["scenes"]
        if scene["speaker"] in {"NARRATOR", "none"}
        and not str(scene.get("narration_text", "")).strip()
    ]

    # Ask the model to fill only missing narration metadata. This is a small
    # repair call, not a regeneration of the story, characters, backgrounds,
    # or all 12 scenes.
    if missing_scenes:
        repair_context = [
            {
                "scene_number": scene["scene_number"],
                "title": scene.get("title", ""),
                "visual_action": scene.get("visual_action", ""),
                "camera": scene.get("camera", ""),
                "effects": scene.get("effects", ""),
                "speaker": scene.get("speaker", "none"),
                "character_tags": scene.get("character_tags", []),
                "devanagari_dialogue": scene.get("devanagari_dialogue", ""),
            }
            for scene in missing_scenes
        ]
        narration_repair_prompt = (
            "Fill only the missing narration metadata for the listed horror-story scenes. "
            "Use the locked Hindi story and each scene's visual action. Return ONLY valid JSON "
            'with this shape: {"narration":[{"scene_number":4,"narration_text":"..."}]}. '
            "Include exactly one item for each requested scene number and no others. "
            "Every narration_text must be one concise, natural Hindi sentence in Devanagari, "
            "consistent with the locked story and scene. Prefer an exact sentence from the story "
            "when appropriate. This is narration metadata for later voiceover, not character "
            "dialogue. Do not add English transliteration, labels, markdown, or explanations. "
            "Every JSON key and string value must use double quotes; no trailing commas.\n\n"
            "LOCKED STORY:\n"
            + str(project["script"].get("raw_text", ""))
            + "\n\nSCENES NEEDING NARRATION:\n"
            + json.dumps(repair_context, ensure_ascii=False)
        )
        repair_raw = ask(client, narration_repair_prompt, 1600)
        repair_data = parse_stage(path, project, "narration_repair", repair_raw)
        repair_items = repair_data.get("narration", [])
        if not isinstance(repair_items, list):
            repair_items = []

        allowed_numbers = {int(scene["scene_number"]) for scene in missing_scenes}
        narration_by_number: dict[int, str] = {}
        for item in repair_items:
            if not isinstance(item, dict):
                continue
            try:
                number = int(item.get("scene_number"))
            except (TypeError, ValueError):
                continue
            narration_text = str(item.get("narration_text", "")).strip()
            if (
                number in allowed_numbers
                and narration_text
                and re.search(r"[\u0900-\u097F]", narration_text)
            ):
                narration_by_number[number] = narration_text

        for scene in project["scenes"]:
            number = int(scene["scene_number"])
            if number in narration_by_number and not str(scene.get("narration_text", "")).strip():
                scene["narration_text"] = narration_by_number[number]

        save(path, project)

    still_missing = [
        str(scene["scene_number"])
        for scene in project["scenes"]
        if scene["speaker"] in {"NARRATOR", "none"}
        and not str(scene.get("narration_text", "")).strip()
    ]
    if still_missing:
        raise ValueError(
            "Could not generate valid Devanagari narration text for scene(s): "
            f"{', '.join(still_missing)}. The attempted repair response was saved in "
            f"{path.with_name(path.stem + '_invalid_narration_repair.txt')} if JSON parsing failed, "
            "or in pipeline.json under raw_stages.narration_repair."
        )

    save(path, project)
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-id", default="youtube-automation-last-bus")
    parser.add_argument(
        "--model",
        default=None,
        help="Optional model override for the selected OpenAI or Groq provider.",
    )
    parser.add_argument(
        "--title",
        default=None,
        help="A supplied title skips idea selection and generates the locked 12-scene project.",
    )
    parser.add_argument(
        "--concept",
        default=None,
        help="Optional premise detail to guide the title-based story.",
    )
    args = parser.parse_args()
    print(generate(args.project_id, args.model, title=args.title, concept=args.concept))
