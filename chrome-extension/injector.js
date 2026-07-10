(function () {
  const DEBUG_ALL = false;
  const keys = ["promotion", "overall", "trend", "chart", "time_series", "task_center", "control", "realtime", "real_time", "board", "dashboard", "cost", "roi", "consume", "live", "stream", "audience", "online", "watch", "view", "show", "exposure", "gpm", "gmv", "conversion", "anchor", "room", "viewer", "realtime_data", "live_room"];
  const excludes = ["mon.zijieapi.com", "insight.oceancus.com", "browser-settings"];
  const nativeFetch = window.fetch?.bind(window);
  const ORDER_REQUEST_KEY = "QIANCHUAN_LAST_ORDER_REQUEST_V3";
  let lastOrderRequest = readOrderRequest();
  const matched = (url) => {
    const text = String(url || "").toLowerCase();
    if (excludes.some((key) => text.includes(key))) return false;
    if (DEBUG_ALL) return true;
    return keys.some((key) => text.includes(key));
  };
  function isOrderRequestUrl(url) {
    const text = String(url || "");
    return text.includes("assist_task_data_modal") || text.includes("reqFrom=materialLive");
  }
  function readOrderRequest() {
    try {
      return JSON.parse(localStorage.getItem(ORDER_REQUEST_KEY) || "null");
    } catch {
      return null;
    }
  }
  function writeOrderRequest(request) {
    if (!request?.url || !isOrderRequestUrl(request.url)) return;
    lastOrderRequest = request;
    try { localStorage.setItem(ORDER_REQUEST_KEY, JSON.stringify(request)); } catch {}
  }
  function plainHeaders(headers) {
    try {
      if (!headers) return {};
      if (headers instanceof Headers) return Object.fromEntries(headers.entries());
      if (Array.isArray(headers)) return Object.fromEntries(headers);
      return { ...headers };
    } catch {
      return {};
    }
  }
  function cacheFetchRequest(args) {
    const input = args[0], init = args[1] || {};
    const url = typeof input === "string" ? input : input?.url;
    if (!isOrderRequestUrl(url)) return;
    writeOrderRequest({
      url,
      method: init.method || input?.method || "GET",
      body: typeof init.body === "string" ? init.body : null,
      headers: plainHeaders(init.headers || input?.headers),
    });
  }
  const post = (url, data) => {
    try {
      console.log("[QIANCHUAN_API_INTERCEPT]", url);
      window.postMessage({ type: "QIANCHUAN_API_INTERCEPT", url, data, ts: Date.now() }, "*");
    } catch {}
  };

  try {
    window.fetch = async function (...args) {
      cacheFetchRequest(args);
      const response = await nativeFetch(...args);
      try {
        if (matched(response.url)) response.clone().json().then((data) => post(response.url, data)).catch(() => {});
      } catch {}
      return response;
    };
  } catch {}

  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__qianchuanUrl = url;
      this.__qianchuanMethod = method;
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      try {
        if (isOrderRequestUrl(this.__qianchuanUrl)) {
          writeOrderRequest({ url: this.__qianchuanUrl, method: this.__qianchuanMethod || "POST", body: typeof args[0] === "string" ? args[0] : null, headers: {} });
        }
        this.addEventListener("load", function () {
          try {
            const url = this.responseURL || this.__qianchuanUrl;
            if (!matched(url)) return;
            const data = JSON.parse(this.responseText);
            post(url, data);
          } catch {}
        });
      } catch {}
      return originalSend.apply(this, args);
    };
  } catch {}

  try {
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      const socket = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
      try {
        if (matched(url)) post(url, { __type: "websocket_open", url });
      } catch {}
      return socket;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  } catch {}

  // 主动触发 assist 接口，获取订单数据
  let lastAssistFetch = 0;
  function forceAssistFetch() {
    const now = Date.now();
    if (now - lastAssistFetch < 60000) return; // 最多每分钟一次
    lastAssistFetch = now;
    try {
      if (!nativeFetch) return;
      if (!lastOrderRequest?.url) {
        console.log("[QIANCHUAN_FORCE_ORDER_SKIPPED]", "waiting for signed order request");
        return;
      }
      const url = lastOrderRequest.url.replace(/([?&])_=\d+/, `$1_=${now}`);
      const headers = { ...(lastOrderRequest.headers || {}) };
      if (lastOrderRequest.body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }
      nativeFetch(url, {
        method: lastOrderRequest.method || "POST",
        body: lastOrderRequest.body || undefined,
        headers,
        credentials: "include",
      })
        .then((r) => r.json())
        .then((data) => { post(url, data); })
        .catch((error) => console.log("[QIANCHUAN_FORCE_ASSIST_FAILED]", error.message));
    } catch {}
  }

  // 监听来自 content.js 的强制采集消息
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "QIANCHUAN_FORCE_ASSIST") {
      forceAssistFetch();
    }
  });

  // 页面加载后延迟一次触发
  setTimeout(forceAssistFetch, 5000);
  // 每 2 分钟自动触发一次
  setInterval(forceAssistFetch, 120000);
})();
