import { useEffect, useRef } from 'react';
import { rmsVolume, volumeToMouth, smoothMouth } from '../lipSync';

/**
 * 口型同步 - 采集正在播放的 TTS 音量，实时驱动 Live2D 嘴型。
 *
 * 用法：
 *   const { analyserRef, isPlaying } = useAudioQueue(...)
 *   useLipSync(getModel, analyserRef, isPlaying)
 *
 * 播放时：RAF 读 analyser 时域数据 → RMS → 嘴开合 → ParamMouthOpenY / JawOpen。
 * 不播放时：嘴平滑闭合到 0，避免张着嘴定格。
 */
export function useLipSync(getModel, analyserRef, isPlaying) {
  const rafRef = useRef(null);
  const mouthRef = useRef(0); // 平滑后的当前嘴开合
  const samplesRef = useRef(null);

  const getModelRef = useRef(getModel);
  getModelRef.current = getModel;

  useEffect(() => {
    const setParam = (core, id, val) => {
      try { core.setParameterValueById(id, val); } catch { /* 参数不存在则忽略 */ }
    };

    const closeMouth = () => {
      mouthRef.current = 0;
      const model = getModelRef.current && getModelRef.current();
      const core = model?.internalModel?.coreModel;
      if (!core) return;
      setParam(core, 'ParamMouthOpenY', 0);
      setParam(core, 'JawOpen', 0);
      setParam(core, 'ParamMouthForm', 0);
    };

    if (!isPlaying) {
      closeMouth();
      return;
    }

    const tick = () => {
      const model = getModelRef.current && getModelRef.current();
      const core = model?.internalModel?.coreModel;

      const analyser = analyserRef?.current;

      let target = 0;
      if (core && analyser) {
        if (!samplesRef.current || samplesRef.current.length !== analyser.fftSize) {
          samplesRef.current = new Uint8Array(analyser.fftSize);
        }
        analyser.getByteTimeDomainData(samplesRef.current);
        const vol = rmsVolume(samplesRef.current);
        target = volumeToMouth(vol);
      }

      // 平滑：播放时跟随快，闭合时稍慢，避免嘴"啪"地合上。
      const alpha = target > mouthRef.current ? 0.45 : 0.25;
      mouthRef.current = smoothMouth(mouthRef.current, target, alpha);

      if (core) {
        const m = mouthRef.current;
        setParam(core, 'ParamMouthOpenY', m);
        setParam(core, 'JawOpen', m);
        // 嘴形（微笑/抿嘴）：张开时偏微笑，闭合时中性。
        setParam(core, 'ParamMouthForm', m * 0.4);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [analyserRef, isPlaying]);
}
