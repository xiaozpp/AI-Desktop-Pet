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

# 语音客户端 (SiliconFlow)
client_audio = AsyncOpenAI(
    api_key=Config.SILICON_KEY,
    base_url=Config.SILICON_BASE
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
                format=AudioFormat.MP3_22050HZ_MONO_256KBPS,
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
        
     #   调用 SenseVoice 识别 WebM/WAV 音频
        
        try:
            #  解码 Base64 -> Bytes
            audio_bytes = base64.b64decode(audio_base64)
            
            # 包装成类似文件的对象 (name 属性很重要，要是 .webm)
            audio_file = io.BytesIO(audio_bytes)
            audio_file.name = f"input.{audio_extension(audio_format)}"

            #  发送请求
            transcript = await client_audio.audio.transcriptions.create(
                model=Config.STT_MODEL,
                file=audio_file
            )
            return transcript.text
        except Exception as e:
            print(f"❌ STT 失败: {e}")
            return ""
    @staticmethod
    async def get_embedding(text: str):
        #向量化
        try:
            # 只有确实需要存经历时才调这个
            if not text: return None
            response = await client_audio.embeddings.create(
                model="Qwen/Qwen3-Embedding-8B",
                input=text
            )
            return response.data[0].embedding
        except: return None
