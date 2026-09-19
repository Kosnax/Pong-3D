import { RollbackBuffer } from './RollbackBuffer.js';

describe('RollbackBuffer', () => {
	test('retains only the newest states and can truncate replayed history', () => {
		const history = new RollbackBuffer(3);
		history.set(1, 'one');
		history.set(2, 'two');
		history.set(3, 'three');
		history.set(4, 'four');

		expect(history.oldestTick).toBe(2);
		expect(history.get(1)).toBeUndefined();

		history.deleteFrom(3);
		expect(history.get(2)).toBe('two');
		expect(history.get(3)).toBeUndefined();
		expect(history.get(4)).toBeUndefined();
	});
});
