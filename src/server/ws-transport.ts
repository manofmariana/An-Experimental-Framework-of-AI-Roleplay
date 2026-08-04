/**
 * WS transport（优化阶段 D3，docs/optimization-review.md §9「服务端职责边界」）：
 * upgrade/连接集/序列化/单播/广播。只处理连接与字节传输——协议解析与命令分发
 * 在 ws-controller（onConnect/onMessage 回调注入，transport 不认识 ClientCommand）。
 */
import type http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerMessage } from "./ws-protocol.js";

export class WsTransport {
  private readonly clients = new Set<WebSocket>();
  private readonly wss = new WebSocketServer({ noServer: true });

  /** 新连接回调（controller 挂重连 snapshot 单播）。 */
  onConnect: ((ws: WebSocket) => void) | null = null;
  /** 文本消息回调（controller 挂 parseClientCommand → 命令分发）。 */
  onMessage: ((raw: string, ws: WebSocket) => Promise<void>) | null = null;

  /** 广播给全部已连接客户端（只发 readyState=OPEN）。 */
  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  /** 单播。 */
  send(ws: WebSocket, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }

  /** 挂到 http server 的 upgrade（只认 /ws 路径，其余销毁）。 */
  attach(server: http.Server): void {
    server.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws);
        this.onConnect?.(ws);
        ws.on("close", () => this.clients.delete(ws));
        ws.on("message", (raw) => {
          void this.onMessage?.(raw.toString(), ws);
        });
      });
    });
  }
}
