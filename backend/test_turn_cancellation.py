import unittest

from turns import make_generation_send


class TurnGuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_stale_generation_does_not_send(self):
        sent = []
        current_generation = 2

        async def send_func(type_str, payload):
            sent.append((type_str, payload))

        guarded = make_generation_send(
            send_func,
            generation=1,
            is_current=lambda value: value == current_generation,
        )

        await guarded("audio_chunk", {"text": "old"})

        self.assertEqual(sent, [])

    async def test_current_generation_sends(self):
        sent = []

        async def send_func(type_str, payload):
            sent.append((type_str, payload))

        guarded = make_generation_send(
            send_func,
            generation=3,
            is_current=lambda value: value == 3,
        )

        await guarded("voice_transcript", {"text": "绒绒"})

        self.assertEqual(sent, [("voice_transcript", {"text": "绒绒"})])
