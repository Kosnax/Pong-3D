import EventEmitter from 'node:events';
import { jest } from '@jest/globals';
import {
	isAllowedWebSocketOrigin,
	PongLobbySocket,
	smoothRtt
} from './socket.js';
import { MAX_CHAT_LENGTH, validateClientMessage } from './socketSchemas.js';

class FakeWebSocket extends EventEmitter {
	constructor() {
		super();
		this.readyState = 1;
		this.sent = [];
	}

	send(payload) {
		this.sent.push(JSON.parse(payload));
	}

	ping() {}

	close() {
		this.readyState = 3;
		this.emit('close');
	}
}

describe('server RTT smoothing', () => {
	test('uses the first sample directly and then a 0.2 EWMA', () => {
		expect(smoothRtt(null, 100)).toBe(100);
		expect(smoothRtt(100, 200)).toBeCloseTo(120);
	});

	test('ignores invalid samples', () => {
		expect(smoothRtt(100, Number.NaN)).toBe(100);
		expect(smoothRtt(100, -1)).toBe(100);
	});
});

describe('WebSocket protocol validation', () => {
	test('normalizes valid chat and rejects oversized or extra fields', () => {
		expect(validateClientMessage({ type: 'chat', content: ' hello ' })).toEqual(
			{
				ok: true,
				message: { type: 'chat', content: 'hello' }
			}
		);
		expect(
			validateClientMessage({
				type: 'chat',
				content: 'x'.repeat(MAX_CHAT_LENGTH + 1)
			})
		).toEqual(expect.objectContaining({ ok: false }));
		expect(
			validateClientMessage({ type: 'start', administrator: true })
		).toEqual(expect.objectContaining({ ok: false }));
	});

	test('accepts bounded movement and rejects non-finite components', () => {
		expect(
			validateClientMessage({ type: 'move', seq: 4, direction: [0, 1, -1] }).ok
		).toBe(true);
		expect(
			validateClientMessage({
				type: 'move',
				seq: 4,
				direction: [0, Infinity, 0]
			}).ok
		).toBe(false);
	});

	test('checks same-origin WebSocket upgrades', () => {
		const request = {
			headers: { origin: 'https://pong.example', host: 'pong.example' },
			socket: { encrypted: true }
		};
		expect(isAllowedWebSocketOrigin(request, new Set())).toBe(true);
		request.headers.origin = 'https://evil.example';
		expect(isAllowedWebSocketOrigin(request, new Set())).toBe(false);
	});

	test('safeSend tolerates a user disconnecting before an async notification', () => {
		const hub = { removeLobbyChannel() {} };
		const channel = new PongLobbySocket(hub, 'ABCDE');
		expect(channel.safeSendToUser('missing', { type: 'itemUnlocked' })).toBe(
			false
		);
	});

	test('rate-limits chat per user', async () => {
		const channel = new PongLobbySocket({ removeLobbyChannel() {} }, 'ABCDE');
		const socket = new FakeWebSocket();
		const handler = jest.fn();
		channel.addHandler('chat', handler);
		channel.attach(socket, { id: 42, display_name: 'player' });

		for (let i = 0; i < 6; i++) {
			socket.emit(
				'message',
				Buffer.from(JSON.stringify({ type: 'chat', content: `message ${i}` })),
				false
			);
		}
		await new Promise(setImmediate);

		expect(handler).toHaveBeenCalledTimes(5);
		expect(socket.sent).toContainEqual(
			expect.objectContaining({ type: 'error', code: 'RATE_LIMITED' })
		);

		const replacement = new FakeWebSocket();
		channel.attach(replacement, { id: 42, display_name: 'player renamed' });
		replacement.emit(
			'message',
			Buffer.from(JSON.stringify({ type: 'chat', content: 'after refresh' })),
			false
		);
		await new Promise(setImmediate);
		expect(handler).toHaveBeenCalledTimes(5);
		expect(replacement.sent).toContainEqual(
			expect.objectContaining({ type: 'error', code: 'RATE_LIMITED' })
		);
		channel.stop();
	});

	test('turns handler exceptions into protocol errors', async () => {
		const channel = new PongLobbySocket({ removeLobbyChannel() {} }, 'ABCDE');
		const socket = new FakeWebSocket();
		const error = jest.spyOn(console, 'error').mockImplementation(() => {});
		try {
			channel.addHandler('start', () => {
				throw new Error('boom');
			});
			channel.attach(socket, { id: 42, display_name: 'player' });
			socket.emit(
				'message',
				Buffer.from(JSON.stringify({ type: 'start' })),
				false
			);
			await new Promise(setImmediate);

			expect(socket.sent).toContainEqual(
				expect.objectContaining({ type: 'error', code: 'HANDLER_FAILED' })
			);
		} finally {
			error.mockRestore();
			channel.stop();
		}
	});
});
