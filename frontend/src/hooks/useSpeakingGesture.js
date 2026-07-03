import { useEffect, useRef } from 'react';

/**
 * 说话手势 - AI 说话时周期性轻微摆动手部和肩膀，增加表达感。
 *
 * 用法：useSpeakingGesture(getModel, isPlaying)
 *
 * 不说话时手部归零（回中立位）。幅度刻意保持小，避免动作诡异。
 * 与口型同步并行：口型高频跟音量，手势低频周期性，互不冲突（不同参数）。
 *
 * 手部参数取自 PinkFox.cdi3.json：Param33-36 左手、Param37-40 右手、ShoulderZ 肩。
 */
const HAND_PARAMS = ['Param33', 'Param34', 'Param35', 'Param36', 'Param37', 'Param38', 'Param39', 'Param40'];
const SHOULDER_PARAMS = ['ShoulderZ'];
const ALL_GESTURE_PARAMS = [...HAND_PARAMS, ...SHOULDER_PARAMS];

export function useSpeakingGesture(getModel, isPlaying) {
  const rafRef = useRef(null);
  const stateRef = useRef({
    nextGesture: 0,   // 下次手势开始时间
    active: null,     // 当前手势 { params, start, duration, raf }
  });

  const getModelRef = useRef(getModel);
  getModelRef.current = getModel;

  useEffect(() => {
    const setParam = (core, id, val) => {
      try { core.setParameterValueById(id, val) } catch { /* 参数不存在则忽略 */ }
    };

    // 选一组轻微手势目标：随机挑 1-2 个手部参数小幅动 + 肩膀轻摆。
    const pickGesture = () => {
      const params = {};
      // 50% 概率动左手组，50% 动右手组，幅度都很小。
      if (Math.random() < 0.5) {
        params['Param34'] = 0.3 + Math.random() * 0.3;
        params['Param36'] = 0.2 + Math.random() * 0.2;
      } else {
        params['Param38'] = 0.3 + Math.random() * 0.3;
        params['Param40'] = 0.2 + Math.random() * 0.2;
      }
      params['ShoulderZ'] = (Math.random() - 0.5) * 6;
      return { params, duration: 600 + Math.random() * 500 };
    };

    const zeroAll = (core) => {
      for (const id of ALL_GESTURE_PARAMS) setParam(core, id, 0);
    };

    const resetGesture = () => {
      stateRef.current.active = null;
      stateRef.current.nextGesture = 0;
      const model = getModelRef.current && getModelRef.current();
      const core = model?.internalModel?.coreModel;
      if (core) zeroAll(core);
    };

    if (!isPlaying) {
      resetGesture();
      return;
    }

    const tick = () => {
      const model = getModelRef.current && getModelRef.current();
      const core = model?.internalModel?.coreModel;

      if (!core) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const now = performance.now();
      const s = stateRef.current;

      if (s.active) {
        const elapsed = now - s.active.start;
        const t = Math.min(1, elapsed / s.active.duration);
        const w = Math.sin(t * Math.PI); // 钟形
        for (const [id, target] of Object.entries(s.active.params)) {
          setParam(core, id, target * w);
        }
        if (t >= 1) {
          // 手势结束，归零这次用到的参数，安排下一次。
          for (const id of Object.keys(s.active.params)) setParam(core, id, 0);
          s.active = null;
          s.nextGesture = now + 150 + Math.random() * 400; // 间隔
        }
      } else if (now >= s.nextGesture) {
        const g = pickGesture();
        s.active = { ...g, start: now };
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      resetGesture();
    };
  }, [isPlaying]);
}
