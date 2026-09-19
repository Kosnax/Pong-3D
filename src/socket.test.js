import { smoothRtt } from './socket.js';

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
