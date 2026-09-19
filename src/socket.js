import EventEmitter from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { MESSAGE_RATE_LIMITS, validateClientMessage } from './socketSchemas.js';

const LATENCY_SAMPLE_INTERVAL_MS = 1000;
const LATENCY_EWMA_ALPHA = 0.2;
const MAX_LATENCY_SAMPLE_MS = 10_000;
export const MAX_WEBSOCKET_PAYLOAD_BYTES = 16 * 1024;

export function smoothRtt(previousRtt, sampleRtt) {
	if (!Number.isFinite(sampleRtt) || sampleRtt < 0) return previousRtt ?? null;
	if (!Number.isFinite(previousRtt)) return sampleRtt;
	return (
		previousRtt * (1 - LATENCY_EWMA_ALPHA) + sampleRtt * LATENCY_EWMA_ALPHA
	);
}

function configuredOrigins() {
	const values = (process.env.WS_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean);
	if (process.env.CALLBACK_URL) {
		try {
			values.push(new URL(process.env.CALLBACK_URL).origin);
		} catch {
			// Authentication setup reports an invalid callback URL separately.
		}
	}
	const origins = new Set();
	for (const value of values) {
		try {
			origins.add(new URL(value).origin);
		} catch {
			console.warn(`Ignoring invalid WebSocket origin: ${value}`);
		}
	}
	return origins;
}

export function isAllowedWebSocketOrigin(
	req,
	explicitOrigins = configuredOrigins()
) {
	const origin = req.headers.origin;
	if (typeof origin !== 'string') return false;

	let parsedOrigin;
	try {
		parsedOrigin = new URL(origin).origin;
	} catch {
		return false;
	}

	if (explicitOrigins.has(parsedOrigin)) return true;
	const host = req.headers.host;
	if (!host) return false;
	const forwardedProtocol = req.headers['x-forwarded-proto'];
	const protocol =
		typeof forwardedProtocol === 'string'
			? forwardedProtocol.split(',')[0].trim()
			: req.socket.encrypted
				? 'https'
				: 'http';
	return parsedOrigin === `${protocol}://${host}`;
}

