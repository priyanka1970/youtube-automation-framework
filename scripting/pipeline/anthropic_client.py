"""Provider-neutral text client for the scripting half of the pipeline."""

import json
import os
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

Provider = Literal["openai", "groq"]

DEFAULT_MODELS: dict[Provider, str] = {
    "openai": "gpt-4.1-mini",
    "groq": "openai/gpt-oss-120b",
}


def select_provider() -> Provider:
    """Prefer OpenAI when its API key is configured."""
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    if os.getenv("GROQ_API_KEY"):
        return "groq"
    raise RuntimeError(
        "No writing-model key found. Add OPENAI_API_KEY or GROQ_API_KEY "
        "to scripting/.env or set it in your environment."
    )


class ScriptClient:
    """Text-completions adapter using the available provider."""

    def __init__(self, provider: Provider | None = None, model: str | None = None):
        self.provider = provider or select_provider()
        self.model = (
            model
            or os.getenv(f"{self.provider.upper()}_MODEL")
            or DEFAULT_MODELS[self.provider]
        )

        if self.provider == "openai":
            from openai import OpenAI
            self.client = OpenAI()
        else:
            from groq import Groq
            self.client = Groq()

    def complete(
        self,
        prompt: str,
        max_tokens: int = 7000,
        temperature: float = 0,
        retries: int = 2,
    ) -> str:
        last_error = None

        for attempt in range(retries + 1):
            try:
                request_args = {
                    "model": self.model,
                    "temperature": temperature,
                    "messages": [{"role": "user", "content": prompt}],
                }

                if self.provider == "groq":
                    request_args["max_completion_tokens"] = max_tokens

                    if self.model.startswith("openai/gpt-oss-"):
                        request_args["reasoning_effort"] = "low"
                else:
                    request_args["max_tokens"] = max_tokens

                response = self.client.chat.completions.create(**request_args)
                choice = response.choices[0]
                content = choice.message.content or ""

                if not content.strip():
                    raise ValueError(
                        f"{self.provider} returned empty content. "
                        f"Model={response.model}, "
                        f"finish_reason={choice.finish_reason}, "
                        f"reasoning={getattr(choice.message, 'reasoning', None)!r}"
                    )

                return content

            except Exception as exc:
                last_error = exc
                if attempt < retries:
                    continue

        raise ValueError(
            f"{self.provider} failed after {retries + 1} attempts: {last_error}"
        )


# Compatibility names used by the existing stage CLI.
GroqClient = ScriptClient
Claude = ScriptClient


def parse_jsonish(raw: str):
    text = raw.strip()

    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        starts = [
            i for i in (text.find("["), text.find("{")) if i >= 0
        ]
        start = min(starts, default=-1)
        end = max(text.rfind("]"), text.rfind("}"))

        if start >= 0 and end > start:
            return json.loads(text[start:end + 1])

        raise ValueError(
            "Model output was not valid JSON; preserve the raw output "
            "and inspect the template's required structure."
        )