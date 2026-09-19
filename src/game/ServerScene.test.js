import EventEmitter from 'node:events';
import { jest } from '@jest/globals';

const profiles = {
	playerA: {
		elo: 1100,
		paddle_skin_key: 1,
		ball_skin_key: 2,
		goal_explosion_key: 4
	},
	playerB: {
		elo: 1200,
		paddle_skin_key: 2,
		ball_skin_key: 1,
		goal_explosion_key: 7
	}
};

jest.unstable_mockModule('../db/db.js', () => ({
	default: {
		get: jest.fn((_sql, params, callback) => {
			callback(null, profiles[params[0]]);
		})
	}
}));

let ServerScene;
let MAX_ROLLBACK_TICKS;
let getRollbackTicks;

beforeAll(async () => {
	({
		default: ServerScene,
		MAX_ROLLBACK_TICKS,
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

	connect(username) {
		const ws = { username };
		this.clients.set(username, ws);
		this.emit('client:connect', username);
	}

	addHandler(type, handler) {
		this.handlers.set(type, handler);
	}

	receive(username, type, message = {}) {
		const ws = this.clients.get(username);
		return this.handlers.get(type)?.(this, username, ws, {
			type,
			...message
		});
	}

	forEachClient(callback) {
		for (const [username, ws] of this.clients) callback(username, ws);
	}

	safeSend(ws, message) {
		this.sent.push({ username: ws.username, message });
	}

	broadcast(message) {
		this.broadcasts.push(message);
	}

	getRttMs(username) {
		return this.rttByUsername.get(username) ?? null;
	}
}

async function connectPlayers(sceneSocket) {
	sceneSocket.connect('playerA');
	await new Promise(setImmediate);
	sceneSocket.connect('playerB');
	await new Promise(setImmediate);
}

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
		expect(scene.state.players.get('playerA').lives).toBe(7);

		for (let i = 0; i < MAX_ROLLBACK_TICKS + 1; i++) scene.advanceTick();
		expect(socket.broadcasts).toHaveLength(0);
		expect(scene.state.players.get('playerA').lives).toBe(7);
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
		expect(scene.state.players.get('playerA').lives).toBe(6);
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
			socket.receive('playerA', 'start');
			now.mockReturnValue(8_001);
			scene.advanceTick();

			socket.receive('playerA', 'move', {
				seq: 1,
				direction: [0, 1, 0]
			});
			scene.advanceTick();

			expect(scene.rollbackStats.rollbacks).toBe(0);
			expect(scene.state.players.get('playerA').paddle.controller.ack).toBe(1);
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
			socket.receive('playerA', 'start');

			// Finish the initial serve countdown without waiting in real time.
			now.mockReturnValue(13_001);
			scene.advanceTick();

			const ball = scene.getGameObject('ball');
			const paddle = scene.state.players.get('playerA').paddle;
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
			socket.rttByUsername.set('playerA', 300);
			socket.receive('playerA', 'move', {
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
			socket.receive('playerA', 'start');
			now.mockReturnValue(23_001);
			scene.advanceTick();
			for (let i = 0; i < MAX_ROLLBACK_TICKS; i++) scene.advanceTick();

			socket.rttByUsername.set('playerA', 1000);
			socket.receive('playerA', 'move', {
				seq: 1,
				direction: [0, 1, 0]
			});
			scene.advanceTick();
			const rollbackCount = scene.rollbackStats.rollbacks;

			socket.receive('playerA', 'move', {
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