function rejectUpgrade(socket, statusCode, reason) {
	if (socket.destroyed) return;
	const body = `${reason}\n`;
	socket.write(
		`HTTP/1.1 ${statusCode} ${reason}\r\n` +
			'Connection: close\r\n' +
			'Content-Type: text/plain; charset=utf-8\r\n' +
			`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
			body
	);
	socket.destroy();
}

/**
 * One WebSocketServer for the whole application. Lobby channels below are
 * lightweight routers and do not install per-lobby listeners or timers.
 */
export default class PongSocketHub {
	#server;
	#wss;
	#parseSession;
	#channels = new Map();
	#upgradeHandler;
	#latencyPingInterval;
	#allowedOrigins;

	/**
	 * @param {import('node:http').Server} server
	 * @param {(req: import('node:http').IncomingMessage & {user?: {id: string | number, display_name?: string}}, callback: (error?: Error) => void) => void} parseSession
	 * @param {{allowedOrigins?: Set<string>}} [options]
	 */
	constructor(server, parseSession, { allowedOrigins } = {}) {
		this.#server = server;
		this.#parseSession = parseSession;
		this.#allowedOrigins = allowedOrigins ?? configuredOrigins();
		this.#wss = new WebSocketServer({
			noServer: true,
			maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
			perMessageDeflate: false
		});

		this.#upgradeHandler = (req, socket, head) => {
			let pathname;
			try {
				pathname = new URL(req.url, 'http://localhost').pathname;
			} catch {
				rejectUpgrade(socket, 400, 'Bad Request');
				return;
			}

			const match = pathname.match(/^\/lobby\/([A-Z0-9]{5})$/i);
			if (!match) {
				if (pathname.startsWith('/lobby/')) {
					rejectUpgrade(socket, 404, 'Lobby Not Found');
				}
				return;
			}
			if (!isAllowedWebSocketOrigin(req, this.#allowedOrigins)) {
				rejectUpgrade(socket, 403, 'Forbidden');
				return;
			}

			const channel = this.#channels.get(match[1].toUpperCase());
			if (!channel) {
				rejectUpgrade(socket, 404, 'Lobby Not Found');
				return;
			}

			try {
				this.#parseSession(req, (sessionError) => {
					if (sessionError) {
						console.error(
							'Failed to authenticate WebSocket upgrade:',
							sessionError
						);
						rejectUpgrade(socket, 500, 'Internal Server Error');
						return;
					}
					if (!req.user?.id) {
						rejectUpgrade(socket, 401, 'Unauthorized');
						return;
					}

					try {
						this.#wss.handleUpgrade(req, socket, head, (ws) => {
							this.#wss.emit('connection', ws, req, channel);
						});
					} catch (error) {
						console.error('Failed to upgrade WebSocket connection:', error);
						rejectUpgrade(socket, 500, 'Internal Server Error');
					}
				});
			} catch (error) {
				console.error('Failed to authenticate WebSocket upgrade:', error);
				rejectUpgrade(socket, 500, 'Internal Server Error');
			}
		};

		this.#server.on('upgrade', this.#upgradeHandler);
		this.#wss.on('connection', (ws, req, channel) => {
			try {
				channel.attach(ws, req.user);
			} catch (error) {
				console.error('Failed to attach WebSocket connection:', error);
				ws.close(1011, 'Internal Server Error');
			}
		});
		this.#wss.on('error', (error) => {
			console.error('WebSocket server error:', error);
		});

		this.#latencyPingInterval = setInterval(() => {
			for (const channel of this.#channels.values()) channel.sampleLatency();
		}, LATENCY_SAMPLE_INTERVAL_MS);
		this.#latencyPingInterval.unref?.();
	}

	createLobbyChannel(code) {
		const normalizedCode = String(code).toUpperCase();
		if (this.#channels.has(normalizedCode)) {
			throw new Error(`WebSocket lobby ${normalizedCode} already exists`);
		}
		const channel = new PongLobbySocket(this, normalizedCode);
		this.#channels.set(normalizedCode, channel);
		return channel;
	}

	removeLobbyChannel(code, channel) {
		const normalizedCode = String(code).toUpperCase();
		if (this.#channels.get(normalizedCode) === channel) {
			this.#channels.delete(normalizedCode);
		}
	}

	stop() {
		clearInterval(this.#latencyPingInterval);
		for (const channel of [...this.#channels.values()]) channel.stop();
		this.#wss.close(() => {});
		this.#server.off('upgrade', this.#upgradeHandler);
	}
}

export class PongLobbySocket extends EventEmitter {
	#hub;
	#code;
	#wsByUserId = new Map();
	#usersById = new Map();
	#latencyByUserId = new Map();
	#rateLimitsByUserId = new Map();
	#nextLatencyPingId = 0;
	#handlers = new Map();
	#stopped = false;

	constructor(hub, code) {
		super();
		this.#hub = hub;
		this.#code = code;
		this.addHandler('ping', (_socket, _userId, _ws, msg) => ({
			type: 'pong',
			serverTs: Date.now(),
			clientTs: msg.clientTs
		}));
	}

	attach(ws, user) {
		if (this.#stopped) {
			ws.close(4000, 'Lobby closed');
			return;
		}

		const userId = String(user.id);
		const profile = {
			userId,
			displayName: String(user.display_name || 'Player')
		};
		const wasKnown = this.#usersById.has(userId);
		const existing = this.#wsByUserId.get(userId);
		this.#usersById.set(userId, profile);

		if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
			existing.close(4002, 'Connection replaced');
		}

		this.#wsByUserId.set(userId, ws);
		this.#latencyByUserId.set(userId, { rttMs: null, pending: new Map() });

		ws.on('pong', (payload) => {
			try {
				this.#receiveLatencyPong(userId, ws, payload);
			} catch (error) {
				console.warn(
					`WebSocket pong failed for user ${userId}:`,
					error.message
				);
			}
		});
		ws.on('message', (raw, isBinary) => {
			void this.#handleMessage(userId, ws, raw, isBinary);
		});
		ws.on('close', () => {
			if (this.#wsByUserId.get(userId) !== ws) return;
			this.#wsByUserId.delete(userId);
			this.#latencyByUserId.delete(userId);
			try {
				this.emit('client:disconnect', userId, profile);
			} catch (error) {
				console.error(`WebSocket disconnect handler failed:`, error);
			}
		});
		ws.on('error', (error) => {
			console.warn(`WebSocket error for user ${userId}:`, error.message);
		});

		try {
			this.emit('client:connect', userId, profile, { reconnecting: wasKnown });
		} catch (error) {
			console.error(`WebSocket connect handler failed:`, error);
			ws.close(1011, 'Internal Server Error');
			return;
		}
		this.#sendLatencyPing(userId, ws);
	}

	async #handleMessage(userId, ws, raw, isBinary) {
		if (isBinary) {
			this.safeSend(ws, {
				type: 'error',
				code: 'INVALID_MESSAGE',
				message: 'Binary messages are not supported'
			});
			return;
		}

		let value;
		try {
			value = JSON.parse(raw.toString());
		} catch {
			this.safeSend(ws, {
				type: 'error',
				code: 'INVALID_JSON',
				message: 'Invalid JSON'
			});
			return;
		}

		const validation = validateClientMessage(value);
		if (!validation.ok) {
			this.safeSend(ws, {
				type: 'error',
				code: 'INVALID_MESSAGE',
				message: validation.error
			});
			return;
		}

		const msg = validation.message;
		const handler = this.#handlers.get(msg.type);
		if (!handler) {
			this.safeSend(ws, {
				type: 'error',
				code: 'UNSUPPORTED_MESSAGE',
				message: `Unsupported message type: ${msg.type}`
			});
			return;
		}

		if (!this.#consumeRateLimit(userId, msg.type)) {
			this.safeSend(ws, {
				type: 'error',
				code: 'RATE_LIMITED',
				message: `Too many ${msg.type} messages`
			});
			return;
		}

		try {
			const reply = await handler(this, userId, ws, msg);
			if (reply?.type) this.safeSend(ws, reply);
		} catch (error) {
			console.error(`WebSocket ${msg.type} handler failed:`, error);
			this.safeSend(ws, {
				type: 'error',
				code: 'HANDLER_FAILED',
				message: 'The server could not process that message'
			});
		}
	}

	#consumeRateLimit(userId, type) {
		const policy = MESSAGE_RATE_LIMITS[type];
		if (!policy) return false;
		const now = Date.now();
		let perType = this.#rateLimitsByUserId.get(userId);
		if (!perType) {
			perType = new Map();
			this.#rateLimitsByUserId.set(userId, perType);
		}
		const timestamps = (perType.get(type) ?? []).filter(
			(timestamp) => now - timestamp < policy.windowMs
		);
		if (timestamps.length >= policy.limit) {
			perType.set(type, timestamps);
			return false;
		}
		timestamps.push(now);
		perType.set(type, timestamps);
		return true;
	}

	broadcast(obj) {
		for (const ws of this.#wsByUserId.values()) this.safeSend(ws, obj);
	}

	forEachClient(callback) {
		for (const [userId, ws] of this.#wsByUserId) {
			if (ws.readyState === WebSocket.OPEN) callback(userId, ws);
		}
	}

	listConnectedUserIds() {
		return Array.from(this.#wsByUserId.keys());
	}

	isConnected(userId) {
		const ws = this.#wsByUserId.get(String(userId));
		return Boolean(ws && ws.readyState === WebSocket.OPEN);
	}

	addHandler(type, handler) {
		this.#handlers.set(type, handler);
	}

	stop() {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const ws of this.#wsByUserId.values()) {
			ws.close(4000, 'Lobby closed');
		}
		this.#wsByUserId.clear();
		this.#usersById.clear();
		this.#latencyByUserId.clear();
		this.#rateLimitsByUserId.clear();
		this.#hub.removeLobbyChannel(this.#code, this);
	}

	safeSend(ws, obj) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return false;
		try {
			ws.send(JSON.stringify(obj));
			return true;
		} catch (error) {
			console.warn('Failed to send WebSocket message:', error.message);
			return false;
		}
	}

	safeSendToUser(userId, obj) {
		return this.safeSend(this.#wsByUserId.get(String(userId)), obj);
	}

	getUser(userId) {
		return this.#usersById.get(String(userId)) ?? null;
	}

	getRttMs(userId) {
		return this.#latencyByUserId.get(String(userId))?.rttMs ?? null;
	}

	disconnectUser(userId, code = 4000, reason = 'Disconnected by server') {
		const ws = this.#wsByUserId.get(String(userId));
		if (!ws) return false;
		try {
			ws.close(code, reason);
		} catch (error) {
			console.warn(`Failed to disconnect user ${userId}:`, error.message);
			return false;
		}
		return true;
	}

	sampleLatency() {
		for (const [userId, ws] of this.#wsByUserId) {
			this.#sendLatencyPing(userId, ws);
		}
	}

	#receiveLatencyPong(userId, ws, payload) {
		if (this.#wsByUserId.get(userId) !== ws) return;
		const latency = this.#latencyByUserId.get(userId);
		const id = payload.toString();
		const sentAt = latency?.pending.get(id);
		if (!Number.isFinite(sentAt)) return;

		latency.pending.delete(id);
		const sample = performance.now() - sentAt;
		if (sample > MAX_LATENCY_SAMPLE_MS) return;
		latency.rttMs = smoothRtt(latency.rttMs, sample);
	}

	#sendLatencyPing(userId, ws) {
		if (ws.readyState !== WebSocket.OPEN || typeof ws.ping !== 'function')
			return;
		const latency = this.#latencyByUserId.get(userId);
		if (!latency) return;

		const now = performance.now();
		for (const [id, sentAt] of latency.pending) {
			if (now - sentAt > MAX_LATENCY_SAMPLE_MS) latency.pending.delete(id);
		}

		const id = String(this.#nextLatencyPingId++);
		latency.pending.set(id, now);
		try {
			ws.ping(id);
		} catch (error) {
			latency.pending.delete(id);
			console.warn(`Failed to ping user ${userId}:`, error.message);
		}
	}
}
