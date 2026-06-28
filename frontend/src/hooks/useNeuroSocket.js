import { useRef, useEffect, useCallback, useState } from 'react';

const RECONNECT_DELAY_MS = 2000;

export function useNeuroSocket(url, onMessage) {
  const wsRef = useRef(null);
  const [connectionStatus, setConnectionStatus] = useState(url ? 'connecting' : 'idle');
  const [reconnectToken, setReconnectToken] = useState(0);
  // 用 ref 存 callback，防止 useEffect 依赖死循环
  const onMessageRef = useRef(onMessage); 

  // 每次渲染更新 callback
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!url) {
      setConnectionStatus('idle');
      wsRef.current = null;
      return;
    }

    setConnectionStatus('connecting');
    let disposed = false;
    let reconnectTimer;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus('open');
      console.log("✅ Neuro Link Connected");
    };
    
    ws.onmessage = (event) => {
      try {
        const packet = JSON.parse(event.data);
        if (onMessageRef.current) {
          onMessageRef.current(packet);
        }
      } catch (e) {
        console.error("WS Parse Error:", e);
      }
    };

    ws.onerror = (e) => {
      setConnectionStatus('error');
      console.error("WS Error:", e);
    };
    
    ws.onclose = (event) => {
      setConnectionStatus('closed');
      console.log("❌ 连接断开");
      if (!disposed && ![1008, 4001].includes(event.code)) {
        reconnectTimer = setTimeout(
          () => setReconnectToken(token => token + 1),
          RECONNECT_DELAY_MS,
        );
      }
    };

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [url, reconnectToken]);

  const sendPacket = useCallback((packet) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(packet));
    }
  }, []);

  return { sendPacket, connectionStatus };
}
