import EventEmitter from 'node:events';
import { jest } from '@jest/globals';

const profiles = {
	101: {
		elo: 1100,
		paddle_skin_key: 1,
		ball_skin_key: 2,
		goal_explosion_key: 4
	},
	102: {
		elo: 1200,
		paddle_skin_key: 2,
		ball_skin_key: 1,
		goal_explosion_key: 7
	}
};

jest.unstable_mockModule('../db/db.js', () => ({
	default: {
		get: jest.fn((sql, params, callback) => {
			if (sql.includes('SELECT i.id')) return callback(null, null);
			callback(null, profiles[params[0]]);
		}),
		run: jest.fn((_sql, params, callback) => {
			if (typeof params === 'function') params(null);
			else callback?.(null);
		})
	}
}));

let ServerScene;
let FORFEIT_RESULT_DISPLAY_MS;
let MAX_ROLLBACK_TICKS;
let RECONNECT_GRACE_MS;
let getRollbackTicks;

beforeAll(async () => {
	({
		default: ServerScene,
		FORFEIT_RESULT_DISPLAY_MS,
		MAX_ROLLBACK_TICKS,
		RECONNECT_GRACE_MS,
		getRollbackTicks
	} = await import('./ServerScene.js'));
});

class FakeSocket extends EventEmitter {
	constructor() {
		super();
		this.clients = new Map();
		this.handlers = new Map();
		this.sent = [];
		this.broadcasts = [];
		this.rttByUsername = new Map();
	}

	connect(userId, displayName) {
		const ws = { userId, username: displayName };
		this.clients.set(userId, ws);
		this.emit('client:connect', userId, { userId, displayName });
	}

	disconnect(userId) {
		const ws = this.clients.get(userId);
		if (!ws) return;
		this.clients.delete(userId);
		this.emit('client:disconnect', userId, {
			userId,
			displayName: ws.username
		});
	}

	addHandler(type, handler) {
		this.handlers.set(type, handler);
	}

	receive(userId, type, message = {}) {
		const ws = this.clients.get(userId);
		return this.handlers.get(type)?.(this, userId, ws, {
			type,
			...message
		});
	}

	forEachClient(callback) {
		for (const [userId, ws] of this.clients) callback(userId, ws);
	}

	safeSend(ws, message) {
		if (!ws) return false;
		this.sent.push({ username: ws.username, message });
		return true;
	}

	safeSendToUser(userId, message) {
		return this.safeSend(this.clients.get(userId), message);
	}

	broadcast(message) {
		this.broadcasts.push(message);
	}

	getRttMs(userId) {
		return this.rttByUsername.get(userId) ?? null;
	}

	isConnected(userId) {
		return this.clients.has(userId);
	}
}

async function connectPlayers(sceneSocket) {
	sceneSocket.connect('101', 'playerA');
	await new Promise(setImmediate);
	sceneSocket.connect('102', 'playerB');
	await new Promise(setImmediate);
	sceneSocket.receive('101', 'ready', { ready: true });
	sceneSocket.receive('102', 'ready', { ready: true });
}

describe('ServerScene online lifecycle', () => {
	test('requires both connected players to be ready before the host starts', async () => {
		const socket = new FakeSocket();
		const scene = new ServerScene(socket, 7, null, { hostUserId: '101' });
		try {
			socket.connect('101', 'playerA');
			socket.connect('102', 'playerB');
			await new Promise(setImmediate);
			socket.receive('101', 'move', { seq: 50, direction: [0, 1, 0] });

			expect(socket.receive('101', 'start')).toEqual({
				type: 'error',
				message: 'Both players must be connected and ready'
			});
			socket.receive('101', 'ready', { ready: true });
			socket.receive('102', 'ready', { ready: true });
			expect(socket.receive('101', 'start')).toBeUndefined();
			expect(scene.inProgress).toBe(true);
			scene.stop();
			socket.receive('101', 'move', { seq: 0, direction: [0, -1, 0] });
			scene.advanceTick();
			expect(scene.state.players.get('101').paddle.controller.ack).toBe(0);
		} finally {
			scene.stop();
		}
	});

	test('pauses during the reconnect grace period and resumes the same player', async () => {
		const socket = new FakeSocket();
		const scene = new ServerScene(socket, 7, null, { hostUserId: '101' });
		try {
			await connectPlayers(socket);
			socket.receive('101', 'start');
			scene.stop();

			const tickBeforeDisconnect = scene.serverTick;
			socket.disconnect('102');
			scene.advanceTick();

			expect(scene.inProgress).toBe(true);
			expect(scene.serverTick).toBe(tickBeforeDisconnect);
			expect(socket.broadcasts).toContainEqual(
				expect.objectContaining({
					type: 'reconnectStatus',
					userId: '102'
				})
			);
			expect(
				socket.broadcasts.some((message) => message.type === 'gameOver')
			).toBe(false);

			socket.connect('102', 'playerB renamed');
			socket.receive('102', 'move', {
				seq: 0,
				direction: [0, 1, 0]
			});
			scene.advanceTick();
			expect(scene.serverTick).toBe(tickBeforeDisconnect + 1);
			expect(scene.state.players.get('102').username).toBe('playerB renamed');
			expect(scene.state.players.get('102').paddle.controller.ack).toBe(0);
			expect(socket.broadcasts).toContainEqual({
				type: 'playerReconnected',
				userId: '102'
			});
		} finally {
			scene.stop();
		}
	});

	test('forfeits after grace and reopens the player slot', async () => {
		const socket = new FakeSocket();
		const scene = new ServerScene(socket, 7, null, { hostUserId: '101' });
		try {
			await connectPlayers(socket);
			socket.receive('101', 'start');
			scene.stop();
			jest.useFakeTimers();

			socket.disconnect('102');
			jest.advanceTimersByTime(RECONNECT_GRACE_MS - 1);
			expect(scene.inProgress).toBe(true);

			jest.advanceTimersByTime(1);
			expect(scene.status).toBe('finished');
			for (let i = 0; i < 12; i++) await Promise.resolve();
			expect(socket.broadcasts).toContainEqual(
				expect.objectContaining({ type: 'gameOver', loserId: '102' })
			);

			jest.advanceTimersByTime(FORFEIT_RESULT_DISPLAY_MS);
			expect(scene.hasPlayer('102')).toBe(false);
			expect(scene.status).toBe('waiting');
		} finally {
			jest.useRealTimers();
			scene.stop();
		}
	});
});

