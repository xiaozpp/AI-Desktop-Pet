// frontend/src/components/MemoryPanel.jsx
// 记忆面板：让用户直观看到"桌宠记得什么"，并能单条删除/导出/清空。
// 调用后端 /memory/* API（带 token 鉴权），与 MainPage 解耦：只接收 token + onClose。
//
// 设计原则（AGENTS.md）：
// - 不引入养成数值/喂食等虚假玩法，纯记忆管理。
// - 删除/清空操作有二次确认，防误触。
// - 加载/空态/错误态都显式处理，不让 UI 卡死。
import { useCallback, useEffect, useState } from 'react';
import { getApiBaseUrl } from '../apiConfig';
import './MemoryPanel.css';

const API_BASE_URL = getApiBaseUrl();
const AUTH_STORAGE_KEY = 'desktop_pet_auth';

// 经历主题配色（与后端 memory.py TOPIC_KEYWORDS 对应）
const TOPIC_STYLE = {
  work:    { label: '工作', cls: 'work' },
  study:   { label: '学习', cls: 'study' },
  life:    { label: '生活', cls: 'life' },
  health:  { label: '健康', cls: 'health' },
  relation:{ label: '关系', cls: 'relation' },
  other:   { label: '其他', cls: 'other' },
};

// 重要度星级：salience 0.9→3星, 0.6→2星, 0.4→1星
function salienceStars(salience) {
  const s = Number(salience) || 0;
  if (s >= 0.8) return '★★★';
  if (s >= 0.55) return '★★';
  if (s >= 0.35) return '★';
  return '';
}

export default function MemoryPanel({ onClose }) {
  const [tab, setTab] = useState('episodes'); // 'facts' | 'episodes'
  const [facts, setFacts] = useState(null);   // null=未加载, {}=已加载空
  const [episodes, setEpisodes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  // 从 localStorage 取 token（与 MainPage 鉴权流一致）
  const getToken = useCallback(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || '{}');
      return saved?.token || '';
    } catch {
      return '';
    }
  }, []);

  const authHeaders = useCallback(() => ({
    Authorization: `Bearer ${getToken()}`,
  }), [getToken]);

  // 拉事实
  const loadFacts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/memory/facts`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`加载失败 (${res.status})`);
      const data = await res.json();
      setFacts(data.facts || {});
    } catch (e) {
      setError(e.message || '加载失败');
      setFacts({});
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  // 拉经历
  const loadEpisodes = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/memory/episodes?limit=100`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`加载失败 (${res.status})`);
      const data = await res.json();
      setEpisodes(data.episodes || []);
    } catch (e) {
      setError(e.message || '加载失败');
      setEpisodes([]);
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  // 切 tab 时懒加载
  useEffect(() => {
    if (tab === 'facts' && facts === null) loadFacts();
    if (tab === 'episodes' && episodes === null) loadEpisodes();
  }, [tab, facts, episodes, loadFacts, loadEpisodes]);

  // 删除单条经历
  const handleDeleteEpisode = useCallback(async (id) => {
    if (!id) return;
    if (!window.confirm('确定让 Neuro 忘记这条记忆吗？此操作不可撤销。')) return;
    try {
      const res = await fetch(`${API_BASE_URL}/memory/episodes/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`删除失败 (${res.status})`);
      setEpisodes(prev => (prev || []).filter(ep => ep.id !== id));
    } catch (e) {
      setError(e.message || '删除失败');
    }
  }, [authHeaders]);

  // 导出全部
  const handleExport = useCallback(async () => {
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/memory/export`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`导出失败 (${res.status})`);
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `neuro-memory-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || '导出失败');
    }
  }, [authHeaders]);

  // 清空全部（二次确认）
  const handleClearAll = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/memory/all?confirm=yes`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`清空失败 (${res.status})`);
      setFacts({});
      setEpisodes([]);
      setConfirmClear(false);
    } catch (e) {
      setError(e.message || '清空失败');
      setConfirmClear(false);
    }
  }, [authHeaders, confirmClear]);

  const handleRefresh = useCallback(() => {
    if (tab === 'facts') loadFacts();
    else loadEpisodes();
  }, [tab, loadFacts, loadEpisodes]);

  const factEntries = facts ? Object.entries(facts) : [];
  const episodeList = episodes || [];

  return (
    <div className="memory-panel-overlay" onClick={onClose}>
      <div className="memory-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="记忆管理">
        <div className="memory-panel-header">
          <span className="memory-panel-title">🧠 Neuro 的记忆</span>
          <button className="memory-panel-close" onClick={onClose} title="关闭">×</button>
        </div>

        <div className="memory-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'episodes'}
            className={`memory-tab ${tab === 'episodes' ? 'active' : ''}`}
            onClick={() => setTab('episodes')}
          >
            经历 ({episodeList.length})
          </button>
          <button
            role="tab"
            aria-selected={tab === 'facts'}
            className={`memory-tab ${tab === 'facts' ? 'active' : ''}`}
            onClick={() => setTab('facts')}
          >
            事实 ({factEntries.length})
          </button>
        </div>

        {error && <div className="memory-error">{error}</div>}

        <div className="memory-content">
          {loading ? (
            <div className="memory-empty">加载中...</div>
          ) : tab === 'episodes' ? (
            episodeList.length === 0 ? (
              <div className="memory-empty">
                {episodes === null ? '加载中...' : '还没有经历记忆。和 Neuro 聊聊天，她会记住重要的事。'}
              </div>
            ) : (
              <ul className="memory-list">
                {episodeList.map((ep) => {
                  const topic = TOPIC_STYLE[ep.topic] || TOPIC_STYLE.other;
                  return (
                    <li key={ep.id} className={`memory-item topic-${topic.cls}`}>
                      <div className="memory-item-meta">
                        <span className="memory-date">{ep.date} {ep.time}</span>
                        <span className={`memory-topic topic-${topic.cls}`}>{topic.label}</span>
                        {ep.emotion && ep.emotion !== 'neutral' && (
                          <span className="memory-emotion">{ep.emotion}</span>
                        )}
                        <span className="memory-salience" title="重要度">{salienceStars(ep.salience)}</span>
                        {ep.access_count > 0 && (
                          <span className="memory-access" title="被想起次数">↻{ep.access_count}</span>
                        )}
                      </div>
                      <div className="memory-item-content">{ep.content}</div>
                      <button
                        className="memory-item-delete"
                        onClick={() => handleDeleteEpisode(ep.id)}
                        title="忘记这条"
                      >
                        忘记
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : (
            factEntries.length === 0 ? (
              <div className="memory-empty">
                {facts === null ? '加载中...' : '还没有事实记忆。告诉 Neuro 你的喜好和习惯，她会记住。'}
              </div>
            ) : (
              <ul className="memory-list">
                {factEntries.map(([key, value]) => (
                  <li key={key} className="memory-fact">
                    <span className="memory-fact-key">{key}</span>
                    <span className="memory-fact-value">{String(value)}</span>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>

        <div className="memory-panel-actions">
          <button className="memory-action-btn" onClick={handleRefresh} disabled={loading}>
            刷新
          </button>
          <button className="memory-action-btn" onClick={handleExport}>
            导出
          </button>
          <button
            className={`memory-action-btn danger ${confirmClear ? 'confirm' : ''}`}
            onClick={handleClearAll}
          >
            {confirmClear ? '再次点击确认清空' : '清空全部'}
          </button>
        </div>
      </div>
    </div>
  );
}
