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

beforeAll(async () => {
	({ default: ServerScene } = await import('./ServerScene.js'));
});

class FakeSocket extends EventEmitter {
	constructor() {
		super();
		this.clients = new Map();
		this.handlers = new Map();
		this.sent = [];
		this.broadcasts = [];
	}

	connect(username) {
		const ws = { username };
		this.clients.set(username, ws);
		this.emit('client:connect', username);
	}

	addHandler(type, handler) {
		this.handlers.set(type, handler);
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

	test("broadcasts the scorer's goal explosion", async () => {
		const socket = new FakeSocket();
		const scene = new ServerScene(socket);
		await connectPlayers(socket);

		const ball = scene.getGameObject('ball');
		const scoredOnWall = scene.getGameObject('gameArena').bodies[4];
		ball.body.x.assign(-13, 1, 2);
		ball.body.col.onCollisionCallback(ball.body, scoredOnWall);

		expect(socket.broadcasts.at(-1)).toEqual({
			type: 'goalScored',
			scorer: 'playerB',
			goalExplosionKey: 7,
			position: [-13, 1, 2]
		});
	});
});
