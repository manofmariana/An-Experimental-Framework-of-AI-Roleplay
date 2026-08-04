/**
 * WebSocket 传输层：
 * 独占本页唯一 socket——任意时刻至多一个有效连接、一个 reconnect timer。
 *
 * 生命周期守卫（本片核心）：
 * - 每次 connect() ++generation，所有回调闭包捕获当时的 gen；旧 generation 的
 *   open/message/close 一律丢弃（重连/手动 reconnect 后旧 socket 的晚到回调不生效）；
 * - close 事件统一进 scheduleReconnect：先清旧 timer 再挂新 timer，单一退避序列
 *   1s→2s→4s…封顶 10s；open 后复位；
 * - dispose() 后不再重连（登出/页面卸载语义；本页常驻，但守卫必须就位）；
 * - send 未连接返回 false（不静默丢弃，由调用方决定提示）。
 *
 * 零 DOM：WebSocket 构造器与 url 由调用方注入（测试 fake），消息文本原样交 onMessage，
 * 连接状态经 onStatus 上报（protocol 转 store 的 connection 内部消息）。
 */

const DEFAULT_BACKOFF = { initial: 1000, max: 10000 };

/**
 * @param {object} opts
 * @param {new (url: string) => object} opts.WebSocketImpl WebSocket 构造器（浏览器全局或 fake）
 * @param {() => string} opts.url 连接地址（每次 connect 现取，便于注入）
 * @param {(text: string) => void} opts.onMessage 收到一帧文本
 * @param {(status: string) => void} opts.onStatus "connecting" | "open" | "closed"
 * @param {{initial: number, max: number}} [opts.backoff] 重连退避（测试可缩小）
 * @param {(fn: () => void, ms: number) => unknown} [opts.setTimeoutFn] 测试注入假时钟
 * @param {(handle: unknown) => void} [opts.clearTimeoutFn]
 */
export function createSessionTransport({
  WebSocketImpl,
  url,
  onMessage,
  onStatus,
  backoff = DEFAULT_BACKOFF,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let generation = 0; // 连接世代：旧 gen 回调一律丢弃
  let socket = null; // 当前 socket（至多一个）
  let timer = null; // 重连 timer（至多一个）
  let disposed = false;
  let status = "closed";
  let delay = backoff.initial;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus(next);
  }

  /** 断开当前 socket 且不再让其回调生效（reconnect/dispose 共用）。 */
  function dropSocket() {
    if (socket === null) return;
    const s = socket;
    socket = null;
    s.onopen = s.onmessage = s.onclose = s.onerror = null; // 回调失效比 close 先，晚到事件无落点
    try {
      s.close();
    } catch {
      /* 已关闭/半开状态 close 抛错无害 */
    }
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function scheduleReconnect() {
    if (disposed) return;
    clearTimer(); // 单一 timer：连续 close 不叠加
    const wait = delay;
    delay = Math.min(delay * 2, backoff.max);
    timer = setTimeoutFn(() => {
      timer = null;
      if (!disposed) connect();
    }, wait);
  }

  function connect() {
    if (disposed) return;
    clearTimer();
    dropSocket(); // 防御：connect 前清掉任何残留（reconnect() 显式走此路径）
    const gen = ++generation;
    setStatus("connecting");
    const s = new WebSocketImpl(url());
    socket = s;
    s.onopen = () => {
      if (gen !== generation) return; // 旧世代晚到
      delay = backoff.initial; // 连上复位退避
      setStatus("open");
    };
    s.onmessage = (e) => {
      if (gen !== generation) return;
      onMessage(typeof e === "string" ? e : e.data);
    };
    s.onclose = () => {
      if (gen !== generation) return;
      socket = null;
      setStatus("closed");
      scheduleReconnect();
    };
    s.onerror = () => {
      // 错误一律交给随后的 close 统一处理（浏览器与 fake 均保证 close 兜底）
      if (gen !== generation) return;
      try {
        s.close();
      } catch {
        /* close 失败由 close 事件或下一次 reconnect 兜底 */
      }
    };
  }

  return {
    connect,
    /** 手动重连：立即断开旧连接（旧世代回调失效）并重开一代，退避复位。 */
    reconnect() {
      if (disposed) return;
      delay = backoff.initial;
      connect();
    },
    /** 发送一帧；未连接返回 false（调用方决定用户可见的失败提示）。 */
    send(text) {
      if (socket !== null && status === "open" && socket.readyState === 1 /* OPEN */) {
        socket.send(text);
        return true;
      }
      return false;
    },
    /** 终态：断连 + 停重连；之后再 connect 无效。 */
    dispose() {
      disposed = true;
      generation += 1; // 在途回调全部失效
      clearTimer();
      dropSocket();
      setStatus("closed");
    },
    /** 当前状态（status / generation；测试断言世代守卫用）。 */
    getState: () => ({ status, generation }),
  };
}