describe('ServerScene cosmetics', () => {
	test('includes every player paddle skin in playerSync', async () => {
		const socket = new FakeSocket();
		new ServerScene(socket);
		await connectPlayers(socket);

		const latestSync = socket.sent
			.filter(
				(entry) =>
					entry.username === 'playerA' && entry.message.type === 'playerSync'
			)
			.at(-1).message;

		expect(latestSync.players).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					username: 'playerA',
					paddleSkinKey: 1
				}),
				expect.objectContaining({
					username: 'playerB',
					paddleSkinKey: 2
				})
			])
		);
	});

	test("defers and then broadcasts the scorer's goal explosion once", async () => {
		const socket = new FakeSocket();
		const scene = new ServerScene(socket);
		await connectPlayers(socket);

		const ball = scene.getGameObject('ball');
		const scoredOnWall = scene.getGameObject('gameArena').bodies[4];
		ball.body.x.assign(-13, 1, 2);
		ball.body.col.onCollisionCallback(ball.body, scoredOnWall);

		expect(scene.goalPending).toBe(true);
		expect(socket.broadcasts).toHaveLength(0);
		expect(scene.state.players.get('101').lives).toBe(7);

		for (let i = 0; i < MAX_ROLLBACK_TICKS + 1; i++) scene.advanceTick();
		expect(socket.broadcasts).toHaveLength(0);
		expect(scene.state.players.get('101').lives).toBe(7);
		scene.advanceTick();

		expect(socket.broadcasts.at(-1)).toEqual({
			type: 'goalScored',
			scorer: 'playerB',
			goalExplosionKey: 7,
			position: [-13, 1, 2]
		});
		expect(
			socket.broadcasts.filter((message) => message.type === 'goalScored')
		).toHaveLength(1);
		expect(scene.state.players.get('101').lives).toBe(6);
		expect(scene.goalPending).toBe(false);
	});

	test('includes rollback timing and pending-goal state in sync messages', async () => {
		const socket = new FakeSocket();
		const scene = new ServerScene(socket);
		await connectPlayers(socket);

		const ball = scene.getGameObject('ball');
		const scoredOnWall = scene.getGameObject('gameArena').bodies[4];
		ball.body.col.onCollisionCallback(ball.body, scoredOnWall);
		for (let i = 0; i < 5; i++) scene.advanceTick();

		const sync = socket.sent
			.filter((entry) => entry.message.type === 'sync')
			.at(-1).message;
		expect(sync.serverTick).toBe(5);
		expect(sync.goalPending).toBe(true);
	});

	test('includes authoritative final lives in the game-over event', async () => {
		const now = jest.spyOn(Date, 'now').mockReturnValue(30_000);
		const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
		let scene;
		try {
			const socket = new FakeSocket();
			scene = new ServerScene(socket, 1);
			await connectPlayers(socket);
			socket.receive('101', 'start');

			now.mockReturnValue(33_001);
			scene.advanceTick();
			const ball = scene.getGameObject('ball');
			const playerAWall = scene.getGameObject('gameArena').bodies[4];
			ball.body.col.onCollisionCallback(ball.body, playerAWall);
			for (let i = 0; i < MAX_ROLLBACK_TICKS + 2; i++) scene.advanceTick();
			await new Promise(setImmediate);

			const gameOver = socket.broadcasts.find(
				(message) => message.type === 'gameOver'
			);
			expect(gameOver).toEqual(
				expect.objectContaining({
					winner: 'playerB',
					loser: 'playerA',
					winnerId: '102',
					finalLives: { 101: 0, 102: 1 }
				})
			);

			socket.receive('101', 'rematch', { ready: true });
			expect(scene.inProgress).toBe(false);
			socket.receive('102', 'rematch', { ready: true });
			expect(scene.inProgress).toBe(true);
			expect(socket.broadcasts).toContainEqual({ type: 'matchReset' });
			expect(scene.state.players.get('101').lives).toBe(1);
			expect(scene.state.players.get('102').lives).toBe(1);
		} finally {
			scene?.stop();
			warning.mockRestore();
			now.mockRestore();
		}
	});
});

