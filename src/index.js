import { DurableObject } from "cloudflare:workers";

const ROOM_IDS = ["1", "2", "3", "4"];
const MAX_PLAYERS = 10;
const AUTO_RESET_MS = 30 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function shuffledNumbers() {
  const a = Array.from({ length: 104 }, (_, i) => i + 1);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function bulls(n) {
  if (n === 55) return 7;
  if (n % 11 === 0) return 5;
  if (n % 10 === 0) return 3;
  if (n % 5 === 0) return 2;
  return 1;
}

function bullSum(cards) {
  return cards.reduce((sum, n) => sum + bulls(n), 0);
}

function emptyRoom() {
  return {
    version: 2,
    phase: "lobby", // lobby | playing | roundEnd | finished
    players: [],
    hostId: null,
    settings: { mode: "decrease", startPoints: 66, goalPoints: 66 },
    round: 0,
    turn: 0,
    rows: [],
    hands: {},
    submitted: {},
    resolution: null,
    lastReveal: [],
    lastActions: [],
    roundSummary: null,
    ranking: null,
    logs: [],
    updatedAt: Date.now(),
  };
}

function normalizeRoom(s) {
  const base = emptyRoom();
  if (!s || typeof s !== "object") return base;
  return {
    ...base,
    ...s,
    settings: { ...base.settings, ...(s.settings || {}) },
    players: Array.isArray(s.players) ? s.players : [],
    rows: Array.isArray(s.rows) ? s.rows : [],
    hands: s.hands && typeof s.hands === "object" ? s.hands : {},
    submitted: s.submitted && typeof s.submitted === "object" ? s.submitted : {},
    logs: Array.isArray(s.logs) ? s.logs.slice(-14) : [],
  };
}

function modeLabel(settings) {
  return settings.mode === "increase" ? `加点式 / ${settings.goalPoints}点` : `減点式 / ${settings.startPoints}点開始`;
}

function rankingFor(state) {
  return [...state.players]
    .map((p, idx) => ({ id: p.id, name: p.name, score: p.score, joinedOrder: idx }))
    .sort((a, b) => (b.score - a.score) || (a.joinedOrder - b.joinedOrder))
    .map((p, idx) => ({ rank: idx + 1, id: p.id, name: p.name, score: p.score }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" && request.method === "GET") {
      const summaries = await Promise.all(ROOM_IDS.map(async (roomId) => {
        const stub = env.NIMTO_ROOM.getByName(`room-${roomId}`);
        const res = await stub.fetch("https://internal/summary");
        return res.json();
      }));
      return json({ rooms: summaries });
    }

    if (url.pathname === "/api/reset" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const roomId = String(body.room || "");
      if (!ROOM_IDS.includes(roomId)) return json({ error: "invalid room" }, 400);
      const stub = env.NIMTO_ROOM.getByName(`room-${roomId}`);
      const res = await stub.fetch("https://internal/reset", { method: "POST" });
      return res;
    }

    const wsMatch = url.pathname.match(/^\/ws\/(1|2|3|4)$/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      const stub = env.NIMTO_ROOM.getByName(`room-${roomId}`);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export class NimtoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();
    this.state = emptyRoom();

    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment();
      if (attachment?.clientId) this.sessions.set(ws, attachment);
    });

    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    this.ctx.blockConcurrencyWhile(async () => {
      this.state = normalizeRoom(await this.ctx.storage.get("room"));
      const activeIds = new Set([...this.sessions.values()].map((x) => x.clientId));
      for (const p of this.state.players) p.connected = activeIds.has(p.id);
      if (this.state.players.length && !this.state.players.some((p) => p.id === this.state.hostId)) {
        this.state.hostId = this.state.players[0].id;
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/summary") {
      return json(this.summary());
    }

    if (url.pathname === "/reset" && request.method === "POST") {
      await this.hardReset("部屋が手動初期化されました。");
      return json({ ok: true });
    }

    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }

    const clientId = (url.searchParams.get("cid") || "").trim().slice(0, 80);
    const rawName = (url.searchParams.get("name") || "").trim().slice(0, 18);
    const name = rawName || "プレイヤー";
    if (!clientId) return new Response("client id required", { status: 400 });

    let player = this.state.players.find((p) => p.id === clientId);
    if (!player) {
      if (this.state.phase !== "lobby") return new Response("game already started", { status: 409 });
      if (this.state.players.length >= MAX_PLAYERS) return new Response("room full", { status: 409 });
      player = { id: clientId, name, score: this.state.settings.mode === "decrease" ? this.state.settings.startPoints : 0, connected: true };
      this.state.players.push(player);
      if (!this.state.hostId) this.state.hostId = clientId;
      this.addLog(`${name} が入室しました。`);
    } else {
      player.name = name;
      player.connected = true;
    }

    // 同一クライアントの古い接続を閉じる。
    for (const [oldWs, session] of this.sessions.entries()) {
      if (session.clientId === clientId) {
        this.sessions.delete(oldWs);
        try { oldWs.close(4001, "reconnected"); } catch (_) {}
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ clientId });
    this.sessions.set(server, { clientId });
    await this.ctx.storage.deleteAlarm().catch(() => {});
    await this.save();

    queueMicrotask(() => this.sendAll());
    return new Response(null, { status: 101, webSocket: client });
  }

  summary() {
    return {
      room: this.roomNumber(),
      phase: this.state.phase,
      players: this.state.players.length,
      connected: this.state.players.filter((p) => p.connected).length,
      maxPlayers: MAX_PLAYERS,
      mode: this.state.settings.mode,
      modeText: modeLabel(this.state.settings),
      round: this.state.round,
      turn: this.state.turn,
    };
  }

  roomNumber() {
    // ID自体は取得できないため、外部には表示用として保存不要。summary呼び出し時は不明でもUI側でindex補完できる。
    return null;
  }

  addLog(text, type = "info") {
    this.state.logs.push({ text, type, at: Date.now() });
    if (this.state.logs.length > 14) this.state.logs.splice(0, this.state.logs.length - 14);
  }

  async save() {
    this.state.updatedAt = Date.now();
    await this.ctx.storage.put("room", this.state);
  }

  async hardReset(message = null) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: "roomReset", message: message || "部屋が初期化されました。" })); } catch (_) {}
      try { ws.close(4000, "room reset"); } catch (_) {}
    }
    this.sessions.clear();
    this.state = emptyRoom();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm().catch(() => {});
  }

  send(ws, payload) {
    try { ws.send(JSON.stringify(payload)); } catch (_) {}
  }

  snapshotFor(clientId) {
    const me = this.state.players.find((p) => p.id === clientId) || null;
    const selfSubmitted = Object.prototype.hasOwnProperty.call(this.state.submitted, clientId);
    const waitingForMe = this.state.resolution?.waiting?.playerId === clientId;
    return {
      type: "state",
      state: {
        phase: this.state.phase,
        players: this.state.players.map((p) => ({ id: p.id, name: p.name, score: p.score, connected: !!p.connected })),
        hostId: this.state.hostId,
        settings: this.state.settings,
        round: this.state.round,
        turn: this.state.turn,
        rows: this.state.rows,
        submittedIds: Object.keys(this.state.submitted),
        lastReveal: this.state.lastReveal,
        lastActions: this.state.lastActions,
        waitingChoice: this.state.resolution?.waiting ? {
          playerId: this.state.resolution.waiting.playerId,
          card: waitingForMe ? this.state.resolution.waiting.card : null,
        } : null,
        roundSummary: this.state.roundSummary,
        ranking: this.state.ranking,
        logs: this.state.logs,
        myHand: me ? (this.state.hands[clientId] || []) : [],
        mySubmitted: selfSubmitted,
        selfId: clientId,
      },
    };
  }

  sendAll() {
    for (const [ws, session] of this.sessions.entries()) {
      if (!session?.clientId) continue;
      this.send(ws, this.snapshotFor(session.clientId));
    }
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment();
    const clientId = attachment?.clientId;
    if (!clientId) return;

    let msg;
    try { msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); }
    catch (_) { return; }

    const player = this.state.players.find((p) => p.id === clientId);
    if (!player) return;

    switch (msg.type) {
      case "rename":
        if (this.state.phase === "lobby") {
          const n = String(msg.name || "").trim().slice(0, 18);
          if (n) player.name = n;
          await this.save();
          this.sendAll();
        }
        break;

      case "settings":
        await this.updateSettings(clientId, msg);
        break;

      case "start":
        await this.startGame(clientId);
        break;

      case "play":
        await this.submitCard(clientId, msg.card);
        break;

      case "chooseRow":
        await this.chooseRow(clientId, msg.row);
        break;

      case "nextRound":
        await this.startNextRound(clientId);
        break;

      case "backLobby":
        await this.backToLobby(clientId);
        break;

      case "leave":
        await this.leave(clientId, ws);
        break;

      default:
        break;
    }
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment();
    const clientId = attachment?.clientId;
    this.sessions.delete(ws);
    if (!clientId) return;

    // 再接続済みの同一IDが残っていれば切断扱いにしない。
    const stillActive = [...this.sessions.values()].some((s) => s.clientId === clientId);
    if (!stillActive) {
      const p = this.state.players.find((x) => x.id === clientId);
      if (p) p.connected = false;
      this.promoteHostIfNeeded();
      await this.save();
      this.sendAll();
    }

    if (this.sessions.size === 0) {
      await this.ctx.storage.setAlarm(Date.now() + AUTO_RESET_MS);
    }
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      this.state = emptyRoom();
      await this.ctx.storage.deleteAll();
    }
  }

  promoteHostIfNeeded() {
    const current = this.state.players.find((p) => p.id === this.state.hostId && p.connected);
    if (current) return;
    const next = this.state.players.find((p) => p.connected) || this.state.players[0] || null;
    this.state.hostId = next?.id || null;
  }

  async leave(clientId, ws) {
    if (this.state.phase === "playing" || this.state.phase === "roundEnd") {
      this.send(ws, { type: "error", message: "対戦中は席を維持します。再接続すれば同じ手札に戻れます。" });
      return;
    }
    const idx = this.state.players.findIndex((p) => p.id === clientId);
    if (idx >= 0) {
      const [removed] = this.state.players.splice(idx, 1);
      delete this.state.hands[clientId];
      delete this.state.submitted[clientId];
      this.addLog(`${removed.name} が退室しました。`);
    }
    this.sessions.delete(ws);
    this.promoteHostIfNeeded();
    await this.save();
    this.sendAll();
    try { ws.close(1000, "left"); } catch (_) {}
  }

  async updateSettings(clientId, msg) {
    if (this.state.phase !== "lobby" || clientId !== this.state.hostId) return;
    const mode = msg.mode === "increase" ? "increase" : "decrease";
    this.state.settings.mode = mode;
    this.state.settings.startPoints = clampInt(msg.startPoints, 1, 9999, this.state.settings.startPoints);
    this.state.settings.goalPoints = clampInt(msg.goalPoints, 1, 9999, this.state.settings.goalPoints);
    for (const p of this.state.players) p.score = mode === "decrease" ? this.state.settings.startPoints : 0;
    this.addLog(`ルール設定：${modeLabel(this.state.settings)}`);
    await this.save();
    this.sendAll();
  }

  async startGame(clientId) {
    if (this.state.phase !== "lobby" || clientId !== this.state.hostId) return;
    if (this.state.players.length < 2) {
      const ws = this.findSocket(clientId);
      if (ws) this.send(ws, { type: "error", message: "2人以上で開始できます。" });
      return;
    }
    this.state.players.forEach((p) => {
      p.score = this.state.settings.mode === "decrease" ? this.state.settings.startPoints : 0;
    });
    this.state.round = 0;
    this.state.ranking = null;
    this.state.roundSummary = null;
    this.addLog(`ゲーム開始：${modeLabel(this.state.settings)}`, "turn");
    await this.dealRound();
  }

  async dealRound() {
    const deck = shuffledNumbers();
    const hands = {};
    for (const p of this.state.players) hands[p.id] = [];

    for (let i = 0; i < 10; i++) {
      for (const p of this.state.players) hands[p.id].push(deck.pop());
    }
    for (const id of Object.keys(hands)) hands[id].sort((a, b) => a - b);

    this.state.rows = [[deck.pop()], [deck.pop()], [deck.pop()], [deck.pop()]];
    this.state.hands = hands;
    this.state.submitted = {};
    this.state.resolution = null;
    this.state.lastReveal = [];
    this.state.lastActions = [];
    this.state.roundSummary = null;
    this.state.round += 1;
    this.state.turn = 1;
    this.state.phase = "playing";
    this.addLog(`ラウンド${this.state.round}開始。`, "turn");
    await this.save();
    this.sendAll();
  }

  findSocket(clientId) {
    for (const [ws, session] of this.sessions.entries()) if (session.clientId === clientId) return ws;
    return null;
  }

  async submitCard(clientId, cardValue) {
    if (this.state.phase !== "playing" || this.state.resolution) return;
    if (Object.prototype.hasOwnProperty.call(this.state.submitted, clientId)) return;
    const hand = this.state.hands[clientId] || [];
    const card = clampInt(cardValue, 1, 104, -1);
    const idx = hand.indexOf(card);
    if (idx < 0) return;

    // 次ターンで最初の1人が提出した時点で、前ターンの公開カード表示を消す。
    if (Object.keys(this.state.submitted).length === 0) {
      this.state.lastReveal = [];
      this.state.lastActions = [];
    }
    hand.splice(idx, 1);
    this.state.submitted[clientId] = card;
    await this.save();
    this.sendAll();

    if (Object.keys(this.state.submitted).length === this.state.players.length) {
      await this.beginResolution();
    }
  }

  async beginResolution() {
    const queue = Object.entries(this.state.submitted)
      .map(([playerId, card]) => ({ playerId, card }))
      .sort((a, b) => a.card - b.card);
    this.state.lastReveal = queue.map((x) => ({ ...x, name: this.state.players.find((p) => p.id === x.playerId)?.name || "?" }));
    this.state.lastActions = [];
    this.state.resolution = { queue, index: 0, waiting: null };
    this.addLog(`公開：${this.state.lastReveal.map((x) => `${x.name} ${x.card}`).join(" / ")}`, "turn");
    await this.save();
    this.sendAll();
    await this.continueResolution();
  }

  targetRow(card) {
    let best = -1;
    let bestDiff = Infinity;
    this.state.rows.forEach((row, i) => {
      const last = row[row.length - 1];
      if (last < card) {
        const diff = card - last;
        if (diff < bestDiff) {
          best = i;
          bestDiff = diff;
        }
      }
    });
    return best;
  }

  async continueResolution() {
    const r = this.state.resolution;
    if (!r) return;

    while (r.index < r.queue.length) {
      const entry = r.queue[r.index];
      const target = this.targetRow(entry.card);

      if (target < 0) {
        r.waiting = { playerId: entry.playerId, card: entry.card };
        await this.save();
        this.sendAll();
        return;
      }

      const row = this.state.rows[target];
      if (row.length >= 5) {
        const taken = [...row];
        const points = bullSum(taken);
        this.applyScore(entry.playerId, points, "sixth");
        this.state.rows[target] = [entry.card];
        const name = this.playerName(entry.playerId);
        this.state.lastActions.push({ type: "sixth", playerId: entry.playerId, name, card: entry.card, row: target, points });
        this.addLog(`${name}：${entry.card}が6枚目 → ${points}点${this.state.settings.mode === "increase" ? "加点" : "減点"}`, "take");
        r.index += 1;
        if (this.checkFinish(entry.playerId)) {
          await this.finishGame();
          return;
        }
      } else {
        row.push(entry.card);
        const name = this.playerName(entry.playerId);
        this.state.lastActions.push({ type: "place", playerId: entry.playerId, name, card: entry.card, row: target, points: 0 });
        r.index += 1;
      }
    }

    await this.finishTurn();
  }

  playerName(id) {
    return this.state.players.find((p) => p.id === id)?.name || "?";
  }

  applyScore(playerId, points, reason) {
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p) return;
    if (this.state.settings.mode === "decrease") {
      p.score -= points;
      return;
    }
    if (reason === "sixth") p.score += points;
    else if (reason === "low") p.score -= points;
  }

  checkFinish(playerId) {
    const p = this.state.players.find((x) => x.id === playerId);
    if (!p) return false;
    if (this.state.settings.mode === "decrease") return p.score <= 0;
    return p.score >= this.state.settings.goalPoints;
  }

  async chooseRow(clientId, rowValue) {
    const r = this.state.resolution;
    if (this.state.phase !== "playing" || !r?.waiting || r.waiting.playerId !== clientId) return;
    const rowIndex = clampInt(rowValue, 0, 3, -1);
    if (rowIndex < 0 || rowIndex > 3) return;

    const entry = r.queue[r.index];
    if (!entry || entry.playerId !== clientId || entry.card !== r.waiting.card) return;

    const taken = [...this.state.rows[rowIndex]];
    const points = bullSum(taken);
    this.applyScore(clientId, points, "low");
    this.state.rows[rowIndex] = [entry.card];
    const name = this.playerName(clientId);
    this.state.lastActions.push({ type: "low", playerId: clientId, name, card: entry.card, row: rowIndex, points });
    const deltaText = this.state.settings.mode === "increase" ? `${points}点減点` : `${points}点減点`;
    this.addLog(`${name}：${entry.card}が全列より小さい → ${rowIndex + 1}列目を取り ${deltaText}`, "take");
    r.waiting = null;
    r.index += 1;

    if (this.checkFinish(clientId)) {
      await this.finishGame();
      return;
    }

    await this.save();
    this.sendAll();
    await this.continueResolution();
  }

  async finishTurn() {
    this.state.submitted = {};
    this.state.resolution = null;

    if (this.state.turn >= 10) {
      this.state.phase = "roundEnd";
      this.state.roundSummary = rankingFor(this.state);
      this.addLog(`ラウンド${this.state.round}終了。`, "turn");
    } else {
      this.state.turn += 1;
      this.addLog(`${this.state.turn}ターン目。`, "turn");
    }

    await this.save();
    this.sendAll();
  }

  async finishGame() {
    this.state.phase = "finished";
    this.state.resolution = null;
    this.state.submitted = {};
    this.state.ranking = rankingFor(this.state);
    const winner = this.state.ranking[0];
    this.addLog(`ゲーム終了。1位 ${winner.name}（${winner.score}点）`, "finish");
    await this.save();
    this.sendAll();
  }

  async startNextRound(clientId) {
    if (this.state.phase !== "roundEnd" || clientId !== this.state.hostId) return;
    await this.dealRound();
  }

  async backToLobby(clientId) {
    if (this.state.phase !== "finished" || clientId !== this.state.hostId) return;
    this.state.phase = "lobby";
    this.state.round = 0;
    this.state.turn = 0;
    this.state.rows = [];
    this.state.hands = {};
    this.state.submitted = {};
    this.state.resolution = null;
    this.state.lastReveal = [];
    this.state.lastActions = [];
    this.state.roundSummary = null;
    this.state.ranking = null;
    for (const p of this.state.players) p.score = this.state.settings.mode === "decrease" ? this.state.settings.startPoints : 0;
    this.addLog("ロビーへ戻りました。", "turn");
    await this.save();
    this.sendAll();
  }
}
