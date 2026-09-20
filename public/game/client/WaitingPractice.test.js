import { jest } from '@jest/globals';
import { Vec3 } from '../../physics/math.js';
import { PracticeAIController } from '../ai.js';
import { WaitingPractice } from './WaitingPractice.js';

function makePaddle(key, x) {
	return {
		key,
		body: {
			x: new Vec3(x, 0, 0),
			v: new Vec3()
		},
		controller: null,
		setSkinStyle: jest.fn()
	};
}

function makeHarness() {
	const paddle1 = makePaddle('paddle1', -11);
	const paddle2 = makePaddle('paddle2', 11);
	const originalCollision = jest.fn();
	const ball = {
		enabled: false,
		body: {
			x: new Vec3(),
			v: new Vec3(),
			isTrigger: false,
			col: { onCollisionCallback: originalCollision }
		},
		setServerSkin: jest.fn(),
		triggerGoalExplosion: jest.fn()
	};
	const localPlayer = {
		userId: 'user-1',
		username: 'Player One',
		ballSkinKey: 4,
		goalExplosionKey: 7,
		paddle: paddle1
	};
	const objects = new Map([
		['ball', ball],
		['paddle1', paddle1],
		['paddle2', paddle2]
	]);
	const scene = {
		userId: 'user-1',
		matchStarted: false,
		gameOver: null,
		state: { players: new Map([['user-1', localPlayer]]) },
		audio: { playGoal: jest.fn() },
		getGameObject: (key) => objects.get(key)
	};

	return {
		ball,
		localPlayer,
		originalCollision,
		paddle1,
		paddle2,
		scene
	};
}

describe('WaitingPractice', () => {
	test('starts client-only practice for a lone player and stops when another joins', () => {
		const harness = makeHarness();
		const practice = new WaitingPractice(harness.scene);

		practice.update();

		expect(practice.active).toBe(true);
		expect(practice.scoreText).toBe('Player One 3 — 3 Pong Bot');
		expect(harness.ball.enabled).toBe(true);
		expect(harness.ball.body.v.x).toBeGreaterThan(0);
		expect(harness.paddle2.controller).toBeInstanceOf(PracticeAIController);
		expect(harness.ball.setServerSkin).toHaveBeenCalledWith(4);

		harness.ball.body.col.onCollisionCallback(harness.ball.body, {
			ballIdentifier: 'greenWall'
		});
		expect(harness.originalCollision).toHaveBeenCalled();
		expect(practice.scoreText).toBe('Player One 2 — 3 Pong Bot');
		expect(harness.ball.enabled).toBe(false);

		harness.scene.state.players.set('user-2', {
			userId: 'user-2',
			username: 'Player Two',
			paddle: harness.paddle2
		});
		practice.update();

		expect(practice.active).toBe(false);
		expect(harness.paddle2.controller).toBeNull();
		expect(harness.ball.body.col.onCollisionCallback).toBe(
			harness.originalCollision
		);
	});

	test('AI tracks an approaching ball from either side of the arena', () => {
		const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
		const ball = { body: { x: new Vec3(0, 2, 0), v: new Vec3(-5, 0, 0) } };
		const left = makePaddle('left', -11);
		const right = makePaddle('right', 11);

		expect(
			new PracticeAIController(left, ball).getDirection().y
		).toBeGreaterThan(0);
		ball.body.v.x = 5;
		expect(
			new PracticeAIController(right, ball).getDirection().y
		).toBeGreaterThan(0);

		random.mockRestore();
	});
});
