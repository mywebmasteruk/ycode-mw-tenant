import WebSocket from 'ws';

type WebSocketLikeConstructor = typeof globalThis.WebSocket;

export const supabaseServerRealtimeOptions = {
  transport: WebSocket as unknown as WebSocketLikeConstructor,
};
