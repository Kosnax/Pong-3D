import { Player } from './GameState.js';

describe('Player cosmetics', () => {
	test('keeps the equipped style keys sent by the server', () => {
		const paddle = {};
		const player = new Player('42', 'player', paddle, 1200, 2, 1, 7);

		expect(player.ballSkinKey).toBe(2);
		expect(player.paddleSkinKey).toBe(1);
		expect(player.goalExplosionKey).toBe(7);
		expect(player.paddle).toBe(paddle);
	});

	test('defaults every cosmetic to style zero', () => {
		const player = new Player('42', 'player', {});

		expect(player.ballSkinKey).toBe(0);
		expect(player.paddleSkinKey).toBe(0);
		expect(player.goalExplosionKey).toBe(0);
	});
});
