import { PaddleController } from './PaddleController.js';

describe('PaddleController', () => {
	test('keeps the latest direction until a newer input arrives', () => {
		const controller = new PaddleController();

		expect(controller.ack).toBe(-1);
		expect([...controller.getDirection()]).toEqual([0, 0, 0]);
		expect(controller.ack).toBe(-1);

		controller.enqueueInput({ seq: 4, direction: [1, 0, -1] });
		expect(controller.getDirection().norm()).toBeCloseTo(1);
		expect(controller.getDirection().x).toBeGreaterThan(0);
		expect(controller.getDirection().z).toBeLessThan(0);
		expect(controller.ack).toBe(4);

		// A network gap must not turn movement into a zero vector.
		expect(controller.getDirection().norm()).toBeCloseTo(1);

		controller.enqueueInput({ seq: 3, direction: [-1, 0, 0] });
		expect(controller.getDirection().x).toBeGreaterThan(0);
		expect(controller.getDirection().z).toBeLessThan(0);
	});

	test('replays tick-indexed input and retains a pruned baseline', () => {
		const controller = new PaddleController();

		controller.enqueueInput({ seq: 1, direction: [0, 1, 0] }, 4);
		controller.enqueueInput({ seq: 2, direction: [0, -1, 0] }, 8);

		expect([...controller.getDirectionAtTick(3)]).toEqual([0, 0, 0]);
		expect([...controller.getDirectionAtTick(6)]).toEqual([0, 1, 0]);
		expect([...controller.getDirectionAtTick(8)]).toEqual([0, -1, 0]);

		controller.pruneBefore(6);
		expect([...controller.getDirectionAtTick(6)]).toEqual([0, 1, 0]);
		expect([...controller.getDirectionAtTick(9)]).toEqual([0, -1, 0]);
	});

	test('does not acknowledge a reserved input until it is inserted', () => {
		const controller = new PaddleController();
		const input = controller.acceptInput({ seq: 5, direction: [0, 1, 0] });

		expect(controller.ack).toBe(-1);
		expect(controller.insertInput(input, 10)).toBe(true);
		expect(controller.ack).toBe(5);
		expect(
			controller.insertInput({ seq: 6, direction: input.direction }, 11)
		).toBe(false);
	});
});
