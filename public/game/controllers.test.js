import { jest } from '@jest/globals';
import { KeyboardController } from './controllers.js';

beforeEach(() => {
	globalThis.window = {
		addEventListener: jest.fn(),
		removeEventListener: jest.fn()
	};
	globalThis.document = {
		activeElement: { tagName: 'BODY' }
	};
});

afterEach(() => {
	delete globalThis.window;
	delete globalThis.document;
});

describe('KeyboardController prediction samples', () => {
	test('uses a unique sequence for every simulated input and caps the backlog', () => {
		const controller = new KeyboardController({ send: jest.fn() });

		for (let i = 0; i < 242; i++) controller.getDirection();

		const sequences = controller.inputBuffer.map((input) => input.seq);
		expect(sequences).toHaveLength(240);
		expect(sequences[0]).toBe(2);
		expect(sequences.at(-1)).toBe(241);
		expect(new Set(sequences).size).toBe(sequences.length);

		controller.destroy();
	});
});