describe('ServerScene rollback', () => {
	test.each([
		[null, 0],
		[0, 0],
		[100, 6],
		[200, 12],
		[300, 18],
		[1000, 18]
	])('maps %p ms RTT to %i bounded rollback ticks', (rttMs, ticks) => {
		expect(getRollbackTicks(rttMs)).toBe(ticks);
	});

	test('applies input at the current tick until an RTT sample exists', async () => {
		const now = jest.spyOn(Date, 'now').mockReturnValue(5_000);
		try {
			const socket = new FakeSocket();
			const scene = new ServerScene(socket);
			await connectPlayers(socket);
			socket.receive('101', 'start');
			now.mockReturnValue(8_001);
			scene.advanceTick();

			socket.receive('101', 'move', {
				seq: 1,
				direction: [0, 1, 0]
			});
			scene.advanceTick();

			expect(scene.rollbackStats.rollbacks).toBe(0);
			expect(scene.state.players.get('101').paddle.controller.ack).toBe(1);
		} finally {
			now.mockRestore();
		}
	});

	test('rewinds a delayed defensive input and replaces a pending goal with a bounce', async () => {
		const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
		try {
			const socket = new FakeSocket();
			const scene = new ServerScene(socket);
			await connectPlayers(socket);
			socket.receive('101', 'start');

			// Finish the initial serve countdown without waiting in real time.
			now.mockReturnValue(13_001);
			scene.advanceTick();

			const ball = scene.getGameObject('ball');
			const paddle = scene.state.players.get('101').paddle;
			paddle.body.x.assign(-23.5 / 2.125, 0, 0);
			paddle.body.v.zero();
			ball.body.x.assign(-8.9338, 2.1, 0);
			ball.body.v.assign(-15, 0, 0);
			ball.speed = 15;
			ball.body.isTrigger = false;

			// Advance once so this configured state becomes a rollback baseline.
			scene.advanceTick();
			const inputTick = scene.serverTick;
			for (let i = 0; i < MAX_ROLLBACK_TICKS; i++) scene.advanceTick();

			expect(scene.goalPending).toBe(true);
			socket.rttByUsername.set('101', 300);
			socket.receive('101', 'move', {
				seq: 1,
				direction: [0, 1, 0]
			});
			scene.advanceTick();

			expect(scene.rollbackStats.rollbacks).toBe(1);
			expect(scene.rollbackStats.maxRewindTicks).toBe(MAX_ROLLBACK_TICKS);
			expect(scene.rollbackStats.invalidatedGoals).toBe(1);
			expect(scene.goalPending).toBe(false);
			// This is a glancing corner save: the collision sharply deflects the
			// incoming ball instead of allowing it to continue into the goal.
			expect(ball.body.v.x).toBeGreaterThan(-5);
			expect(Math.abs(ball.body.v.y)).toBeGreaterThan(1);
			expect(scene.serverTick).toBe(inputTick + MAX_ROLLBACK_TICKS + 1);
			expect(
				socket.broadcasts.filter((message) => message.type === 'goalScored')
			).toHaveLength(0);
		} finally {
			now.mockRestore();
		}
	});

	test('caps excessive latency and skips replay for unchanged input state', async () => {
		const now = jest.spyOn(Date, 'now').mockReturnValue(20_000);
		try {
			const socket = new FakeSocket();
			const scene = new ServerScene(socket);
			await connectPlayers(socket);
			socket.receive('101', 'start');
			now.mockReturnValue(23_001);
			scene.advanceTick();
			for (let i = 0; i < MAX_ROLLBACK_TICKS; i++) scene.advanceTick();

			socket.rttByUsername.set('101', 1000);
			socket.receive('101', 'move', {
				seq: 1,
				direction: [0, 1, 0]
			});
			scene.advanceTick();
			const rollbackCount = scene.rollbackStats.rollbacks;

			socket.receive('101', 'move', {
				seq: 2,
				direction: [0, 1, 0]
			});
			scene.advanceTick();

			expect(scene.rollbackStats.cappedLatencyInputs).toBe(2);
			expect(scene.rollbackStats.maxRewindTicks).toBeLessThanOrEqual(
				MAX_ROLLBACK_TICKS
			);
			expect(scene.rollbackStats.rollbacks).toBe(rollbackCount);
		} finally {
			now.mockRestore();
		}
	});
});
