/**
 * WS transport：upgrade/连接集/序列化/单播/广播。只处理连接与字节传输——协议解析
 * 与命令分发在 ws-controller（onConnect/onMessage 回调注入，transport 不认识
 * ClientCommand）。attach 接受 checkUpgrade 注入（接入边界纯判定在 accessControl.ts），
 * 拒绝 → 403 响应后 destroy。
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
  attach(
    server: http.Server,
    checkUpgrade?: (req: http.IncomingMessage) => { status: number; message: string } | null,
  ): void {
    server.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
        socket.destroy();
        return;
      }
      // 接入边界：checkUpgrade 注入（Host/Origin/IP 判定在 accessControl，纯函数）；
      // 拒绝 → 写一条最小 403 响应后 destroy（envelope 是 HTTP 层概念，upgrade 走裸响应）
      const denied = checkUpgrade?.(req) ?? null;
      if (denied !== null) {
        socket.write(
          `HTTP/1.1 ${denied.status} Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${denied.message}`,
        );
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
