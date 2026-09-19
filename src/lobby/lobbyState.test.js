import EventEmitter from 'node:events';
import { jest } from '@jest/globals';

jest.unstable_mockModule('../db/db.js', () => ({
	default: {
		get: jest.fn((_sql, _params, callback) => callback(null, { elo: 1000 }))
	}
}));

let LobbyState;

beforeAll(async () => {
	({ default: LobbyState } = await import('./lobbyState.js'));
});

class FakeLobbyChannel extends EventEmitter {
	constructor() {
		super();
		this.clients = new Map();
		this.handlers = new Map();
	}

	addHandler(type, handler) {
		this.handlers.set(type, handler);
	}

	connect(userId, displayName) {
		const normalizedUserId = String(userId);
		const profile = { userId: normalizedUserId, displayName };
		this.clients.set(normalizedUserId, {});
		this.emit('client:connect', normalizedUserId, profile, {
			reconnecting: false
		});
	}

	forEachClient(callback) {
		for (const entry of this.clients) callback(...entry);
	}

	isConnected(userId) {
		return this.clients.has(String(userId));
	}

	safeSend() {
		return true;
	}

	safeSendToUser() {
		return true;
	}

	broadcast() {}

	disconnectUser() {}

	stop() {}
}

class FakeSocketHub {
	constructor() {
		this.channels = [];
	}

	createLobbyChannel() {
		const channel = new FakeLobbyChannel();
		this.channels.push(channel);
		return channel;
	}
}

describe('LobbyState matchmaking', () => {
	test('reserves only real player slots and excludes full public lobbies', async () => {
		const hub = new FakeSocketHub();
		const state = new LobbyState({}, () => {}, hub);
		const lobby = state.createLobby('Public game', true, 7, {
			id: 1,
			display_name: 'host'
		});

		expect(state.findJoinableLobby(2)).toBe(lobby);
		expect(state.findJoinableLobby(2)).toBe(lobby);
		expect(state.findJoinableLobby(3)).toBeNull();
		expect(state.serializeLobby(lobby)).toEqual(
			expect.objectContaining({
				status: 'waiting',
				playerCount: 0,
				joinableAsPlayer: false
			})
		);

		hub.channels[0].connect(1, 'host');
		hub.channels[0].connect(2, 'guest');
		await new Promise(setImmediate);

		expect(state.serializeLobby(lobby)).toEqual(
			expect.objectContaining({
				playerCount: 2,
				memberCount: 2,
				joinableAsPlayer: false
			})
		);
		expect(state.findJoinableLobby(3)).toBeNull();
	});

	test('never sends matchmaking users to private lobbies', () => {
		const state = new LobbyState({}, () => {}, new FakeSocketHub());
		state.createLobby('Private game', false, 7, {
			id: 1,
			display_name: 'host'
		});

		expect(state.findJoinableLobby(2)).toBeNull();
		expect(state.listLobbies()).toEqual([]);
	});

	test('transfers an abandoned reserved host slot to a connected player', async () => {
		const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
		try {
			const hub = new FakeSocketHub();
			const state = new LobbyState({}, () => {}, hub);
			const lobby = state.createLobby('Public game', true, 7, {
				id: 1,
				display_name: 'missing host'
			});
			expect(state.findJoinableLobby(2)).toBe(lobby);
			hub.channels[0].connect(2, 'guest');
			await new Promise(setImmediate);

			now.mockReturnValue(21_001);
			expect(state.findJoinableLobby(3)).toBe(lobby);
			expect(state.serializeLobby(lobby).hostUserId).toBe('2');
		} finally {
			now.mockRestore();
		}
	});
});
