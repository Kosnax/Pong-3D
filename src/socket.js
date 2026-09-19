import EventEmitter from 'node:events';
import { WebSocketServer } from 'ws';

const LATENCY_SAMPLE_INTERVAL_MS = 1000;
const LATENCY_EWMA_ALPHA = 0.2;
const MAX_LATENCY_SAMPLE_MS = 10_000;

export function smoothRtt(previousRtt, sampleRtt) {
	if (!Number.isFinite(sampleRtt) || sampleRtt < 0) return previousRtt ?? null;
	if (!Number.isFinite(previousRtt)) return sampleRtt;
	return (
		previousRtt * (1 - LATENCY_EWMA_ALPHA) + sampleRtt * LATENCY_EWMA_ALPHA
	);
}

/*
 * How to use:
 * - Construct with HTTP server instance (see index.js) and path to websocket
 *   (e.g., /ws) (must start with /)
 * - Listen for messages with addHandler(func). The callback should take four
 *   arguments: socket, clientId, ws, msg, respond. socket is this server.
 *   clientId is the client's ID. msg is a JSON object with mandatory field
 *   called "type". respond is a function that takes a JSON object to send back
 *   to the client.
 *   - The handler function should return true to stop the handler chain. If it
 *     does not return anything, subsequent handlers will be called.
 * - Handlers are called in the order they are added.
 */
export default class PongSocketServer extends EventEmitter {
	#server = null;
	#wss = null;
	#wsByUsername = new Map();
	#userIdByUsername = new Map();
	#latencyByUsername = new Map();
	#upgradeHandler = null;
	#latencyPingInterval = null;
	#nextLatencyPingId = 0;

	#handlers = new Map();

	constructor(server, socketPath, parseSession) {
		super();

		this.#server = server;
		this.#wss = new WebSocketServer({ noServer: true });

		this.addHandler('ping', this.#ping);

		this.#upgradeHandler = (req, socket, head) => {
			const { pathname } = new URL(req.url, 'http://localhost');

			if (pathname !== socketPath) {
				// Pass to next handler
				return;
			}

			parseSession(req, () => {
				if (!req.user) return;

				this.#wss.handleUpgrade(req, socket, head, (ws) => {
					this.#wss.emit('connection', ws, req);
				});
			});
		};

		server.on('upgrade', this.#upgradeHandler);

		this.#wss.on('connection', (ws, req) => {
			const username = req.user.display_name;
			const userId = req.user.id;
			const existing = this.#wsByUsername.get(username);
			if (
				existing &&
				existing !== ws &&
				existing.readyState === existing.OPEN
			) {
				ws.close(4001, 'User is already connected');
				return;
			}

			this.#wsByUsername.set(username, ws);
			this.#userIdByUsername.set(username, userId);
			this.#latencyByUsername.set(username, {
				rttMs: null,
				pending: new Map()
			});

			ws.on('pong', (payload) => {
				if (this.#wsByUsername.get(username) !== ws) return;
				const latency = this.#latencyByUsername.get(username);
				const sentAt = latency?.pending.get(payload.toString());
				if (!Number.isFinite(sentAt)) return;

				latency.pending.delete(payload.toString());
				const sample = performance.now() - sentAt;
				if (sample > MAX_LATENCY_SAMPLE_MS) return;
				latency.rttMs = smoothRtt(latency.rttMs, sample);
			});

			ws.on('message', (raw) => {
				const text = raw.toString();

				let msg = null;
				try {
					msg = JSON.parse(text);
				} catch {
					this.safeSend(ws, { type: 'error', message: 'Invalid JSON' });
					return;
				}

				if (!msg?.type) {
					this.safeSend(ws, {
						type: 'error',
						message: 'Missing message type'
					});
					return;
				}

				const handler = this.#handlers.get(msg.type);
				if (handler === undefined) {
					this.safeSend(ws, {
						type: 'error',
						message: `Unknown message type: ${msg.type}`
					});
					return;
				}
				const reply = handler(this, username, ws, msg);
				if (reply === undefined || reply.type === undefined) return;
				this.safeSend(ws, reply);
			});

			this.emit('client:connect', username);
			this.#sendLatencyPing(username, ws);

			ws.on('close', () => {
				if (this.#wsByUsername.get(username) !== ws) return;
				this.emit('client:disconnect', username);
				this.#wsByUsername.delete(username);
				this.#userIdByUsername.delete(username);
				this.#latencyByUsername.delete(username);
			});
		});

		this.#latencyPingInterval = setInterval(() => {
			for (const [username, ws] of this.#wsByUsername) {
				this.#sendLatencyPing(username, ws);
			}
		}, LATENCY_SAMPLE_INTERVAL_MS);
		this.#latencyPingInterval.unref?.();
	}

	broadcast(obj) {
		this.#wss.clients.forEach((ws) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(obj));
			}
		});
	}

	forEachClient(cb) {
		for (const [username, ws] of this.#wsByUsername.entries()) {
			if (ws.readyState === WebSocket.OPEN) {
				cb(username, ws);
			}
		}
	}

	listConnectedUsernames() {
		return Array.from(this.#wsByUsername.keys());
	}

	addHandler(type, func) {
		this.#handlers.set(type, func);
	}

	stop() {
		if (this.#latencyPingInterval) {
			clearInterval(this.#latencyPingInterval);
			this.#latencyPingInterval = null;
		}
		this.#wss.clients.forEach((ws) => {
			ws.close();
		});
		this.#server.off('upgrade', this.#upgradeHandler);
	}

	safeSend(ws, obj) {
		if (ws.readyState !== ws.OPEN) return;
		ws.send(JSON.stringify(obj));
	}

	safeSendToUser(username, obj) {
		const ws = this.#wsByUsername.get(username);
		this.safeSend(ws, obj);
	}

	getUserId(username) {
		return this.#userIdByUsername.get(username);
	}

	getRttMs(username) {
		return this.#latencyByUsername.get(username)?.rttMs ?? null;
	}

	disconnectUser(username, code = 4000, reason = 'Disconnected by server') {
		const ws = this.#wsByUsername.get(username);
		if (!ws) return false;
		ws.close(code, reason);
		return true;
	}

	#ping(socket, username, ws, msg) {
		return { type: 'pong', serverTs: Date.now(), clientTs: msg.clientTs };
	}

	#sendLatencyPing(username, ws) {
		if (ws.readyState !== ws.OPEN || typeof ws.ping !== 'function') return;

		const latency = this.#latencyByUsername.get(username);
		if (!latency) return;

		const now = performance.now();
		for (const [id, sentAt] of latency.pending) {
			if (now - sentAt > MAX_LATENCY_SAMPLE_MS) latency.pending.delete(id);
		}

		const id = String(this.#nextLatencyPingId++);
		latency.pending.set(id, now);
		ws.ping(id);
	}
}
