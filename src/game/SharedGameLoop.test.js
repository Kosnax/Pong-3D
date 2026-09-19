import { jest } from '@jest/globals';
import SharedGameLoop from './SharedGameLoop.js';

describe('SharedGameLoop', () => {
	test('uses one timer for every active scene and stops it when idle', () => {
		jest.useFakeTimers();
		const intervalSpy = jest.spyOn(globalThis, 'setInterval');
		const clearSpy = jest.spyOn(globalThis, 'clearInterval');
		const loop = new SharedGameLoop();
		const first = { advanceTick: jest.fn() };
		const second = { advanceTick: jest.fn() };

		try {
			loop.add(first);
			loop.add(second);
			expect(loop.activeSceneCount).toBe(2);
			expect(intervalSpy).toHaveBeenCalledTimes(1);

			loop.remove(first);
			expect(clearSpy).not.toHaveBeenCalled();
			loop.remove(second);
			expect(loop.activeSceneCount).toBe(0);
			expect(clearSpy).toHaveBeenCalledTimes(1);
		} finally {
			loop.stop();
			intervalSpy.mockRestore();
			clearSpy.mockRestore();
			jest.useRealTimers();
		}
	});

	test('isolates a broken lobby without stopping other simulations', () => {
		jest.useFakeTimers();
		const error = jest.spyOn(console, 'error').mockImplementation(() => {});
		const loop = new SharedGameLoop();
		const broken = {
			advanceTick: jest.fn(() => {
				throw new Error('bad lobby');
			})
		};
		const healthy = { advanceTick: jest.fn() };

		try {
			loop.add(broken);
			loop.add(healthy);
			jest.advanceTimersByTime(20);

			expect(broken.advanceTick).toHaveBeenCalled();
			expect(healthy.advanceTick).toHaveBeenCalled();
			expect(loop.activeSceneCount).toBe(1);
		} finally {
			loop.stop();
			error.mockRestore();
			jest.useRealTimers();
		}
	});
});
