import base64
import io
import asyncio
from openai import AsyncOpenAI
from config import Config
import json
from protocol import audio_extension, image_mime_type

#  主脑客户端 (DeepSeek - 纯文本对话)
client_main = AsyncOpenAI(
    api_key=Config.LLM_API_KEY,
    base_url=Config.LLM_BASE_URL
)

# 视觉客户端 (GLM-4V - 看屏幕专用；DeepSeek 无视觉能力，多模态请求走这里)
client_vision = AsyncOpenAI(
    api_key=Config.VISION_API_KEY,
    base_url=Config.VISION_BASE_URL
)

# 语音客户端 (SiliconFlow，用于 Embedding)
client_audio = AsyncOpenAI(
    api_key=Config.SILICON_KEY,
    base_url=Config.SILICON_BASE
)

# 阿里云百炼 OpenAI 兼容客户端（STT 用，复用 DASHSCOPE_API_KEY）
client_dashscope_stt = AsyncOpenAI(
    api_key=Config.DASHSCOPE_API_KEY,
    base_url=Config.DASHSCOPE_COMPAT_BASE,
)

class AIService:
    @staticmethod
    async def chat_with_neuro_brain(
        messages: list,
        image_base64: str = None,
        image_mime: str = "image/jpeg",
        timeout=30.0,
    ):
        """
        ✅ 核心方法：主脑接口
        一次性完成 [思考 -> 回复 -> 记忆操作]
        - 纯文本：走 client_main (DeepSeek)，强制 JSON 模式
        - 多模态(带图)：走 client_vision (GLM-4V)，prompt 约束 JSON + 容错解析
        """
        try:
            if image_base64:
                # 多模态分支：用视觉模型，把最后一条消息改成图文格式
                last_msg = messages[-1]
                content_text = last_msg["content"] if isinstance(last_msg["content"], str) else last_msg["content"][0].get("text", "")

                # 构造带图消息
                new_content = [
                    {"type": "text", "text": content_text},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{image_mime_type(image_mime)};base64,{image_base64}"
                        }
                    }
                ]
                # 替换原来的纯文本消息（复制一份，避免污染主 messages）
                messages = messages.copy()
                messages[-1] = {**last_msg, "content": new_content}

                response = await client_vision.chat.completions.create(
                    model=Config.VISION_MODEL,
                    messages=messages,
                    temperature=0.7,
                    max_tokens=4096,
                    timeout=timeout,
                    # GLM-4V 对 response_format json_object 支持不稳，靠 prompt 约束
                )
            else:
                # 纯文本分支：DeepSeek 主脑，强制 JSON
                response = await client_main.chat.completions.create(
                    model=Config.LLM_MODEL,
                    messages=messages,
                    temperature=0.7,
                    max_tokens=4096,
                    timeout=timeout,
                    response_format={"type": "json_object"}
                )
            content = response.choices[0].message.content

            # 容错 JSON 解析：多模态分支可能返回非标准 JSON
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                # 尝试提取被 ```json ... ``` 包裹的内容
                import re
                m = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', content, re.DOTALL)
                if m:
                    return json.loads(m.group(1))
                # 兜底：把整段当 reply
                return {
                    "reply": content.strip() or "（大脑短路中...）",
                    "emotion": "neutral",
                    "memory_operation": {},
                    "thought": "非标准 JSON，已降级处理"
                }
        except Exception as e:
            print(f"❌ 主脑思考失败: {e}")
            # 兜底返回，防止 main.py 崩溃
            return {
                "reply": "（大脑短路中...）",
                "emotion": "dizzy",
                "memory_operation": {},
                "thought": f"API调用出错: {str(e)}"
            }

    @staticmethod
    async def analyze_intent(text: str):
        """
        快速分析用户意图 (勿扰/普通对话)，复用主脑 client
        """
        system_prompt = """
        你是一个意图分析器。分析用户的输入，返回 JSON 格式：
        {"action": "silence"} - 如果用户表示忙、别吵、安静。
        {"action": "chat"} - 普通聊天。
        """
        try:
            response = await client_main.chat.completions.create(
                model=Config.LLM_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": text}
                ],
                response_format={"type": "json_object"} # 强制 JSON
            )
            return response.choices[0].message.content
        except:
            return '{"action": "chat"}'

    @staticmethod
    async def text_to_speech(text: str, emotion: str = "happy"):
        """
        调用阿里云百炼 CosyVoice 生成语音（御姐音 longanyang）
        用 dashscope SDK 的 WebSocket 实时合成（实测稳定；HTTP API 会 url error）
        SDK 是同步阻塞的，用 asyncio.to_thread 包装避免卡事件循环
        返回 base64 编码的 mp3
        """
        if not Config.DASHSCOPE_API_KEY or Config.DASHSCOPE_API_KEY.startswith("your-"):
            print("⚠️ 未配置 DASHSCOPE_API_KEY，跳过 TTS")
            return None

        def _synch():
            """同步合成（在线程里跑）"""
            import dashscope
            from dashscope.audio.tts_v2 import SpeechSynthesizer, AudioFormat, ResultCallback

            dashscope.api_key = Config.DASHSCOPE_API_KEY

            class _Cb(ResultCallback):
                def __init__(self): self.chunks = []; self.err = None
                def on_open(self): pass
                def on_complete(self): pass
                def on_error(self, m): self.err = str(m)[:150]
                def on_close(self): pass
                def on_event(self, e): pass
                def on_data(self, d): self.chunks.append(d)

            cb = _Cb()
            synth = SpeechSynthesizer(
                model=Config.TTS_MODEL,
                voice=Config.TTS_VOICE,
                # OGG_OPUS 比 MP3 快约 2 倍（首包 0.7s vs 1.7s），Chromium 原生支持播放。
                # 文件更小也减少 WebSocket 传输耗时。
                format=AudioFormat.OGG_OPUS_24KHZ_MONO_32KBPS,
                callback=cb,
            )
            synth.streaming_call(text)
            synth.streaming_complete()

            if cb.err:
                raise RuntimeError(f"CosyVoice 引擎错误: {cb.err}")
            if not cb.chunks:
                raise RuntimeError("CosyVoice 未返回音频数据")
            return b"".join(cb.chunks)

        try:
            audio_bytes = await asyncio.to_thread(_synch)
            return base64.b64encode(audio_bytes).decode("utf-8")
        except Exception as e:
            print(f"❌ TTS 失败: {e}")
            return None

    @staticmethod
    async def speech_to_text(audio_base64: str, audio_format: str | None = None):

     #   语音识别 (STT)。默认走阿里云 Qwen-ASR (OpenAI 兼容模式)，复用 DASHSCOPE_API_KEY。
     #   通过 STT_PROVIDER=siliconflow 可回退到旧的 SenseVoiceSmall（需要有效 SILICON_API_KEY）。

        try:
            audio_bytes = base64.b64decode(audio_base64)
            print(f"🎤 STT: 收到音频 {len(audio_bytes)} bytes, format={audio_format}, provider={Config.STT_PROVIDER}")

            if Config.STT_PROVIDER == "siliconflow":
                # 旧路径：SiliconFlow SenseVoiceSmall，audio.transcriptions 接口
                audio_file = io.BytesIO(audio_bytes)
                audio_file.name = f"input.{audio_extension(audio_format)}"
                print(f"🎤 STT[硅基]: 文件名={audio_file.name}, 模型={Config.STT_MODEL}")
                transcript = await client_audio.audio.transcriptions.create(
                    model=Config.STT_MODEL,
                    file=audio_file,
                )
                result = transcript.text
            else:
                # 新路径：阿里云 Qwen-ASR，OpenAI 兼容 chat.completions 接口
                # 阿里云要求 audio 输入为可访问 URL 或 data URI；这里用 base64 内联，无需公网存储。
                ext = audio_extension(audio_format)  # webm/wav/mp3/m4a
                data_uri = f"data:audio/{ext};base64,{audio_base64}"
                print(f"🎤 STT[阿里云]: 模型={Config.DASHSCOPE_STT_MODEL}")
                completion = await client_dashscope_stt.chat.completions.create(
                    model=Config.DASHSCOPE_STT_MODEL,
                    messages=[{
                        "role": "user",
                        "content": [{"type": "input_audio", "input_audio": {"data": data_uri}}],
                    }],
                )
                # 兼容两种返回结构：标准 choices[0].message.content 或自定义字段
                result = completion.choices[0].message.content if completion.choices else ""
                if not result and hasattr(completion, "text"):
                    result = completion.text or ""

            print(f"🎤 STT 结果: '{(result or '')[:100] if result else '(空)'}'")
            return result or ""
        except Exception as e:
            print(f"❌ STT 失败: {e}")
            import traceback
            traceback.print_exc()
            return ""
    @staticmethod
    async def get_embedding(text: str):
        #向量化。默认走阿里云 DashScope（复用 DASHSCOPE_API_KEY），
        # 避免因 SiliconFlow key 失效导致记忆检索每次白等近 1 秒。
        try:
            # 只有确实需要存经历时才调这个
            if not text: return None
            response = await client_dashscope_stt.embeddings.create(
                model="text-embedding-v3",
                input=text
            )
            return response.data[0].embedding
        except Exception as e:
            print(f"⚠️ embedding 失败: {e}")
            return None
