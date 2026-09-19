import { PaddleController } from './PaddleController.js';

describe('PaddleController', () => {
	test('keeps the latest direction until a newer input arrives', () => {
		const controller = new PaddleController();

		expect(controller.ack).toBe(-1);
		expect([...controller.getDirection()]).toEqual([0, 0, 0]);
		expect(controller.ack).toBe(-1);

		controller.enqueueInput({ seq: 4, direction: [1, 0, -1] });
		expect([...controller.getDirection()]).toEqual([1, 0, -1]);
		expect(controller.ack).toBe(4);

		// A network gap must not turn movement into a zero vector.
		expect([...controller.getDirection()]).toEqual([1, 0, -1]);

		controller.enqueueInput({ seq: 3, direction: [-1, 0, 0] });
		expect([...controller.getDirection()]).toEqual([1, 0, -1]);
	});
});
