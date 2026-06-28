import json


MAX_PACKET_CHARS = 8 * 1024 * 1024
PACKET_TYPES = {"text_input", "audio_input", "voice_transcribe", "persona_change", "interrupt"}
BRAIN_EMOTIONS = {"happy", "neutral", "bored", "angry", "sad", "shy", "love"}
AUDIO_EXTENSIONS = {
    "audio/webm": "webm",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
}
IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


def audio_extension(mime_type: str | None) -> str:
    return AUDIO_EXTENSIONS.get(mime_type, "webm")


def image_mime_type(mime_type: str | None) -> str:
    return mime_type if mime_type in IMAGE_MIME_TYPES else "image/jpeg"


def normalize_brain_result(value):
    if not isinstance(value, dict):
        value = {}
    reply = value.get("reply")
    emotion = value.get("emotion")
    memory_operation = value.get("memory_operation")
    return {
        "reply": reply if isinstance(reply, str) else "",
        "emotion": emotion if emotion in BRAIN_EMOTIONS else "neutral",
        "memory_operation": memory_operation if isinstance(memory_operation, dict) else {},
    }


def parse_client_packet(raw: str):
    if not isinstance(raw, str) or len(raw) > MAX_PACKET_CHARS:
        raise ValueError("packet too large")
    try:
        packet = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("invalid JSON") from exc
    if not isinstance(packet, dict) or packet.get("type") not in PACKET_TYPES:
        raise ValueError("unknown packet type")

    packet_type = packet["type"]
    payload = packet.get("payload", {})
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    if packet_type == "text_input":
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text is required")
        if len(text) > 20_000:
            raise ValueError("text is too long")
    if packet_type in {"audio_input", "voice_transcribe"}:
        audio = payload.get("audio_base64")
        if not isinstance(audio, str) or not audio:
            raise ValueError("audio is required")
    if packet_type == "persona_change":
        persona_id = payload.get("persona_id")
        if not isinstance(persona_id, str) or not persona_id:
            raise ValueError("persona_id is required")
    return packet_type, payload
