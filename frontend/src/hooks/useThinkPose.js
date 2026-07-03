import { useEffect, useRef } from 'react';

/**
 * 思考表情 - AI 思考时让角色表现"在想"：头微抬、眉头微聚、轻眯眼。
 *
 * 用法：useThinkPose(getModel, isThinking)
 *
 * 思考时把参数平滑过渡到"思考姿态"目标，思考结束归零。
 * 与 idle 互不冲突（idle 在 thinking 时通常仍在跑，但 idle 写的呼吸/环顾幅度小，
 * think 写的是 HeadAngleY/Brow/EyeSquint，短暂的思考姿态优先级高于 idle 环顾）。
 */
const THINK_PARAMS = {
  HeadAngleY: -8,      // 抬头看上方
  ParamBrowLY: -0.4,   // 眉毛微聚（负=下沉聚神）
  ParamBrowRY: -0.4,
  EyeSquint: 0.5,      // 轻眯眼
};

export function useThinkPose(getModel, isThinking) {
  const rafRef = useRef(null);
  // 当前值（平滑插值用）。0=中性，1=完全思考姿态。
  const poseRef = useRef(0);

  const getModelRef = useRef(getModel);
  getModelRef.current = getModel;

  useEffect(() => {
    const setParam = (core, id, val) => {
      try { core.setParameterValueById(id, val) } catch { /* 参数不存在则忽略 */ }
    };

    const resetPose = () => {
      poseRef.current = 0;
      const model = getModelRef.current && getModelRef.current();
      const core = model?.internalModel?.coreModel;
      if (!core) return;
      for (const id of Object.keys(THINK_PARAMS)) setParam(core, id, 0);
    };

    if (!isThinking) {
      resetPose();
      return;
    }

    const tick = () => {
      const model = getModelRef.current && getModelRef.current();
      const core = model?.internalModel?.coreModel;
      if (!core) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const target = isThinking ? 1 : 0;
      // 平滑：进入思考慢一点（酝酿），退出快一点（想完了立即恢复）。
      const alpha = target > poseRef.current ? 0.06 : 0.12;
      poseRef.current = poseRef.current + (target - poseRef.current) * alpha;

      for (const [id, val] of Object.entries(THINK_PARAMS)) {
        setParam(core, id, val * poseRef.current);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      resetPose();
    };
  }, [isThinking]);
}
