import unittest

import protocol
from protocol import normalize_brain_result, parse_client_packet


class ClientProtocolTest(unittest.TestCase):
    def test_accepts_known_packet_with_object_payload(self):
        packet_type, payload = parse_client_packet(
            '{"type":"text_input","payload":{"text":"hello"}}'
        )

        self.assertEqual(packet_type, "text_input")
        self.assertEqual(payload, {"text": "hello"})

    def test_rejects_malformed_or_unknown_packets(self):
        for raw in (
            "not-json",
            "[]",
            '{"type":"unknown"}',
            '{"type":"text_input","payload":[]}',
            '{"type":"text_input","payload":{}}',
            '{"type":"text_input","payload":{"text":"   "}}',
            '{"type":"audio_input","payload":{"audio_base64":1}}',
            '{"type":"audio_input","payload":{"audio_base64":""}}',
            '{"type":"persona_change","payload":{}}',
        ):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_client_packet(raw)

        oversized_text = '{"type":"text_input","payload":{"text":"' + "x" * 20_001 + '"}}'
        with self.assertRaisesRegex(ValueError, "text is too long"):
            parse_client_packet(oversized_text)

    def test_rejects_oversized_packets_before_parsing(self):
        with self.assertRaisesRegex(ValueError, "too large"):
            parse_client_packet("x" * (8 * 1024 * 1024 + 1))

    def test_normalizes_untrusted_model_output(self):
        self.assertEqual(
            normalize_brain_result(None),
            {"reply": "", "emotion": "neutral", "memory_operation": {}},
        )
        self.assertEqual(
            normalize_brain_result({
                "reply": 7,
                "emotion": "unknown",
                "memory_operation": [],
            }),
            {"reply": "", "emotion": "neutral", "memory_operation": {}},
        )
        valid = {
            "reply": "hello",
            "emotion": "happy",
            "memory_operation": {"new_episode": "met again"},
        }
        self.assertEqual(normalize_brain_result(valid), valid)

    def test_audio_mime_type_maps_to_a_safe_extension(self):
        self.assertEqual(protocol.audio_extension("audio/webm"), "webm")
        self.assertEqual(protocol.audio_extension("audio/wav"), "wav")
        self.assertEqual(protocol.audio_extension("../../secret"), "webm")

    def test_accepts_voice_transcribe_audio_without_starting_a_turn(self):
        packet_type, payload = parse_client_packet(
            '{"type":"voice_transcribe","payload":{"audio_base64":"abc","format":"audio/webm"}}'
        )

        self.assertEqual(packet_type, "voice_transcribe")
        self.assertEqual(payload["audio_base64"], "abc")

    def test_image_mime_type_is_allowlisted(self):
        self.assertEqual(protocol.image_mime_type("image/png"), "image/png")
        self.assertEqual(protocol.image_mime_type("image/webp"), "image/webp")
        self.assertEqual(protocol.image_mime_type("text/html"), "image/jpeg")


if __name__ == "__main__":
    unittest.main()
